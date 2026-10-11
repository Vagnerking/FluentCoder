//! Capacidades de CLIENTE do ACP (Agent Client Protocol) que o Fluent Coder
//! oferece aos agentes: `fs/read_text_file`, `fs/write_text_file` e
//! `terminal/*` (create/output/wait_for_exit/kill/release) — spec em
//! agentclientprotocol.com/protocol/file-system e /terminals.
//!
//! - **Arquivos** vêm dos buffers abertos no Monaco (o agente vê edições não
//!   salvas) e as escritas em arquivo aberto entram como edição DESFAZÍVEL no
//!   modelo + salvar do app. A janela responde pelo evento
//!   `acp-client://request` → `acp_client_respond`
//!   (`src/agents/acpClientServices.ts`); arquivo fechado (ou sem janela) =
//!   disco. Escrita só DENTRO do workspace da sessão; caminhos sempre absolutos.
//! - **Terminais** são PTYs reais (portable-pty): a saída fica num buffer com
//!   `outputByteLimit` (corte no começo, em fronteira de caractere) e, com o app
//!   no ar, o PTY aparece como aba "somente leitura" do painel de terminais
//!   (`acp-terminal://created` + `term-data` com `seq`), que continua visível
//!   depois do `release`.
//!
//! Os pedidos do agente chegam no meio de uma chamada (ex.: `session/prompt`)
//! e são atendidos em tarefas próprias: `wait_for_exit` não trava a conexão.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch};

/// Teto padrão da saída retida de um terminal sem `outputByteLimit`.
const DEFAULT_OUTPUT_LIMIT: usize = 1024 * 1024;
/// Quanto esperar as janelas responderem sobre um buffer aberto.
const WINDOW_TIMEOUT: Duration = Duration::from_millis(1500);

// ---------------------------------------------------------------------------
// Ponte com as janelas (buffers do Monaco)
// ---------------------------------------------------------------------------

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Liga os serviços ao app (setup do Tauri). Sem isso (testes), só disco.
pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

#[derive(Default)]
struct Broker {
    next: AtomicU64,
    pending: Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>,
    /// Janelas com o atendente montado (`acp_client_register`).
    windows: Mutex<HashSet<String>>,
}

fn broker() -> &'static Broker {
    static B: OnceLock<Broker> = OnceLock::new();
    B.get_or_init(Broker::default)
}

/// A janela montou (ou desmontou) o atendente de buffers.
#[tauri::command]
pub fn acp_client_register(window: tauri::Window, active: bool) {
    let mut set = broker().windows.lock().unwrap_or_else(|e| e.into_inner());
    if active {
        set.insert(window.label().to_string());
    } else {
        set.remove(window.label());
    }
}

/// Resposta de uma janela a `acp-client://request`.
#[tauri::command]
pub fn acp_client_respond(id: String, result: Value) {
    let tx = broker().pending.lock().ok().and_then(|p| p.get(&id).cloned());
    if let Some(tx) = tx {
        let _ = tx.send(result);
    }
}

