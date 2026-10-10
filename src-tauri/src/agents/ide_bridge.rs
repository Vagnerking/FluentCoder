//! Ponte IDE do Claude Code: faz o CLI `claude` (modo interativo, ex.: rodando
//! no terminal integrado) tratar o Fluent Coder como a IDE dele, igual à
//! extensão oficial do VS Code.
//!
//! Protocolo (validado contra o CLI 2.1.296 — ver ADR 0006):
//! - servidor WebSocket em `127.0.0.1:<porta aleatória>`;
//! - lock file `~/.claude/ide/<porta>.lock` (0600) com `authToken`, pasta(s) do
//!   workspace e `ideName`; o CLI descobre a IDE por esse arquivo (ou pela env
//!   `CLAUDE_CODE_SSE_PORT` que o nosso terminal injeta);
//! - handshake exige o header `x-claude-code-ide-authorization: <token>` e
//!   recusa qualquer `Origin` (guarda contra CSRF de navegador);
//! - JSON-RPC 2.0/MCP em frames de texto: `initialize`, `tools/list`,
//!   `tools/call`; IDE → CLI só a notificação `selection_changed`.
//!
//! Estado do editor (pastas, seleção, abas, diagnósticos) é EMPURRADO pelo
//! frontend (`ide_bridge_update`) e as ferramentas de consulta respondem do
//! cache. Ferramentas que exigem ação na UI (`openDiff`, `openFile`,
//! `saveDocument`) viram o evento `ide-bridge://request` para a janela dona do
//! arquivo; a resposta volta por `ide_bridge_respond`. `openDiff` bloqueia até
//! o usuário decidir (sem timeout); as demais têm timeout curto.

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::Message;

/// Header de autenticação que o CLI envia no handshake.
const AUTH_HEADER: &str = "x-claude-code-ide-authorization";
const IDE_NAME: &str = "Fluent Coder";
/// Timeout das ferramentas de UI que não dependem de decisão do usuário.
const UI_TIMEOUT: Duration = Duration::from_secs(15);

pub const EVENT_REQUEST: &str = "ide-bridge://request";
pub const EVENT_DISMISS: &str = "ide-bridge://dismiss";
pub const EVENT_STATUS: &str = "ide-bridge://status";

// ---------------------------------------------------------------------------
// Estado do editor empurrado pelo frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionRange {
    pub start: Position,
    pub end: Position,
    pub is_empty: bool,
}

/// Seleção do editor ativo (linhas/colunas 0-based, como o LSP/VS Code).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSelection {
    pub text: String,
    pub file_path: String,
    pub selection: SelectionRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorTab {
    pub uri: String,
    pub path: String,
    pub is_active: bool,
    pub label: String,
    pub language_id: String,
    pub is_dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub message: String,
    /// `Error | Warning | Information | Hint`.
    pub severity: String,
    pub range: Range,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileDiagnostics {
    pub uri: String,
    pub diagnostics: Vec<Diagnostic>,
}

/// Atualização parcial do estado de uma janela: campo ausente = mantém.
/// `selection: null` explícito = sem editor de texto ativo.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPatch {
    #[serde(default)]
    pub workspace_folders: Option<Vec<String>>,
    #[serde(default)]
    pub focused: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub selection: Option<Option<EditorSelection>>,
    #[serde(default)]
    pub open_editors: Option<Vec<EditorTab>>,
    #[serde(default)]
    pub diagnostics: Option<Vec<FileDiagnostics>>,
}

fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

#[derive(Debug, Default, Clone)]
struct WindowState {
    workspace_folders: Vec<String>,
    /// Ordem do último foco (maior = mais recente).
    focus_seq: u64,
    selection: Option<EditorSelection>,
    latest_selection: Option<EditorSelection>,
    open_editors: Vec<EditorTab>,
    diagnostics: Vec<FileDiagnostics>,
}

// ---------------------------------------------------------------------------
// Canal com a UI (abstraído para os testes)
// ---------------------------------------------------------------------------

pub trait UiSink: Send + Sync {
    fn request(&self, window: &str, payload: Value);
    fn dismiss(&self, window: &str, id: &str);
    fn status(&self, clients: usize);
}

struct TauriSink(AppHandle);

impl UiSink for TauriSink {
    fn request(&self, window: &str, payload: Value) {
        if self
            .0
            .emit_to(window, EVENT_REQUEST, payload.clone())
            .is_err()
        {
            let _ = self.0.emit(EVENT_REQUEST, payload);
        }
    }
    fn dismiss(&self, window: &str, id: &str) {
        let _ = self.0.emit_to(window, EVENT_DISMISS, json!({ "id": id }));
    }
    fn status(&self, clients: usize) {
        let _ = self.0.emit(EVENT_STATUS, json!({ "clients": clients }));
    }
}

// ---------------------------------------------------------------------------
// Núcleo da ponte
// ---------------------------------------------------------------------------

struct PendingUi {
    conn: u64,
    window: String,
    tool: String,
    tab_name: Option<String>,
    tx: oneshot::Sender<Value>,
}

struct Server {
    port: u16,
    token: String,
    lock_path: Option<PathBuf>,
    shutdown: watch::Sender<bool>,
}

struct Shared {
    windows: HashMap<String, WindowState>,
    focus_counter: u64,
    clients: HashMap<u64, mpsc::UnboundedSender<Message>>,
    pending: HashMap<String, PendingUi>,
    server: Option<Server>,
    /// `false` enquanto outra integração do mesmo app atende o CLI (a extensão
    /// Claude Code hospedada publica o próprio lock "Fluent Coder"): o servidor
    /// segue no ar, mas sem lock file — o `/ide` não lista duas entradas.
    advertised: bool,
}

pub struct Bridge {
    shared: Mutex<Shared>,
    ui: Arc<dyn UiSink>,
    /// Diretório dos lock files (`~/.claude/ide`); injetável nos testes.
    lock_dir: Option<PathBuf>,
    next_id: AtomicU64,
}

/// O que fazer com uma mensagem recebida do CLI.
#[derive(Debug, PartialEq)]
pub enum Dispatch {
    /// Notificação (sem resposta).
    None,
    Reply(Value),
    /// Ferramenta que precisa da UI: encaminhar e responder depois.
    Ui {
        id: Value,
        tool: String,
        args: Value,
    },
}

