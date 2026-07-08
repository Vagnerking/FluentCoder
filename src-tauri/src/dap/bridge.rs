//! Local WebSocket bridge between the frontend DAP client and a debug-adapter
//! process (netcoredbg `--interpreter=vscode`).
//!
//! DAP uses the SAME `Content-Length` framing as LSP, so this reuses
//! `lsp::codec` and `lsp::process::LspProcess` verbatim. It is a lean copy of
//! `lsp::bridge` without the per-message LSP log previews — a debug session
//! streams high-frequency `output`/`stopped` events that would flood stderr.
//! Security posture is identical: loopback-only ephemeral port, single
//! connection, per-session UUID token checked at the WS handshake.

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

/// A running bridge; dropping/shutting it down kills the adapter process.
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

/// Starts the bridge for an already-spawned debug adapter.
pub async fn start_bridge(process: LspProcess) -> std::io::Result<BridgeHandle> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let token = Uuid::new_v4().to_string();

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    // Don't hand the port back before the accept loop is live (connect race).
    let (ready_tx, ready_rx) = oneshot::channel::<()>();
    let task_token = token.clone();

    eprintln!("[dap:bridge] listening on 127.0.0.1:{port}");

    tokio::spawn(async move {
        let _ = ready_tx.send(());
        let mut shutdown_rx = shutdown_rx;
        let stream = tokio::select! {
            _ = &mut shutdown_rx => {
                process.kill().await;
                return;
            }
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                Err(e) => {
                    eprintln!("[dap:bridge] accept error: {e}");
                    process.kill().await;
                    return;
                }
            }
        };
        if let Err(e) = serve_connection(stream, &task_token, process, shutdown_rx).await {
            eprintln!("[dap:bridge] connection error: {e}");
        }
    });

    let _ = ready_rx.await;
    Ok(BridgeHandle {
        port,
        token,
        shutdown: Some(shutdown_tx),
    })
}

#[allow(clippy::result_large_err)]
async fn serve_connection(
    stream: TcpStream,
    expected_token: &str,
    process: LspProcess,
    shutdown: oneshot::Receiver<()>,
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
            let err = Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(Some("invalid token".to_string()))
                .expect("failed to build rejection response");
            Err(err)
        }
    };

    let ws = match tokio_tungstenite::accept_hdr_async(stream, callback).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[dap:bridge] handshake rejected: {e}");
            process.kill().await;
            return Ok(());
        }
    };
    if !authorized {
        process.kill().await;
        return Ok(());
    }
    proxy(ws, process, shutdown).await;
    Ok(())
}

/// Bidirectional quiet proxy: WS text frame ↔ one Content-Length-framed DAP
/// message on the adapter's stdio.
async fn proxy(
    ws: tokio_tungstenite::WebSocketStream<TcpStream>,
    process: LspProcess,
    shutdown: oneshot::Receiver<()>,
) {
    let LspProcess {
        child,
        mut stdin,
        stdout: mut reader,
        ..
    } = process;
    let (mut ws_sink, mut ws_stream) = ws.split();

    let to_ws = async move {
        loop {
            match codec::read_message(&mut reader).await {
                Ok(Some(json)) => {
                    if ws_sink.send(Message::Text(json)).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[dap:bridge] stdout read error: {e}");
                    break;
                }
            }
        }
        let _ = ws_sink.close().await;
    };

    let to_stdin = async move {
        while let Some(msg) = ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
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
                _ => {}
            }
        }
    };

    let mut child = child;
    tokio::select! {
        _ = to_ws => {}
        _ = to_stdin => {}
        _ = shutdown => {}
    }
    eprintln!("[dap:bridge] session ended; killing adapter");
    let _ = child.start_kill();
    let _ = child.wait().await;
}