/// Pergunta às janelas; para na primeira resposta que `done` aceita, quando
/// todas responderam ou no tempo limite.
async fn ask_windows(op: &str, payload: Value, done: impl Fn(&Value) -> bool) -> Vec<Value> {
    let Some(app) = APP.get() else { return vec![] };
    let expected = broker().windows.lock().map(|w| w.len()).unwrap_or(0);
    if expected == 0 {
        return vec![];
    }
    let id = format!("acp-fs-{}", broker().next.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::unbounded_channel();
    if let Ok(mut p) = broker().pending.lock() {
        p.insert(id.clone(), tx);
    }
    let mut body = json!({ "id": id, "op": op });
    if let (Some(obj), Some(extra)) = (body.as_object_mut(), payload.as_object()) {
        for (k, v) in extra {
            obj.insert(k.clone(), v.clone());
        }
    }
    let _ = app.emit("acp-client://request", body);
    let mut out = Vec::new();
    let deadline = tokio::time::sleep(WINDOW_TIMEOUT);
    tokio::pin!(deadline);
    while out.len() < expected {
        tokio::select! {
            _ = &mut deadline => break,
            v = rx.recv() => match v {
                Some(v) => {
                    let stop = done(&v);
                    out.push(v);
                    if stop { break; }
                }
                None => break,
            },
        }
    }
    if let Ok(mut p) = broker().pending.lock() {
        p.remove(&id);
    }
    out
}

// ---------------------------------------------------------------------------
// Serviços por conexão ACP
// ---------------------------------------------------------------------------

/// Erro JSON-RPC devolvido ao agente.
#[derive(Debug, PartialEq)]
pub(crate) struct RpcError {
    pub code: i64,
    pub message: String,
}

fn err(code: i64, message: impl Into<String>) -> RpcError {
    RpcError { code, message: message.into() }
}

fn invalid(message: impl Into<String>) -> RpcError {
    err(-32602, message)
}

#[derive(Clone)]
pub(crate) struct ClientServices {
    root: PathBuf,
    terminals: Arc<Mutex<HashMap<String, Arc<AcpTerminal>>>>,
}

/// Normaliza `.`/`..` sem tocar no disco (o arquivo pode não existir ainda).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Caminho absoluto do pedido (o protocolo exige absolutos).
fn absolute(params: &Value) -> Result<PathBuf, RpcError> {
    let raw = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("`path` ausente"))?;
    if raw.contains('\0') {
        return Err(invalid("`path` inválido"));
    }
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(invalid("`path` precisa ser absoluto"));
    }
    Ok(normalize(p))
}

/// `line` (1-based) e `limit` (linhas) do `fs/read_text_file`.
pub(crate) fn slice_lines(text: &str, line: Option<u64>, limit: Option<u64>) -> String {
    if line.is_none() && limit.is_none() {
        return text.to_string();
    }
    let start = line.unwrap_or(1).max(1) as usize - 1;
    let take = limit.map(|l| l as usize).unwrap_or(usize::MAX);
    text.split_inclusive('\n').skip(start).take(take).collect()
}

impl ClientServices {
    pub(crate) fn new(root: &Path) -> Self {
        Self {
            root: normalize(root),
            terminals: Arc::default(),
        }
    }

    /// Capacidades anunciadas no `initialize`.
    pub(crate) fn capabilities() -> Value {
        json!({ "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": true })
    }

    /// Métodos que este cliente atende (o resto: "não suportado").
    pub(crate) fn handles(method: &str) -> bool {
        matches!(
            method,
            "fs/read_text_file"
                | "fs/write_text_file"
                | "terminal/create"
                | "terminal/output"
                | "terminal/wait_for_exit"
                | "terminal/kill"
                | "terminal/release"
        )
    }

    pub(crate) async fn handle(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        match method {
            "fs/read_text_file" => self.read_text_file(params).await,
            "fs/write_text_file" => self.write_text_file(params).await,
            "terminal/create" => self.terminal_create(params),
            "terminal/output" => self.terminal(params).map(|t| t.output_json()),
            "terminal/wait_for_exit" => {
                let t = self.terminal(params)?;
                Ok(t.wait_for_exit().await)
            }
            "terminal/kill" => {
                self.terminal(params)?.kill();
                Ok(json!({}))
            }
            "terminal/release" => {
                let id = params.get("terminalId").and_then(Value::as_str).unwrap_or_default();
                let t = self
                    .terminals
                    .lock()
                    .ok()
                    .and_then(|mut m| m.remove(id))
                    .ok_or_else(|| invalid(format!("terminal desconhecido: {id}")))?;
                t.kill();
                // A aba do painel continua mostrando a saída; o snapshot sai.
                if let Ok(mut m) = ui_terminals().lock() {
                    m.remove(id);
                }
                Ok(json!({}))
            }
            _ => Err(err(-32601, format!("Método não suportado pelo Fluent Coder: {method}"))),
        }
    }