impl Bridge {
    pub fn new(ui: Arc<dyn UiSink>, lock_dir: Option<PathBuf>) -> Self {
        Self {
            shared: Mutex::new(Shared {
                windows: HashMap::new(),
                focus_counter: 0,
                clients: HashMap::new(),
                pending: HashMap::new(),
                server: None,
                advertised: true,
            }),
            ui,
            lock_dir,
            next_id: AtomicU64::new(1),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn port(&self) -> Option<u16> {
        self.lock().server.as_ref().map(|s| s.port)
    }

    pub fn client_count(&self) -> usize {
        self.lock().clients.len()
    }

    // ----- ciclo de vida -------------------------------------------------

    /// Sobe o servidor numa porta efêmera de loopback. Idempotente.
    pub fn start(self: &Arc<Self>) -> std::io::Result<u16> {
        if let Some(port) = self.port() {
            return Ok(port);
        }
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        std_listener.set_nonblocking(true)?;
        let port = std_listener.local_addr()?.port();
        let token = random_token()?;
        if let Some(dir) = &self.lock_dir {
            sweep_stale_locks(dir);
        }
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        {
            let mut shared = self.lock();
            shared.server = Some(Server {
                port,
                token: token.clone(),
                lock_path: None,
                shutdown: shutdown_tx,
            });
        }
        self.sync_lock_file();
        eprintln!("[ide-bridge] ouvindo em 127.0.0.1:{port}");

        let bridge = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let listener = match TcpListener::from_std(std_listener) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[ide-bridge] falha ao registrar o listener: {e}");
                    return;
                }
            };
            let mut shutdown_rx = shutdown_rx;
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => break,
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _)) => {
                            let bridge = Arc::clone(&bridge);
                            let token = token.clone();
                            let rx = shutdown_rx.clone();
                            tauri::async_runtime::spawn(async move {
                                bridge.serve(stream, token, rx).await;
                            });
                        }
                        Err(e) => eprintln!("[ide-bridge] erro no accept: {e}"),
                    }
                }
            }
        });
        Ok(port)
    }

    /// Derruba o servidor: fecha conexões, dispensa diffs pendentes e remove o
    /// lock file.
    pub fn stop(&self) {
        let (server, pending) = {
            let mut shared = self.lock();
            let server = shared.server.take();
            let pending: Vec<(String, PendingUi)> = shared.pending.drain().collect();
            shared.clients.clear();
            (server, pending)
        };
        for (id, p) in pending {
            self.ui.dismiss(&p.window, &id);
        }
        if let Some(server) = server {
            let _ = server.shutdown.send(true);
            if let Some(path) = server.lock_path {
                let _ = std::fs::remove_file(path);
            }
        }
        self.ui.status(0);
    }

    pub fn restart(self: &Arc<Self>) -> std::io::Result<u16> {
        self.stop();
        self.start()
    }

    /// Liga/desliga a publicação do lock file sem derrubar o servidor (CLIs já
    /// conectados continuam atendidos).
    pub fn set_advertised(&self, advertised: bool) {
        {
            let mut shared = self.lock();
            if shared.advertised == advertised {
                return;
            }
            shared.advertised = advertised;
        }
        self.sync_lock_file();
    }

    /// União das pastas de workspace de todas as janelas (ordem estável: a
    /// janela focada por último primeiro).
    fn workspace_folders(shared: &Shared) -> Vec<String> {
        let mut wins: Vec<&WindowState> = shared.windows.values().collect();
        wins.sort_by(|a, b| b.focus_seq.cmp(&a.focus_seq));
        let mut out: Vec<String> = Vec::new();
        for w in wins {
            for f in &w.workspace_folders {
                if !out.iter().any(|o| o == f) {
                    out.push(f.clone());
                }
            }
        }
        out
    }

    /// Reescreve (ou remove, sem workspace aberto) o lock file do servidor.
    fn sync_lock_file(&self) {
        let Some(dir) = self.lock_dir.clone() else {
            return;
        };
        let mut shared = self.lock();
        let folders = Self::workspace_folders(&shared);
        let advertised = shared.advertised;
        let Some(server) = shared.server.as_mut() else {
            return;
        };
        let path = dir.join(format!("{}.lock", server.port));
        if folders.is_empty() || !advertised {
            if server.lock_path.take().is_some() {
                let _ = std::fs::remove_file(&path);
            }
            return;
        }
        let content = lock_file_content(std::process::id(), &folders, &server.token);
        match write_lock_file(&path, &content) {
            Ok(()) => server.lock_path = Some(path),
            Err(e) => eprintln!("[ide-bridge] falha ao gravar o lock file: {e}"),
        }
    }

    // ----- estado vindo do frontend -------------------------------------

    pub fn update_window(&self, label: &str, patch: WindowPatch) {
        let mut folders_changed = false;
        let mut notify: Option<EditorSelection> = None;
        {
            let mut shared = self.lock();
            let seq = if patch.focused == Some(true) {
                shared.focus_counter += 1;
                Some(shared.focus_counter)
            } else {
                None
            };
            let win = shared.windows.entry(label.to_string()).or_default();
            if let Some(seq) = seq {
                win.focus_seq = seq;
            }
            if let Some(folders) = patch.workspace_folders {
                folders_changed = folders != win.workspace_folders;
                win.workspace_folders = folders;
            }
            if let Some(sel) = patch.selection {
                if let Some(s) = &sel {
                    if win.selection.as_ref() != Some(s) {
                        notify = Some(s.clone());
                    }
                    win.latest_selection = Some(s.clone());
                }
                win.selection = sel;
            }
            if let Some(tabs) = patch.open_editors {
                win.open_editors = tabs;
            }
            if let Some(diags) = patch.diagnostics {
                win.diagnostics = diags;
            }
        }
        if folders_changed {
            self.sync_lock_file();
        }
        if let Some(sel) = notify {
            self.broadcast_notification("selection_changed", selection_changed_params(&sel));
        }
    }

    pub fn forget_window(&self, label: &str) {
        let pending: Vec<String> = {
            let mut shared = self.lock();
            shared.windows.remove(label);
            let ids: Vec<String> = shared
                .pending
                .iter()
                .filter(|(_, p)| p.window == label)
                .map(|(id, _)| id.clone())
                .collect();
            ids
        };
        // A janela sumiu com um diff aberto: conta como rejeitado.
        for id in pending {
            self.resolve(&id, text_result("DIFF_REJECTED"));
        }
        self.sync_lock_file();
    }

    fn broadcast_notification(&self, method: &str, params: Value) {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
        let shared = self.lock();
        for tx in shared.clients.values() {
            let _ = tx.send(Message::Text(msg.clone()));
        }
    }

    /// Resposta da UI a um request encaminhado.
    pub fn resolve(&self, id: &str, result: Value) {
        let pending = self.lock().pending.remove(id);
        if let Some(p) = pending {
            let _ = p.tx.send(result);
        }
    }

    // ----- dispatch JSON-RPC --------------------------------------------

    /// Interpreta uma mensagem do CLI. Ferramentas de consulta respondem do
    /// cache; as de UI viram [`Dispatch::Ui`].
    pub fn dispatch(&self, conn: u64, raw: &str) -> Dispatch {
        let msg: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => {
                return Dispatch::Reply(json!({
                    "jsonrpc": "2.0", "id": Value::Null,
                    "error": { "code": -32700, "message": "Parse error" }
                }))
            }
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let Some(id) = msg.get("id").cloned() else {
            if method == "ide_connected" {
                eprintln!("[ide-bridge] CLI conectado: {}", msg["params"]);
            }
            return Dispatch::None;
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let result = match method {
            "initialize" => json!({
                "protocolVersion": params
                    .get("protocolVersion")
                    .cloned()
                    .unwrap_or_else(|| json!("2025-03-26")),
                "capabilities": { "tools": { "listChanged": true } },
                "serverInfo": { "name": "fluent-coder", "version": env!("CARGO_PKG_VERSION") },
            }),
            "tools/list" => json!({ "tools": tool_definitions() }),
            "prompts/list" => json!({ "prompts": [] }),
            "resources/list" => json!({ "resources": [] }),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match self.call_tool(conn, name, &args) {
                    Some(result) => result,
                    None => {
                        return Dispatch::Ui {
                            id,
                            tool: name.to_string(),
                            args,
                        }
                    }
                }
            }
            _ => json!({}),
        };
        Dispatch::Reply(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    /// Executa uma ferramenta respondível do cache. `None` = precisa da UI.
    fn call_tool(&self, conn: u64, name: &str, args: &Value) -> Option<Value> {
        let shared = self.lock();
        let focused = shared
            .windows
            .values()
            .max_by_key(|w| w.focus_seq)
            .cloned()
            .unwrap_or_default();
        let str_arg = |k: &str| {
            args.get(k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        Some(match name {
            "getWorkspaceFolders" => {
                let folders = Self::workspace_folders(&shared);
                let root = focused
                    .workspace_folders
                    .first()
                    .cloned()
                    .or_else(|| folders.first().cloned());
                json_result(json!({
                    "success": true,
                    "folders": folders.iter().map(|f| json!({
                        "name": base_name(f),
                        "uri": file_uri(f),
                        "path": f,
                    })).collect::<Vec<_>>(),
                    "rootPath": root,
                }))
            }
            "getCurrentSelection" => match &focused.selection {
                Some(sel) => json_result(selection_json(sel)),
                None => {
                    json_result(json!({ "success": false, "message": "No active editor found" }))
                }
            },
            "getLatestSelection" => match focused
                .latest_selection
                .as_ref()
                .or(focused.selection.as_ref())
            {
                Some(sel) => json_result(selection_json(sel)),
                None => {
                    json_result(json!({ "success": false, "message": "No selection available" }))
                }
            },
            "getOpenEditors" => json_result(json!({
                "tabs": focused.open_editors.iter().map(|t| json!({
                    "uri": t.uri, "isActive": t.is_active, "label": t.label,
                    "languageId": t.language_id, "isDirty": t.is_dirty,
                })).collect::<Vec<_>>()
            })),
            "getDiagnostics" => {
                let uri = args.get("uri").and_then(Value::as_str);
                let all: Vec<&WindowState> = shared.windows.values().collect();
                json_result(json!(collect_diagnostics(&all, uri)))
            }
            "checkDocumentDirty" => {
                let path = str_arg("filePath");
                match find_tab(&shared, &path) {
                    Some((_, tab)) => json_result(json!({
                        "success": true, "filePath": path,
                        "isDirty": tab.is_dirty, "isUntitled": false,
                    })),
                    None => json_result(json!({
                        "success": false, "message": format!("Document not open: {path}"),
                    })),
                }
            }
            "saveDocument" => {
                let path = str_arg("filePath");
                if find_tab(&shared, &path).is_none() {
                    json_result(json!({
                        "success": false, "message": format!("Document not open: {path}"),
                    }))
                } else {
                    return None;
                }
            }
            "close_tab" => {
                let tab = str_arg("tab_name");
                drop(shared);
                self.close_diffs(conn, |p| p.tab_name.as_deref() == Some(tab.as_str()));
                text_result("TAB_CLOSED")
            }
            "closeAllDiffTabs" => {
                drop(shared);
                let n = self.close_diffs(conn, |_| true);
                text_result(&format!("CLOSED_{n}_DIFF_TABS"))
            }
            "openDiff" | "openFile" => return None,
            other => json!({
                "content": [{ "type": "text", "text": format!("Unknown tool: {other}") }],
                "isError": true,
            }),
        })
    }

    /// Fecha (como rejeitados) os diffs pendentes desta conexão que casam com
    /// o filtro. Retorna quantos foram fechados.
    fn close_diffs(&self, conn: u64, filter: impl Fn(&PendingUi) -> bool) -> usize {
        let closed: Vec<(String, PendingUi)> = {
            let mut shared = self.lock();
            let ids: Vec<String> = shared
                .pending
                .iter()
                .filter(|(_, p)| p.conn == conn && p.tool == "openDiff" && filter(p))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| shared.pending.remove(&id).map(|p| (id, p)))
                .collect()
        };
        let n = closed.len();
        for (id, p) in closed {
            self.ui.dismiss(&p.window, &id);
            let _ = p.tx.send(text_result("DIFF_REJECTED"));
        }
        n
    }

    /// Janela que deve tratar um request sobre `path`: a que tem a pasta de
    /// workspace mais específica contendo o arquivo; senão a focada por último.
    fn route_window(&self, path: Option<&str>) -> String {
        let shared = self.lock();
        if let Some(path) = path {
            let best = shared
                .windows
                .iter()
                .filter_map(|(label, w)| {
                    w.workspace_folders
                        .iter()
                        .filter(|f| path_within(path, f))
                        .map(|f| f.len())
                        .max()
                        .map(|len| (len, w.focus_seq, label))
                })
                .max();
            if let Some((_, _, label)) = best {
                return label.clone();
            }
        }
        shared
            .windows
            .iter()
            .max_by_key(|(_, w)| w.focus_seq)
            .map(|(l, _)| l.clone())
            .unwrap_or_else(|| "main".to_string())
    }

    /// Encaminha uma ferramenta à UI e aguarda a resposta.
    async fn forward_to_ui(&self, conn: u64, tool: &str, args: Value) -> Value {
        let path = ["new_file_path", "filePath", "old_file_path"]
            .iter()
            .find_map(|k| args.get(*k).and_then(Value::as_str))
            .map(str::to_string);
        let window = self.route_window(path.as_deref());
        let id = format!("ide-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.lock().pending.insert(
            id.clone(),
            PendingUi {
                conn,
                window: window.clone(),
                tool: tool.to_string(),
                tab_name: args
                    .get("tab_name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                tx,
            },
        );
        self.ui
            .request(&window, json!({ "id": id, "tool": tool, "args": args }));
        if tool == "openDiff" {
            // Bloqueante por design: espera a decisão do usuário. Se o canal
            // cair (janela fechada/servidor parado), conta como rejeitado.
            rx.await.unwrap_or_else(|_| text_result("DIFF_REJECTED"))
        } else {
            match tokio::time::timeout(UI_TIMEOUT, rx).await {
                Ok(Ok(v)) => v,
                _ => {
                    self.lock().pending.remove(&id);
                    json!({
                        "content": [{ "type": "text", "text": format!("{tool}: a IDE não respondeu a tempo") }],
                        "isError": true,
                    })
                }
            }
        }
    }

    // ----- conexão WebSocket --------------------------------------------

    #[allow(clippy::result_large_err)]
    async fn serve(
        self: Arc<Self>,
        stream: TcpStream,
        token: String,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let callback = |req: &Request, mut response: Response| match check_handshake(req, &token) {
            Ok(()) => {
                // O CLI pede um subprotocolo (`Sec-WebSocket-Protocol`) e o
                // cliente `ws` dele derruba a conexão se o servidor não escolher
                // um ("Server sent no subprotocol"). Ecoa o primeiro oferecido.
                if let Some(proto) = first_subprotocol(req) {
                    response.headers_mut().insert(SUBPROTOCOL_HEADER, proto);
                }
                Ok(response)
            }
            Err(status) => Err(Response::builder()
                .status(status)
                .body(Some("unauthorized".to_string()))
                .expect("resposta de rejeição")),
        };
        let ws = match tokio_tungstenite::accept_hdr_async(stream, callback).await {
            Ok(ws) => ws,
            Err(e) => {
                eprintln!("[ide-bridge] handshake recusado: {e}");
                return;
            }
        };
        let conn = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let clients = {
            let mut shared = self.lock();
            shared.clients.insert(conn, out_tx.clone());
            shared.clients.len()
        };
        self.ui.status(clients);

        let (mut sink, mut source) = ws.split();
        let writer = tauri::async_runtime::spawn(async move {
            while let Some(msg) = out_rx.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        loop {
            let msg = tokio::select! {
                _ = shutdown.changed() => break,
                msg = source.next() => msg,
            };
            let text = match msg {
                Some(Ok(Message::Text(t))) => t,
                Some(Ok(Message::Binary(b))) => match String::from_utf8(b) {
                    Ok(t) => t,
                    Err(_) => continue,
                },
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => continue,
            };
            match self.dispatch(conn, &text) {
                Dispatch::None => {}
                Dispatch::Reply(v) => {
                    let _ = out_tx.send(Message::Text(v.to_string()));
                }
                Dispatch::Ui { id, tool, args } => {
                    let bridge = Arc::clone(&self);
                    let out = out_tx.clone();
                    tauri::async_runtime::spawn(async move {
                        let result = bridge.forward_to_ui(conn, &tool, args).await;
                        let reply = json!({ "jsonrpc": "2.0", "id": id, "result": result });
                        let _ = out.send(Message::Text(reply.to_string()));
                    });
                }
            }
        }

        // Conexão caiu: dispensa a UI dos requests pendentes desta conexão.
        let (dropped, clients) = {
            let mut shared = self.lock();
            shared.clients.remove(&conn);
            let ids: Vec<String> = shared
                .pending
                .iter()
                .filter(|(_, p)| p.conn == conn)
                .map(|(id, _)| id.clone())
                .collect();
            let dropped: Vec<(String, PendingUi)> = ids
                .into_iter()
                .filter_map(|id| shared.pending.remove(&id).map(|p| (id, p)))
                .collect();
            (dropped, shared.clients.len())
        };
        for (id, p) in dropped {
            self.ui.dismiss(&p.window, &id);
        }
        self.ui.status(clients);
        drop(out_tx);
        let _ = writer.await;
        eprintln!("[ide-bridge] CLI desconectado");
    }
}

// ---------------------------------------------------------------------------
// Funções puras (testadas)
// ---------------------------------------------------------------------------

/// Token de 128 bits do CSPRNG do sistema, em hex.
fn random_token() -> std::io::Result<String> {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Comparação em tempo constante (o token não vaza por timing).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

const SUBPROTOCOL_HEADER: &str = "sec-websocket-protocol";

/// Primeiro subprotocolo da lista `Sec-WebSocket-Protocol` do cliente, se houver.
fn first_subprotocol(req: &Request) -> Option<HeaderValue> {
    let raw = req.headers().get(SUBPROTOCOL_HEADER)?.to_str().ok()?;
    let first = raw.split(',').map(str::trim).find(|p| !p.is_empty())?;
    HeaderValue::from_str(first).ok()
}

/// Valida o handshake: token correto e sem `Origin` (navegadores sempre o
/// enviam; o CLI não).
fn check_handshake(req: &Request, token: &str) -> Result<(), StatusCode> {
    if req.headers().contains_key("origin") {
        return Err(StatusCode::FORBIDDEN);
    }
    let ok = req
        .headers()
        .get(AUTH_HEADER)
        .map(|v| ct_eq(v.as_bytes(), token.as_bytes()))
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

/// Remove locks "Fluent Coder" deixados por processos que já morreram (app
/// encerrado à força, reinício do `tauri dev`). Locks de outras IDEs e de
/// processos vivos nunca são tocados.
fn sweep_stale_locks(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let me = std::process::id();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("lock") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        if is_stale_fluent_lock(&raw, me, pid_alive) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn is_stale_fluent_lock(raw: &str, me: u32, alive: impl Fn(u32) -> bool) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    if v.get("ideName").and_then(Value::as_str) != Some(IDE_NAME) {
        return false;
    }
    match v.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()) {
        Some(pid) => pid != me && !alive(pid),
        None => false,
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return true;
    };
    // kill(pid, 0): só checa existência. EPERM = existe, mas é de outro usuário.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Sem checagem barata de pid fora do Unix: nunca considera o lock órfão.
#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    true
}

pub fn lock_file_content(pid: u32, folders: &[String], token: &str) -> Value {
    json!({
        "pid": pid,
        "workspaceFolders": folders,
        "ideName": IDE_NAME,
        "transport": "ws",
        "runningInWindows": cfg!(windows),
        "authToken": token,
    })
}

/// Grava o lock file com permissão 0600 (o token dá acesso ao editor).
fn write_lock_file(path: &Path, content: &Value) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    // `mode` só vale na criação; garante 0600 se o arquivo já existia.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(content.to_string().as_bytes())
}

/// `~/.claude/ide` (respeitando `CLAUDE_CONFIG_DIR`, como o CLI).
pub fn default_lock_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join("ide"));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".claude").join("ide"))
}

fn text_result(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn json_result(v: Value) -> Value {
    text_result(&v.to_string())
}

fn base_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_string()
}

/// `file://` URI de um caminho absoluto (Windows → `file:///c:/…`).
pub fn file_uri(path: &str) -> String {
    let p = path.replace('\\', "/");
    let encoded: String = p
        .chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '#' => "%23".to_string(),
            '?' => "%3F".to_string(),
            '%' => "%25".to_string(),
            c => c.to_string(),
        })
        .collect();
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

