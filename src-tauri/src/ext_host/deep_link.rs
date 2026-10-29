//! Deep links `fluent-coder://<publisher.extensão>/<caminho>?<query>` →
//! `window.registerUriHandler` da extensão hospedada (equivalente ao
//! `vscode://…` do VS Code; `env.uriScheme` das extensões é `fluent-coder`).
//!
//! - **Registro do esquema:** `tauri-plugin-deep-link` (config em
//!   `tauri.conf.json` → `plugins.deep-link.desktop.schemes`): o bundler grava o
//!   MimeType no `.desktop` (Linux), a chave no registro (Windows) e o
//!   `CFBundleURLTypes` (macOS). No macOS o link chega ao processo em execução
//!   pelo plugin (`on_open_url`).
//! - **Linux/Windows:** o SO abre um NOVO processo com a URL no argv. Sem mudar a
//!   semântica de "abrir o app duas vezes" (não usamos single-instance), o
//!   processo novo só repassa a URL ao que já está rodando por um socket local
//!   (127.0.0.1, porta efêmera, token de 128 bits em arquivo 0600) e sai. Sem
//!   instância rodando, o próprio processo abre e entrega o link quando o
//!   frontend pedir (`deep_link_take_pending`).
//! - O frontend recebe `deep-link://open` e repassa ao host de extensões
//!   (`handleUri`), que ativa a extensão dona da autoridade se preciso.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

pub const SCHEME: &str = "fluent-coder";
pub const OPEN_EVENT: &str = "deep-link://open";
const MAX_URL: usize = 8 * 1024;

/// Valida um deep link e devolve a autoridade (id da extensão, minúsculo).
/// Aceita só `fluent-coder://publisher.nome[/…]`, sem caracteres de controle.
pub fn parse_extension_uri(url: &str) -> Option<String> {
    if url.len() > MAX_URL || url.chars().any(|c| c.is_control() || c == ' ') {
        return None;
    }
    let rest = url.strip_prefix(SCHEME)?.strip_prefix("://")?;
    let authority = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    let (publisher, name) = authority.split_once('.')?;
    let ok = |s: &str| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    // `name` pode conter pontos? No marketplace não; recusamos para simplificar.
    (ok(publisher) && ok(name)).then_some(authority)
}

/// Primeiro argumento que é um deep link nosso (Linux/Windows passam no argv).
pub fn url_from_args(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| a.starts_with(&format!("{SCHEME}:")))
        .cloned()
}

/// Pasta de dados do app sem precisar do runtime do Tauri (o forward acontece
/// antes de construir o app). Mesmo identificador do `tauri.conf.json`.
pub fn data_dir_without_tauri() -> Option<PathBuf> {
    const ID: &str = "com.fluentcoder.app";
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join(ID))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support").join(ID))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .map(|d| d.join(ID))
    }
}

fn endpoint_file(dir: &Path) -> PathBuf {
    dir.join("deep-link.json")
}

/// Tenta entregar `url` à instância já aberta. `true` = entregue (sair).
pub fn forward_to_running(url: &str) -> bool {
    let Some(dir) = data_dir_without_tauri() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(endpoint_file(&dir)) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let (Some(port), Some(token)) = (v["port"].as_u64(), v["token"].as_str()) else {
        return false;
    };
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port as u16));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(format!("{token}\n{url}\n").as_bytes()).is_err() {
        return false;
    }
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).is_ok() && reply.trim() == "ok"
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Default)]
pub struct DeepLinkState {
    pending: Mutex<Vec<String>>,
}

impl DeepLinkState {
    pub fn new(initial: Option<String>) -> Self {
        let s = Self::default();
        if let Some(u) = initial.filter(|u| parse_extension_uri(u).is_some()) {
            s.pending.lock().unwrap().push(u);
        }
        s
    }
}