    async fn read_text_file(&self, params: &Value) -> Result<Value, RpcError> {
        let path = absolute(params)?;
        let path_str = path.to_string_lossy().into_owned();
        let answers = ask_windows("read", json!({ "path": path_str }), |v| {
            v.get("open").and_then(Value::as_bool) == Some(true)
        })
        .await;
        let from_buffer = answers.iter().find_map(|v| {
            (v.get("open").and_then(Value::as_bool) == Some(true))
                .then(|| v.get("content").and_then(Value::as_str).map(str::to_string))
                .flatten()
        });
        let text = match from_buffer {
            Some(t) => t,
            None => tokio::fs::read_to_string(&path)
                .await
                .map_err(|e| err(-32002, format!("Não foi possível ler {path_str}: {e}")))?,
        };
        let line = params.get("line").and_then(Value::as_u64);
        let limit = params.get("limit").and_then(Value::as_u64);
        Ok(json!({ "content": slice_lines(&text, line, limit) }))
    }

    async fn write_text_file(&self, params: &Value) -> Result<Value, RpcError> {
        let path = absolute(params)?;
        let content = params
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("`content` ausente"))?;
        if !path.starts_with(&self.root) || path == self.root {
            return Err(err(-32000, format!("Escrita fora do workspace recusada: {}", path.display())));
        }
        let path_str = path.to_string_lossy().into_owned();
        // Arquivo aberto: a(s) janela(s) aplicam no modelo (undo) e salvam.
        let answers = ask_windows("write", json!({ "path": path_str, "content": content }), |_| false).await;
        if answers.iter().any(|v| v.get("applied").and_then(Value::as_bool) == Some(true)) {
            return Ok(json!({}));
        }
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| err(-32603, format!("Não foi possível criar {}: {e}", parent.display())))?;
        }
        tokio::fs::write(&path, content)
            .await
            .map_err(|e| err(-32603, format!("Não foi possível gravar {path_str}: {e}")))?;
        if let Some(app) = APP.get() {
            let _ = app.emit("acp-client://written", json!({ "path": path_str }));
        }
        Ok(json!({}))
    }

    fn terminal(&self, params: &Value) -> Result<Arc<AcpTerminal>, RpcError> {
        let id = params.get("terminalId").and_then(Value::as_str).unwrap_or_default();
        self.terminals
            .lock()
            .ok()
            .and_then(|m| m.get(id).cloned())
            .ok_or_else(|| invalid(format!("terminal desconhecido: {id}")))
    }

    fn terminal_create(&self, params: &Value) -> Result<Value, RpcError> {
        let command = params
            .get("command")
            .and_then(Value::as_str)
            .filter(|c| !c.trim().is_empty())
            .ok_or_else(|| invalid("`command` ausente"))?;
        let args: Vec<String> = params
            .get("args")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let env: Vec<(String, String)> = params
            .get("env")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|e| Some((e.get("name")?.as_str()?.to_string(), e.get("value")?.as_str()?.to_string())))
                    .filter(|(k, v)| !k.is_empty() && !k.contains('=') && !k.contains('\0') && !v.contains('\0'))
                    .collect()
            })
            .unwrap_or_default();
        let cwd = match params.get("cwd").and_then(Value::as_str) {
            Some(c) if Path::new(c).is_absolute() => PathBuf::from(c),
            Some(_) => return Err(invalid("`cwd` precisa ser absoluto")),
            None => self.root.clone(),
        };
        let limit = params
            .get("outputByteLimit")
            .and_then(Value::as_u64)
            .map(|l| l as usize)
            .unwrap_or(DEFAULT_OUTPUT_LIMIT);
        let term = AcpTerminal::spawn(command, &args, &env, &cwd, limit).map_err(|e| err(-32603, e))?;
        let id = term.id.clone();
        if let Ok(mut m) = self.terminals.lock() {
            m.insert(id.clone(), term);
        }
        Ok(json!({ "terminalId": id }))
    }

    /// Conexão encerrada: mata o que ainda roda.
    pub(crate) fn shutdown(&self) {
        if let Ok(mut m) = self.terminals.lock() {
            for (_, t) in m.drain() {
                t.kill();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Terminal ACP (PTY real)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ExitInfo {
    pub code: Option<u32>,
    pub signal: Option<String>,
}

struct Capture {
    /// Saída crua retida (com o corte do `outputByteLimit`).
    buf: String,
    truncated: bool,
    limit: usize,
    /// Bytes recebidos desde o início (o `seq` dos eventos `term-data`).
    total: u64,
}

impl Capture {
    fn push(&mut self, text: &str) {
        self.total += text.len() as u64;
        self.buf.push_str(text);
        if self.buf.len() > self.limit {
            // Corta do começo, numa fronteira de caractere.
            let mut cut = self.buf.len() - self.limit;
            while !self.buf.is_char_boundary(cut) {
                cut += 1;
            }
            self.buf.drain(..cut);
            self.truncated = true;
        }
    }
}

pub(crate) struct AcpTerminal {
    id: String,
    capture: Mutex<Capture>,
    exit: watch::Receiver<Option<ExitInfo>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// O master do PTY precisa viver enquanto o processo roda (sem o painel,
    /// fica aqui; com o painel, no `TerminalState`).
    master: Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
}

static NEXT_TERMINAL: AtomicU64 = AtomicU64::new(1);

/// Terminais vivos para o painel pedir o que já saiu (`acp_terminal_snapshot`).
fn ui_terminals() -> &'static Mutex<HashMap<String, Arc<AcpTerminal>>> {
    static T: OnceLock<Mutex<HashMap<String, Arc<AcpTerminal>>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// Saída já capturada de um terminal ACP (o painel monta depois do 1º byte).
#[tauri::command]
pub fn acp_terminal_snapshot(id: String) -> Option<Value> {
    let t = ui_terminals().lock().ok()?.get(&id).cloned()?;
    let c = t.capture.lock().ok()?;
    Some(json!({ "text": c.buf, "seq": c.total }))
}

/// Sem barra no meio e não encontrado no PATH ⇒ é uma linha de shell
/// ("npm test"): roda pelo shell, como os agentes esperam.
fn command_for(command: &str, args: &[String]) -> CommandBuilder {
    let is_line = args.is_empty() && command.contains(char::is_whitespace) && which::which(command).is_err();
    if is_line {
        // `cmd.exe /C` no Windows, `/bin/sh -c` no Unix (adaptador de plataforma).
        let inv = crate::platform::current().shell_line(command);
        let mut c = CommandBuilder::new(&inv.program);
        c.args(&inv.args);
        return c;
    }
    let mut c = CommandBuilder::new(command);
    c.args(args);
    c
}

impl AcpTerminal {
    fn spawn(command: &str, args: &[String], env: &[(String, String)], cwd: &Path, limit: usize) -> Result<Arc<Self>, String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("Não foi possível abrir o terminal: {e}"))?;
        let mut cmd = command_for(command, args);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Não foi possível executar `{command}`: {e}"))?;
        drop(pair.slave);
        let id = format!("acp-term-{}", NEXT_TERMINAL.fetch_add(1, Ordering::Relaxed));
        let (exit_tx, exit_rx) = watch::channel(None);
        let term = Arc::new(AcpTerminal {
            id: id.clone(),
            capture: Mutex::new(Capture { buf: String::new(), truncated: false, limit: limit.max(1), total: 0 }),
            exit: exit_rx,
            killer: Mutex::new(child.clone_killer()),
            master: Mutex::new(None),
        });
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let app = APP.get().cloned();
        if let Some(app) = &app {
            // Aba no painel de terminais (o usuário vê e pode digitar/fechar).
            if let Ok(writer) = pair.master.take_writer() {
                app.state::<crate::terminal::TerminalState>()
                    .insert_external(id.clone(), writer, pair.master, child.clone_killer());
            }
            if let Ok(mut m) = ui_terminals().lock() {
                m.insert(id.clone(), Arc::clone(&term));
            }
            let title = std::iter::once(command.to_string()).chain(args.iter().cloned()).collect::<Vec<_>>().join(" ");
            let _ = app.emit("acp-terminal://created", json!({ "id": id, "name": title, "cwd": cwd }));
        } else if let Ok(mut m) = term.master.lock() {
            *m = Some(pair.master);
        }
        // Espera o processo (código de saída / sinal).
        std::thread::spawn(move || {
            let info = match child.wait() {
                Ok(status) => {
                    let signal = status.signal().map(str::to_string);
                    ExitInfo { code: if signal.is_some() { None } else { Some(status.exit_code()) }, signal }
                }
                Err(_) => ExitInfo { code: None, signal: None },
            };
            let _ = exit_tx.send(Some(info));
        });
        // Lê a saída: buffer do agente + eventos do painel.
        let reader_term = Arc::clone(&term);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        carry.extend_from_slice(&buf[..n]);
                        // Só bytes UTF-8 completos (um caractere pode vir partido).
                        let valid = match std::str::from_utf8(&carry) {
                            Ok(_) => carry.len(),
                            Err(e) if e.error_len().is_none() => e.valid_up_to(),
                            Err(_) => carry.len(),
                        };
                        let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                        carry.drain(..valid);
                        let seq = match reader_term.capture.lock() {
                            Ok(mut c) => {
                                c.push(&text);
                                c.total
                            }
                            Err(_) => 0,
                        };
                        if let Some(app) = &app {
                            let _ = app.emit("term-data", json!({ "id": reader_term.id, "data": text, "seq": seq }));
                        }
                    }
                }
            }
            if let Some(app) = &app {
                // Código de saída para a aba (espera curta pelo `wait`).
                let mut rx = reader_term.exit.clone();
                let code = tauri::async_runtime::block_on(async {
                    let _ = tokio::time::timeout(Duration::from_secs(2), rx.wait_for(|v| v.is_some())).await;
                    rx.borrow().as_ref().and_then(|i| i.code)
                });
                let _ = app.emit("term-exit", json!({ "id": reader_term.id, "code": code }));
            }
        });
        Ok(term)
    }

    fn exit_status(&self) -> Option<ExitInfo> {
        self.exit.borrow().clone()
    }

    fn output_json(&self) -> Value {
        let (text, truncated) = match self.capture.lock() {
            Ok(c) => (c.buf.clone(), c.truncated),
            Err(_) => (String::new(), false),
        };
        let mut out = json!({ "output": clean_output(&text), "truncated": truncated });
        if let Some(info) = self.exit_status() {
            out["exitStatus"] = json!({ "exitCode": info.code, "signal": info.signal });
        }
        out
    }

    async fn wait_for_exit(&self) -> Value {
        let mut rx = self.exit.clone();
        let _ = rx.wait_for(|v| v.is_some()).await;
        let info = rx.borrow().clone().unwrap_or(ExitInfo { code: None, signal: None });
        json!({ "exitCode": info.code, "signal": info.signal })
    }

    fn kill(&self) {
        if self.exit_status().is_some() {
            return;
        }
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}