fn norm_path(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn path_within(path: &str, folder: &str) -> bool {
    let (p, f) = (norm_path(path), norm_path(folder));
    p == f || p.starts_with(&format!("{f}/"))
}

fn uri_matches(uri: &str, wanted: &str) -> bool {
    let strip = |u: &str| {
        norm_path(
            u.strip_prefix("file://")
                .unwrap_or(u)
                .trim_start_matches('/'),
        )
    };
    strip(uri) == strip(wanted)
}

fn find_tab<'a>(shared: &'a Shared, path: &str) -> Option<(&'a str, &'a EditorTab)> {
    shared.windows.iter().find_map(|(label, w)| {
        w.open_editors
            .iter()
            .find(|t| norm_path(&t.path) == norm_path(path))
            .map(|t| (label.as_str(), t))
    })
}

fn collect_diagnostics(windows: &[&WindowState], uri: Option<&str>) -> Vec<FileDiagnostics> {
    let mut out: Vec<FileDiagnostics> = Vec::new();
    for w in windows {
        for fd in &w.diagnostics {
            if let Some(wanted) = uri {
                if !uri_matches(&fd.uri, wanted) {
                    continue;
                }
            }
            if !out.iter().any(|o| o.uri == fd.uri) {
                out.push(fd.clone());
            }
        }
    }
    out
}