/// Entrega um link: evento para as janelas + fila para quem ainda não montou.
pub fn deliver(app: &AppHandle, url: &str) {
    if parse_extension_uri(url).is_none() {
        eprintln!("[deep-link] recusado: {url}");
        return;
    }
    if let Some(st) = app.try_state::<DeepLinkState>() {
        if let Ok(mut p) = st.pending.lock() {
            p.push(url.to_string());
        }
    }
    let _ = app.emit(OPEN_EVENT, url.to_string());
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Servidor local que recebe links repassados por processos novos.
pub fn start_receiver(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else {
        return;
    };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else {
        return;
    };
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        return;
    }
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let content = serde_json::json!({ "port": port, "token": token, "pid": std::process::id() });
    if write_private(&endpoint_file(&dir), &content.to_string()).is_err() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut reader = BufReader::new(match stream.try_clone() {
                Ok(s) => s,
                Err(_) => continue,
            });
            let (mut got_token, mut url) = (String::new(), String::new());
            if reader.read_line(&mut got_token).is_err() || reader.read_line(&mut url).is_err() {
                continue;
            }
            let mut stream = stream;
            if !constant_time_eq(got_token.trim().as_bytes(), token.as_bytes()) {
                let _ = stream.write_all(b"denied\n");
                continue;
            }
            let url = url.trim().to_string();
            let ok = parse_extension_uri(&url).is_some();
            let _ = stream.write_all(if ok { b"ok\n" } else { b"invalid\n" });
            if ok {
                deliver(&app, &url);
            }
        }
    });
}

/// Remove o arquivo do endpoint ao sair (só se ainda for o nosso).
pub fn cleanup(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let file = endpoint_file(&dir);
        if let Ok(raw) = std::fs::read_to_string(&file) {
            if raw.contains(&format!("\"pid\":{}", std::process::id())) {
                let _ = std::fs::remove_file(file);
            }
        }
    }
}

fn write_private(path: &Path, content: &str) -> std::io::Result<()> {
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
    let mut f = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    f.write_all(content.as_bytes())
}

/// Links que chegaram antes de o frontend montar (cold start) — e os já
/// entregues por evento, para a janela que montou depois. Esvazia a fila.
#[tauri::command]
pub fn deep_link_take_pending(state: tauri::State<'_, DeepLinkState>) -> Vec<String> {
    state.pending.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default()
}

/// O frontend tratou um link recebido por evento: tira da fila.
#[tauri::command]
pub fn deep_link_ack(url: String, state: tauri::State<'_, DeepLinkState>) {
    if let Ok(mut p) = state.pending.lock() {
        if let Some(i) = p.iter().position(|u| *u == url) {
            p.remove(i);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_extension_links_are_accepted() {
        assert_eq!(
            parse_extension_uri("fluent-coder://openai.chatgpt/connector/oauth_callback?code=1"),
            Some("openai.chatgpt".into())
        );
        assert_eq!(parse_extension_uri("fluent-coder://Anthropic.Claude-Code/open"), Some("anthropic.claude-code".into()));
        assert_eq!(parse_extension_uri("vscode://openai.chatgpt/x"), None);
        assert_eq!(parse_extension_uri("fluent-coder://noperiod/x"), None);
        assert_eq!(parse_extension_uri("fluent-coder://a.b/x\ny"), None);
        assert_eq!(parse_extension_uri("fluent-coder://a.b.c/x"), None);
        assert_eq!(parse_extension_uri("fluent-coder:/a.b"), None);
        assert_eq!(parse_extension_uri(&format!("fluent-coder://a.b/{}", "x".repeat(MAX_URL))), None);
    }

    #[test]
    fn url_is_found_in_argv() {
        let args = vec!["app".to_string(), "--flag".into(), "fluent-coder://a.b/c".into()];
        assert_eq!(url_from_args(&args).as_deref(), Some("fluent-coder://a.b/c"));
        assert_eq!(url_from_args(&["fluent-coder://a.b".to_string()]), None, "argv[0] é o executável");
    }

    #[test]
    fn token_compare() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
