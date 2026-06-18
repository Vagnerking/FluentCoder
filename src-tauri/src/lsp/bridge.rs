//! Local WebSocket bridge between the frontend `monaco-languageclient` and an
//! LSP server process.
//!
//! Listens on `127.0.0.1:0` (ephemeral port; never `0.0.0.0`), authenticates the
//! single accepted connection with a per-session token passed as the `token`
//! query parameter, then proxies JSON-RPC bidirectionally: WS text frames are
//! framed with `Content-Length` into the server's stdin, and framed messages
//! from the server's stdout are sent back as WS text frames.
//!
//! Isolating the transport here means a future switch away from a local socket
//! only touches this file.

use crate::lsp::codec;
use crate::lsp::process::LspProcess;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

/// Connection details the frontend needs to reach the bridge.
#[derive(Clone, serde::Serialize)]
pub struct BridgeInfo {
    pub port: u16,
    pub token: String,
}

/// A running bridge. Dropping/`shutdown`-ing it tears down the proxy and kills
/// the LSP process.
pub struct BridgeHandle {
    pub port: u16,
    pub token: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl BridgeHandle {
    pub fn info(&self) -> BridgeInfo {
        BridgeInfo {
            port: self.port,
            token: self.token.clone(),
        }
    }

    /// Signals the bridge task to stop accepting and to kill the LSP process.
    pub fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Starts the bridge for an already-spawned LSP process.
///
/// Binds an ephemeral port on loopback, generates a session token, and spawns a
/// task that accepts exactly one authenticated WS connection and proxies it.
pub async fn start_bridge(process: LspProcess) -> std::io::Result<BridgeHandle> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let token = Uuid::new_v4().to_string();

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    // Signals that the accept loop is actually running, so we don't return the
    // port/token to the frontend before the listener can accept — avoiding a
    // race where the WS client connects before `accept()` is reached.
    let (ready_tx, ready_rx) = oneshot::channel::<()>();
    let task_token = token.clone();

    eprintln!("[lsp:bridge] listening on 127.0.0.1:{port}");

    tokio::spawn(async move {
        // Reached the accept loop — unblock start_bridge's return.
        let _ = ready_tx.send(());
        tokio::select! {
            _ = shutdown_rx => {
                eprintln!("[lsp:bridge] shutdown before connection");
                process.kill().await;
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _addr)) => {
                        if let Err(e) = serve_connection(stream, &task_token, process).await {
                            eprintln!("[lsp:bridge] connection error: {e}");
                        }
                    }
                    Err(e) => {
                        eprintln!("[lsp:bridge] accept error: {e}");
                        process.kill().await;
                    }
                }
            }
        }
    });

    // Wait until the spawned task is in its accept loop before handing the
    // port/token back. If the task died before signaling, proceed anyway.
    let _ = ready_rx.await;

    Ok(BridgeHandle {
        port,
        token,
        shutdown: Some(shutdown_tx),
    })
}

/// Validates the token from the request URI's `token` query param and, on
/// success, upgrades to WebSocket and proxies the connection.
async fn serve_connection(
    stream: TcpStream,
    expected_token: &str,
    process: LspProcess,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut authorized = false;

    let callback = |req: &Request, response: Response| {
        let query = req.uri().query().unwrap_or("");
        let token_ok = query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .any(|(k, v)| k == "token" && v == expected_token);

        if token_ok {
            authorized = true;
            Ok(response)
        } else {
            // Reject the handshake; the client sees a 401. The error-response
            // body type is `Option<String>` as required by the `Callback` trait.
            let err = Response::builder()
                .status(StatusCode::UNAUTHORIZED) // 401
                .body(Some("invalid token".to_string()))
                .expect("failed to build rejection response");
            Err(err)
        }
    };

    let ws = match tokio_tungstenite::accept_hdr_async(stream, callback).await {
        Ok(ws) => ws,
        Err(e) => {
            // Handshake rejected (bad token) or failed; kill the orphaned server.
            eprintln!("[lsp:bridge] handshake rejected: {e}");
            process.kill().await;
            return Ok(());
        }
    };

    if !authorized {
        process.kill().await;
        return Ok(());
    }

    eprintln!("[lsp:bridge] connection authorized");
    proxy(ws, process).await;
    Ok(())
}

/// Bidirectional proxy: WS → stdin (frame each text message) and stdout → WS
/// (read each frame, send as text). Either side closing tears down the other and
/// kills the LSP process.
async fn proxy(ws: tokio_tungstenite::WebSocketStream<TcpStream>, process: LspProcess) {
    let LspProcess {
        child,
        mut stdin,
        stdout: mut reader,
        ..
    } = process;

    let (mut ws_sink, mut ws_stream) = ws.split();

    // stdout(server) -> ws(client)
    let to_ws = async move {
        loop {
            match codec::read_message(&mut reader).await {
                Ok(Some(json)) => {
                    // TEMP: log server→client. Full line for codeLens (to see the
                    // command), short preview otherwise.
                    if json.contains("tokenTypes") || json.contains("semanticTokensProvider") {
                        // Full dump of the semantic-tokens legend (in initialize result).
                        eprintln!("[lsp:srv→cli:LEGEND] {json}");
                    } else if json.contains("\"command\"") || json.contains("codeLens") {
                        let preview: String = json.chars().take(600).collect();
                        eprintln!("[lsp:srv→cli:FULL] {preview}");
                    } else {
                        let preview: String = json.chars().take(160).collect();
                        eprintln!("[lsp:srv→cli] {preview}");
                    }
                    if ws_sink.send(Message::Text(json)).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,  // server closed stdout
                Err(e) => {
                    eprintln!("[lsp:bridge] stdout read error: {e}");
                    break;
                }
            }
        }
        let _ = ws_sink.close().await;
    };

    // ws(client) -> stdin(server)
    let to_stdin = async move {
        while let Some(msg) = ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    // TEMP: log a short preview of every client→server message.
                    let preview: String = text.chars().take(160).collect();
                    eprintln!("[lsp:cli→srv] {preview}");
                    if codec::write_message(&mut stdin, &text).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Binary(bytes)) => {
                    if let Ok(text) = String::from_utf8(bytes) {
                        if codec::write_message(&mut stdin, &text).await.is_err() {
                            break;
                        }
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {} // ping/pong handled by the library
            }
        }
    };

    // Run both directions; when either completes, stop and reap the process.
    // Log which side closed first — this disambiguates "client (ws) hung up" from
    // "server (stdout) ended" when diagnosing disconnects.
    let mut child = child;
    tokio::select! {
        _ = to_ws => { eprintln!("[lsp:bridge] server stdout closed (to_ws ended)"); }
        _ = to_stdin => { eprintln!("[lsp:bridge] client ws closed (to_stdin ended)"); }
    }

    eprintln!("[lsp:bridge] connection ended; killing LSP process");
    let _ = child.start_kill();
    let _ = child.wait().await;
}