fn selection_json(sel: &EditorSelection) -> Value {
    json!({
        "success": true,
        "text": sel.text,
        "filePath": sel.file_path,
        "selection": sel.selection,
    })
}

fn selection_changed_params(sel: &EditorSelection) -> Value {
    json!({
        "text": sel.text,
        "filePath": sel.file_path,
        "fileUrl": file_uri(&sel.file_path),
        "selection": sel.selection,
    })
}

fn tool_definitions() -> Value {
    let obj = |props: Value, required: &[&str]| json!({ "type": "object", "properties": props, "required": required });
    let s = |d: &str| json!({ "type": "string", "description": d });
    let b = |d: &str| json!({ "type": "boolean", "description": d });
    let tools = vec![
        ("openDiff", "Abre um diff da alteração proposta no Fluent Coder e aguarda o usuário aceitar ou rejeitar.",
            obj(json!({
                "old_file_path": s("Caminho do arquivo original"),
                "new_file_path": s("Caminho do arquivo novo"),
                "new_file_contents": s("Conteúdo proposto"),
                "tab_name": s("Título da aba do diff"),
            }), &["old_file_path", "new_file_path", "new_file_contents", "tab_name"])),
        ("openFile", "Abre um arquivo no editor, opcionalmente selecionando um trecho.",
            obj(json!({
                "filePath": s("Caminho do arquivo"),
                "preview": b("Abrir em modo preview"),
                "startText": s("Texto que inicia a seleção"),
                "endText": s("Texto que termina a seleção"),
                "makeFrontmost": b("Trazer o editor para frente"),
            }), &["filePath"])),
        ("getCurrentSelection", "Seleção atual do editor ativo.", obj(json!({}), &[])),
        ("getLatestSelection", "Seleção mais recente feita no editor.", obj(json!({}), &[])),
        ("getOpenEditors", "Abas abertas no editor.", obj(json!({}), &[])),
        ("getWorkspaceFolders", "Pastas do workspace aberto.", obj(json!({}), &[])),
        ("getDiagnostics", "Diagnósticos (erros/avisos) do editor.",
            obj(json!({ "uri": s("URI do arquivo; omitido = todos") }), &[])),
        ("checkDocumentDirty", "Indica se o documento tem alterações não salvas.",
            obj(json!({ "filePath": s("Caminho do arquivo") }), &["filePath"])),
        ("saveDocument", "Salva o documento aberto.",
            obj(json!({ "filePath": s("Caminho do arquivo") }), &["filePath"])),
        ("close_tab", "Fecha uma aba de diff pelo nome.",
            obj(json!({ "tab_name": s("Nome da aba") }), &["tab_name"])),
        ("closeAllDiffTabs", "Fecha todas as abas de diff.", obj(json!({}), &[])),
    ];
    Value::Array(
        tools
            .into_iter()
            .map(|(name, desc, schema)| json!({ "name": name, "description": desc, "inputSchema": schema }))
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// Estado Tauri + comandos
// ---------------------------------------------------------------------------

pub struct IdeBridgeState {
    bridge: Mutex<Option<Arc<Bridge>>>,
}

impl IdeBridgeState {
    pub fn new() -> Self {
        Self {
            bridge: Mutex::new(None),
        }
    }

    fn get(&self) -> Option<Arc<Bridge>> {
        self.bridge.lock().ok()?.clone()
    }

    /// Sobe a ponte no setup do app. Falha só é logada: o editor segue sem ela.
    pub fn start(&self, app: &AppHandle) {
        let bridge = Arc::new(Bridge::new(
            Arc::new(TauriSink(app.clone())),
            default_lock_dir(),
        ));
        if let Err(e) = bridge.start() {
            eprintln!("[ide-bridge] não foi possível iniciar: {e}");
            return;
        }
        if let Ok(mut slot) = self.bridge.lock() {
            *slot = Some(bridge);
        }
    }

    /// Porta do servidor, se rodando (usada para a env do terminal).
    pub fn port(&self) -> Option<u16> {
        self.get()?.port()
    }

    pub fn forget_window(&self, label: &str) {
        if let Some(b) = self.get() {
            b.forget_window(label);
        }
    }

    pub fn shutdown(&self) {
        if let Some(b) = self.get() {
            b.stop();
        }
    }
}

impl Default for IdeBridgeState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeBridgeStatus {
    running: bool,
    port: Option<u16>,
    clients: usize,
}

#[tauri::command]
pub fn ide_bridge_update(
    window: tauri::Window,
    patch: WindowPatch,
    state: State<'_, IdeBridgeState>,
) {
    if let Some(b) = state.get() {
        b.update_window(window.label(), patch);
    }
}

#[tauri::command]
pub fn ide_bridge_respond(id: String, result: Value, state: State<'_, IdeBridgeState>) {
    if let Some(b) = state.get() {
        b.resolve(&id, result);
    }
}

#[tauri::command]
pub fn ide_bridge_status(state: State<'_, IdeBridgeState>) -> IdeBridgeStatus {
    match state.get() {
        Some(b) => IdeBridgeStatus {
            running: b.port().is_some(),
            port: b.port(),
            clients: b.client_count(),
        },
        None => IdeBridgeStatus {
            running: false,
            port: None,
            clients: 0,
        },
    }
}

/// Publica ou retira o lock file da ponte (o frontend desliga enquanto a
/// extensão Claude Code hospedada está ativa, que publica o próprio).
#[tauri::command]
pub fn ide_bridge_set_advertised(advertised: bool, state: State<'_, IdeBridgeState>) {
    if let Some(b) = state.get() {
        b.set_advertised(advertised);
    }
}

/// Reinicia a ponte (porta + token novos). O estado das janelas é preservado e
/// o lock file regravado; CLIs conectados caem e precisam reconectar (`/ide`).
#[tauri::command]
pub fn ide_bridge_restart(app: AppHandle, state: State<'_, IdeBridgeState>) -> Result<u16, String> {
    match state.get() {
        Some(b) => b.restart().map_err(|e| e.to_string()),
        None => {
            state.start(&app);
            state
                .port()
                .ok_or_else(|| "Não foi possível iniciar a integração".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MockSink {
        requests: Mutex<Vec<(String, Value)>>,
        dismissed: Mutex<Vec<String>>,
    }
    impl UiSink for MockSink {
        fn request(&self, window: &str, payload: Value) {
            self.requests.lock().unwrap().push((window.into(), payload));
        }
        fn dismiss(&self, _window: &str, id: &str) {
            self.dismissed.lock().unwrap().push(id.into());
        }
        fn status(&self, _clients: usize) {}
    }

    fn bridge() -> (Arc<Bridge>, Arc<MockSink>) {
        let sink = Arc::new(MockSink::default());
        (Arc::new(Bridge::new(sink.clone(), None)), sink)
    }

    fn reply(d: Dispatch) -> Value {
        match d {
            Dispatch::Reply(v) => v,
            other => panic!("esperava Reply, veio {other:?}"),
        }
    }

    fn tool_text(v: &Value) -> String {
        v["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn call(b: &Bridge, name: &str, args: Value) -> Dispatch {
        let msg = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": name, "arguments": args } });
        b.dispatch(1, &msg.to_string())
    }

    fn sel(path: &str, text: &str) -> EditorSelection {
        EditorSelection {
            text: text.into(),
            file_path: path.into(),
            selection: SelectionRange {
                start: Position {
                    line: 9,
                    character: 0,
                },
                end: Position {
                    line: 9,
                    character: 18,
                },
                is_empty: text.is_empty(),
            },
        }
    }

    #[test]
    fn initialize_echoes_protocol_version() {
        let (b, _) = bridge();
        let v = reply(b.dispatch(
            1,
            r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{}}}"#,
        ));
        assert_eq!(v["id"], 0);
        assert_eq!(v["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(v["result"]["capabilities"]["tools"]["listChanged"], true);
        assert_eq!(v["result"]["serverInfo"]["name"], "fluent-coder");
    }

    #[test]
    fn notifications_get_no_reply_and_unknown_methods_get_empty_result() {
        let (b, _) = bridge();
        assert_eq!(
            b.dispatch(
                1,
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
            ),
            Dispatch::None
        );
        assert_eq!(
            b.dispatch(
                1,
                r#"{"jsonrpc":"2.0","method":"ide_connected","params":{"pid":1}}"#
            ),
            Dispatch::None
        );
        let v = reply(b.dispatch(1, r#"{"jsonrpc":"2.0","id":3,"method":"foo/bar"}"#));
        assert_eq!(v["result"], json!({}));
        let v = reply(b.dispatch(1, r#"{"jsonrpc":"2.0","id":4,"method":"prompts/list"}"#));
        assert_eq!(v["result"], json!({ "prompts": [] }));
        let v = reply(b.dispatch(1, "not json"));
        assert_eq!(v["error"]["code"], -32700);
    }

    #[test]
    fn tools_list_includes_the_observed_tools() {
        let (b, _) = bridge();
        let v = reply(b.dispatch(1, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#));
        let names: Vec<&str> = v["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        for n in [
            "openDiff",
            "getDiagnostics",
            "closeAllDiffTabs",
            "getWorkspaceFolders",
            "close_tab",
            "openFile",
        ] {
            assert!(names.contains(&n), "{n} ausente");
        }
    }

    #[test]
    fn workspace_folders_and_selection_come_from_pushed_state() {
        let (b, _) = bridge();
        b.update_window(
            "main",
            WindowPatch {
                workspace_folders: Some(vec!["/w/proj".into()]),
                focused: Some(true),
                selection: Some(Some(sel("/w/proj/a.ts", "const x = 1;"))),
                ..Default::default()
            },
        );
        let v = reply(call(&b, "getWorkspaceFolders", json!({})));
        let body: Value = serde_json::from_str(&tool_text(&v)).unwrap();
        assert_eq!(body["success"], true);
        assert_eq!(body["rootPath"], "/w/proj");
        assert_eq!(body["folders"][0]["name"], "proj");
        assert_eq!(body["folders"][0]["uri"], "file:///w/proj");

        let v = reply(call(&b, "getCurrentSelection", json!({})));
        let body: Value = serde_json::from_str(&tool_text(&v)).unwrap();
        assert_eq!(body["text"], "const x = 1;");
        assert_eq!(body["selection"]["start"]["line"], 9);
        assert_eq!(body["selection"]["isEmpty"], false);

        // Sem editor ativo: current falha, latest mantém a última seleção.
        b.update_window(
            "main",
            serde_json::from_value(json!({ "selection": null })).unwrap(),
        );
        let v = reply(call(&b, "getCurrentSelection", json!({})));
        assert!(tool_text(&v).contains("\"success\":false"));
        let v = reply(call(&b, "getLatestSelection", json!({})));
        assert!(tool_text(&v).contains("const x = 1;"));
    }

    #[test]
    fn diagnostics_filter_by_uri() {
        let (b, _) = bridge();
        let patch: WindowPatch = serde_json::from_value(json!({
            "diagnostics": [
                { "uri": "file:///w/a.ts", "diagnostics": [{ "message": "boom", "severity": "Error",
                  "range": { "start": { "line": 0, "character": 1 }, "end": { "line": 0, "character": 4 } }, "source": "ts" }] },
                { "uri": "file:///w/b.ts", "diagnostics": [] }
            ]
        })).unwrap();
        b.update_window("main", patch);
        let v = reply(call(&b, "getDiagnostics", json!({})));
        let all: Value = serde_json::from_str(&tool_text(&v)).unwrap();
        assert_eq!(all.as_array().unwrap().len(), 2);
        let v = reply(call(
            &b,
            "getDiagnostics",
            json!({ "uri": "file:///w/a.ts" }),
        ));
        let one: Value = serde_json::from_str(&tool_text(&v)).unwrap();
        assert_eq!(one.as_array().unwrap().len(), 1);
        assert_eq!(one[0]["diagnostics"][0]["severity"], "Error");
        assert_eq!(one[0]["diagnostics"][0]["range"]["start"]["character"], 1);
    }

    #[test]
    fn ui_tools_are_forwarded_and_dirty_check_uses_tabs() {
        let (b, _) = bridge();
        assert!(matches!(
            call(&b, "openDiff", json!({ "new_file_path": "/w/a.ts" })),
            Dispatch::Ui { .. }
        ));
        assert!(matches!(
            call(&b, "openFile", json!({ "filePath": "/w/a.ts" })),
            Dispatch::Ui { .. }
        ));
        // saveDocument de arquivo não aberto responde direto.
        let v = reply(call(&b, "saveDocument", json!({ "filePath": "/w/a.ts" })));
        assert!(tool_text(&v).contains("Document not open"));

        b.update_window(
            "main",
            serde_json::from_value(json!({
                "openEditors": [{ "uri": "file:///w/a.ts", "path": "/w/a.ts", "isActive": true,
                                  "label": "a.ts", "languageId": "typescript", "isDirty": true }]
            }))
            .unwrap(),
        );
        let v = reply(call(
            &b,
            "checkDocumentDirty",
            json!({ "filePath": "/w/a.ts" }),
        ));
        assert!(tool_text(&v).contains("\"isDirty\":true"));
        assert!(matches!(
            call(&b, "saveDocument", json!({ "filePath": "/w/a.ts" })),
            Dispatch::Ui { .. }
        ));
        let v = reply(call(&b, "getOpenEditors", json!({})));
        assert!(tool_text(&v).contains("\"label\":\"a.ts\""));
    }

    #[test]
    fn unknown_tool_is_an_error_result() {
        let (b, _) = bridge();
        let v = reply(call(&b, "nope", json!({})));
        assert_eq!(v["result"]["isError"], true);
    }

    #[test]
    fn routes_to_the_window_owning_the_file() {
        let (b, _) = bridge();
        b.update_window(
            "main",
            serde_json::from_value(json!({ "workspaceFolders": ["/w/a"], "focused": true }))
                .unwrap(),
        );
        b.update_window(
            "win-2",
            serde_json::from_value(json!({ "workspaceFolders": ["/w/b"] })).unwrap(),
        );
        assert_eq!(b.route_window(Some("/w/b/x.ts")), "win-2");
        assert_eq!(b.route_window(Some("/w/a/x.ts")), "main");
        // Fora de qualquer workspace → janela focada por último.
        assert_eq!(b.route_window(Some("/elsewhere/x.ts")), "main");
        assert!(!path_within("/w/ab/x.ts", "/w/a"));
    }

    #[tokio::test]
    async fn open_diff_blocks_until_ui_answers_and_close_all_rejects() {
        let (b, sink) = bridge();
        let b2 = Arc::clone(&b);
        let task = tokio::spawn(async move {
            b2.forward_to_ui(
                1,
                "openDiff",
                json!({ "new_file_path": "/w/a.ts", "tab_name": "a.ts" }),
            )
            .await
        });
        // Espera o request chegar à "UI".
        let id = loop {
            if let Some((_, p)) = sink.requests.lock().unwrap().first() {
                break p["id"].as_str().unwrap().to_string();
            }
            tokio::task::yield_now().await;
        };
        b.resolve(&id, text_result("FILE_SAVED"));
        assert_eq!(task.await.unwrap()["content"][0]["text"], "FILE_SAVED");

        // Segundo diff: closeAllDiffTabs da mesma conexão rejeita e dispensa a UI.
        let b3 = Arc::clone(&b);
        let task = tokio::spawn(async move {
            b3.forward_to_ui(
                1,
                "openDiff",
                json!({ "new_file_path": "/w/a.ts", "tab_name": "a.ts" }),
            )
            .await
        });
        while b.lock().pending.is_empty() {
            tokio::task::yield_now().await;
        }
        let v = reply(call(&b, "closeAllDiffTabs", json!({})));
        assert_eq!(tool_text(&v), "CLOSED_1_DIFF_TABS");
        assert_eq!(task.await.unwrap()["content"][0]["text"], "DIFF_REJECTED");
        assert_eq!(sink.dismissed.lock().unwrap().len(), 1);
    }

    #[test]
    fn handshake_requires_token_and_rejects_origin() {
        let build = |headers: &[(&str, &str)]| {
            let mut r = Request::builder().uri("/");
            for (k, v) in headers {
                r = r.header(*k, *v);
            }
            r.body(()).unwrap()
        };
        assert!(check_handshake(&build(&[(AUTH_HEADER, "abc")]), "abc").is_ok());
        assert_eq!(
            check_handshake(&build(&[(AUTH_HEADER, "abd")]), "abc"),
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            check_handshake(&build(&[]), "abc"),
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            check_handshake(
                &build(&[(AUTH_HEADER, "abc"), ("origin", "http://evil")]),
                "abc"
            ),
            Err(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn stale_lock_detection_only_targets_dead_fluent_locks() {
        let lock = |name: &str, pid: u32| json!({ "ideName": name, "pid": pid }).to_string();
        let dead = |_: u32| false;
        let alive = |_: u32| true;
        assert!(is_stale_fluent_lock(&lock(IDE_NAME, 42), 1, dead));
        assert!(!is_stale_fluent_lock(&lock(IDE_NAME, 42), 1, alive));
        assert!(!is_stale_fluent_lock(&lock(IDE_NAME, 1), 1, dead), "o próprio processo");
        assert!(!is_stale_fluent_lock(&lock("Visual Studio Code", 42), 1, dead));
        assert!(!is_stale_fluent_lock("não é json", 1, dead));
    }

    #[test]
    fn handshake_echoes_first_requested_subprotocol() {
        let build = |proto: Option<&str>| {
            let mut r = Request::builder().uri("/");
            if let Some(p) = proto {
                r = r.header(SUBPROTOCOL_HEADER, p);
            }
            r.body(()).unwrap()
        };
        assert_eq!(first_subprotocol(&build(Some("mcp"))).unwrap(), "mcp");
        assert_eq!(first_subprotocol(&build(Some(" mcp , other"))).unwrap(), "mcp");
        assert!(first_subprotocol(&build(None)).is_none());
        assert!(first_subprotocol(&build(Some(" , "))).is_none());
    }

    #[test]
    fn token_is_128_bit_hex() {
        let t = random_token().unwrap();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t, random_token().unwrap());
    }

    #[test]
    fn lock_file_has_expected_shape_and_0600_perms() {
        let dir = std::env::temp_dir().join(format!("fc-ide-lock-{}", std::process::id()));
        let path = dir.join("4242.lock");
        let content = lock_file_content(99, &["/w/proj".into()], "tok");
        write_lock_file(&path, &content).unwrap();
        let read: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read["pid"], 99);
        assert_eq!(read["workspaceFolders"], json!(["/w/proj"]));
        assert_eq!(read["ideName"], "Fluent Coder");
        assert_eq!(read["transport"], "ws");
        assert_eq!(read["authToken"], "tok");
        assert_eq!(read["runningInWindows"], cfg!(windows));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lock_file_follows_workspace_lifecycle() {
        let dir = std::env::temp_dir().join(format!("fc-ide-life-{}", std::process::id()));
        let sink = Arc::new(MockSink::default());
        let b = Arc::new(Bridge::new(sink, Some(dir.clone())));
        // Simula um servidor rodando sem abrir socket.
        let (tx, _rx) = watch::channel(false);
        b.lock().server = Some(Server {
            port: 5151,
            token: "t".into(),
            lock_path: None,
            shutdown: tx,
        });
        let path = dir.join("5151.lock");

        b.update_window(
            "main",
            serde_json::from_value(json!({ "workspaceFolders": ["/w/a"] })).unwrap(),
        );
        assert!(path.exists());
        b.update_window(
            "w2",
            serde_json::from_value(json!({ "workspaceFolders": ["/w/b"] })).unwrap(),
        );
        let read: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read["workspaceFolders"].as_array().unwrap().len(), 2);

        b.forget_window("w2");
        b.update_window(
            "main",
            serde_json::from_value(json!({ "workspaceFolders": [] })).unwrap(),
        );
        assert!(!path.exists(), "sem workspace aberto o lock file some");
        b.update_window(
            "main",
            serde_json::from_value(json!({ "workspaceFolders": ["/w/a"] })).unwrap(),
        );
        assert!(path.exists());
        b.stop();
        assert!(!path.exists(), "stop remove o lock file");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Ponta a ponta no socket real: token certo conecta e responde
    /// `initialize`; token errado e `Origin` são recusados no handshake.
    #[tokio::test]
    async fn real_socket_auth_and_initialize() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let dir = std::env::temp_dir().join(format!("fc-ide-sock-{}", std::process::id()));
        let sink = Arc::new(MockSink::default());
        let b = Arc::new(Bridge::new(sink, Some(dir.clone())));
        let port = b.start().unwrap();
        b.update_window(
            "main",
            serde_json::from_value(json!({ "workspaceFolders": ["/w/a"] })).unwrap(),
        );
        let lock: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(format!("{port}.lock"))).unwrap(),
        )
        .unwrap();
        let token = lock["authToken"].as_str().unwrap().to_string();
        let url = format!("ws://127.0.0.1:{port}");

        let connect = |tok: &str, origin: Option<&str>| {
            let mut req = url.clone().into_client_request().unwrap();
            req.headers_mut().insert(AUTH_HEADER, tok.parse().unwrap());
            if let Some(o) = origin {
                req.headers_mut().insert("origin", o.parse().unwrap());
            }
            tokio_tungstenite::connect_async(req)
        };
        assert!(connect("bad", None).await.is_err());
        assert!(connect(&token, Some("http://evil.example")).await.is_err());

        let (mut ws, _) = connect(&token, None).await.unwrap();
        ws.send(Message::Text(
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": { "protocolVersion": "2025-11-25" } })
            .to_string(),
        ))
        .await
        .unwrap();
        let reply = loop {
            if let Some(Ok(Message::Text(t))) = ws.next().await {
                break serde_json::from_str::<Value>(&t).unwrap();
            }
        };
        assert_eq!(reply["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(b.client_count(), 1);
        b.stop();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Harness manual para validar `tools/claude-ide-probe/probe.mjs` contra o
    /// servidor real sem abrir o app: sobe a ponte com o lock file em
    /// `$FC_PROBE_CONFIG_DIR/ide`, publica um workspace + diagnóstico e fica no
    /// ar por 30s. Ver o README do probe.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn probe_harness() {
        let config = std::env::var("FC_PROBE_CONFIG_DIR").expect("FC_PROBE_CONFIG_DIR");
        let workspace = std::env::var("FC_PROBE_WORKSPACE").expect("FC_PROBE_WORKSPACE");
        let sink = Arc::new(MockSink::default());
        let b = Arc::new(Bridge::new(sink, Some(PathBuf::from(config).join("ide"))));
        let port = b.start().unwrap();
        let file = format!("{workspace}/src/demo.ts");
        b.update_window("main", serde_json::from_value(json!({
            "workspaceFolders": [workspace],
            "focused": true,
            "openEditors": [{ "uri": file_uri(&file), "path": file, "isActive": true,
                              "label": "demo.ts", "languageId": "typescript", "isDirty": false }],
            "diagnostics": [{ "uri": file_uri(&file), "diagnostics": [{ "message": "probe", "severity": "Warning",
                "range": { "start": { "line": 9, "character": 6 }, "end": { "line": 9, "character": 12 } }, "source": "ts" }] }]
        })).unwrap());
        eprintln!("probe harness na porta {port}");
        tokio::time::sleep(Duration::from_secs(30)).await;
        b.stop();
    }

    #[test]
    fn file_uri_handles_posix_and_windows_paths() {
        assert_eq!(file_uri("/home/u/a b.ts"), "file:///home/u/a%20b.ts");
        assert_eq!(file_uri("C:\\w\\a.ts"), "file:///C:/w/a.ts");
        assert!(uri_matches("file:///w/a.ts", "/w/a.ts"));
    }
}