/// Saída para o agente: sem sequências ANSI/OSC e com `\n` no lugar de `\r\n`.
pub(crate) fn clean_output(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    // CSI: parâmetros/intermediários até o byte final (@..~).
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    // OSC: até BEL ou ST (ESC \).
                    while let Some(n) = chars.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                continue;
            }
            out.push('\n');
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slices_lines_one_based() {
        let t = "a\nb\nc\nd";
        assert_eq!(slice_lines(t, None, None), t);
        assert_eq!(slice_lines(t, Some(2), Some(2)), "b\nc\n");
        assert_eq!(slice_lines(t, Some(4), None), "d");
        assert_eq!(slice_lines(t, None, Some(1)), "a\n");
        assert_eq!(slice_lines(t, Some(9), None), "");
    }

    #[test]
    fn cleans_terminal_output_for_the_agent() {
        assert_eq!(clean_output("\x1b[31mERRO\x1b[0m\r\nok\r\n"), "ERRO\nok\n");
        assert_eq!(clean_output("\x1b]0;título\x07x\x1b]633;D;0\x1b\\y"), "xy");
    }

    #[test]
    fn capture_truncates_from_the_start_on_char_boundary() {
        let mut c = Capture { buf: String::new(), truncated: false, limit: 5, total: 0 };
        c.push("abc");
        assert!(!c.truncated);
        c.push("déf"); // "abcdéf" = 7 bytes
        assert!(c.truncated);
        assert!(c.buf.len() <= 5);
        assert!(c.buf.ends_with("déf"));
        assert_eq!(c.total, 7);
    }

    #[tokio::test]
    async fn fs_reads_slices_and_writes_only_inside_the_workspace() {
        let root = std::env::temp_dir().join(format!("fluent-acp-fs-{}", NEXT_TERMINAL.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&root).unwrap();
        let svc = ClientServices::new(&root);
        let file = root.join("sub").join("a.txt");
        let ok = svc
            .handle("fs/write_text_file", &json!({ "sessionId": "s", "path": file, "content": "1\n2\n3\n" }))
            .await
            .unwrap();
        assert_eq!(ok, json!({}));
        let r = svc
            .handle("fs/read_text_file", &json!({ "sessionId": "s", "path": file, "line": 2, "limit": 1 }))
            .await
            .unwrap();
        assert_eq!(r["content"], "2\n");
        let outside = svc
            .handle("fs/write_text_file", &json!({ "sessionId": "s", "path": root.join("..").join("fora.txt"), "content": "x" }))
            .await
            .unwrap_err();
        assert_eq!(outside.code, -32000);
        let relative = svc.handle("fs/read_text_file", &json!({ "path": "rel.txt" })).await.unwrap_err();
        assert_eq!(relative.code, -32602);
        let missing = svc.handle("fs/read_text_file", &json!({ "path": root.join("nao-existe") })).await.unwrap_err();
        assert_eq!(missing.code, -32002);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn terminal_runs_captures_waits_and_releases() {
        let root = std::env::temp_dir();
        let svc = ClientServices::new(&root);
        let created = svc
            .handle(
                "terminal/create",
                &json!({ "sessionId": "s", "command": "/bin/sh", "args": ["-c", "printf 'oi\\n'; exit 3"], "env": [{ "name": "FOO", "value": "bar" }], "outputByteLimit": 1000 }),
            )
            .await
            .unwrap();
        let id = created["terminalId"].as_str().unwrap().to_string();
        let exit = svc.handle("terminal/wait_for_exit", &json!({ "terminalId": id })).await.unwrap();
        assert_eq!(exit, json!({ "exitCode": 3, "signal": null }));
        // A saída pode chegar logo depois do fim do processo.
        let mut out = Value::Null;
        for _ in 0..50 {
            out = svc.handle("terminal/output", &json!({ "terminalId": id })).await.unwrap();
            if out["output"].as_str().unwrap_or_default().contains("oi") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(out["output"].as_str().unwrap().contains("oi\n"), "{out}");
        assert_eq!(out["truncated"], false);
        assert_eq!(out["exitStatus"]["exitCode"], 3);
        assert_eq!(svc.handle("terminal/release", &json!({ "terminalId": id })).await.unwrap(), json!({}));
        assert!(svc.handle("terminal/output", &json!({ "terminalId": id })).await.is_err());

        // Linha de shell num só `command`, e kill de algo que não termina sozinho.
        let t = svc.handle("terminal/create", &json!({ "command": "sleep 30" })).await.unwrap();
        let id = t["terminalId"].as_str().unwrap().to_string();
        svc.handle("terminal/kill", &json!({ "terminalId": id })).await.unwrap();
        let exit = tokio::time::timeout(Duration::from_secs(5), svc.handle("terminal/wait_for_exit", &json!({ "terminalId": id })))
            .await
            .expect("kill encerra o processo")
            .unwrap();
        assert!(exit["exitCode"].is_null() || exit["exitCode"] != json!(0), "{exit}");
        svc.handle("terminal/release", &json!({ "terminalId": id })).await.unwrap();
        svc.shutdown();
    }
}
