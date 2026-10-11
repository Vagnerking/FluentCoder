//! Adaptadores de plataforma (Windows / Linux / macOS).
//!
//! Tudo o que muda de SO para SO passa por aqui, em vez de `#[cfg]` espalhado
//! pelos módulos: revelar no gerenciador de arquivos, abrir URL/caminho no app
//! do sistema, shell padrão, linha de comando de shell, matar árvore de
//! processos, lixeira, caminhos de dados e o RID dos pacotes .NET.
//!
//! Desenho:
//! - `trait Platform` descreve o comportamento; `windows.rs`, `linux.rs` e
//!   `macos.rs` o implementam. As três impls compilam em QUALQUER alvo (elas só
//!   montam planos de execução e resolvem regras puras), o que deixa cada uma
//!   testável no CI de qualquer SO. Só `current()` escolhe por `cfg`.
//! - Efeitos colaterais (spawn de processo) passam por `CommandRunner`, que nos
//!   testes é trocado por um fake que só registra o argv.
//! - `commands.rs` expõe tudo ao front como comandos Tauri `async` (nunca na
//!   main thread).

pub mod commands;
pub mod linux;
pub mod macos;
pub mod process;
pub mod windows;

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Sistema operacional alvo, no vocabulário do front (`src/platform`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Windows,
    Macos,
    Linux,
}

impl Os {
    /// SO deste binário (decidido em tempo de compilação).
    pub const fn host() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Macos
        } else {
            Os::Linux
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Os::Windows => "windows",
            Os::Macos => "macos",
            Os::Linux => "linux",
        }
    }
}

/// Uma invocação de processo de um plano de execução.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
    /// `true`: espera o processo e usa o código de saída para decidir se o
    /// plano terminou (senão tenta o próximo passo). `false`: dispara e
    /// considera sucesso se o spawn funcionou (o filho é colhido em background).
    pub wait: bool,
}

impl Invocation {
    pub fn spawn(program: &str, args: &[&str]) -> Self {
        Invocation {
            program: program.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            wait: false,
        }
    }
    pub fn wait(program: &str, args: &[&str]) -> Self {
        Invocation {
            wait: true,
            ..Invocation::spawn(program, args)
        }
    }
}

/// Shell resolvido para o terminal integrado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpec {
    pub program: String,
    /// Argumentos do modo interativo (ex.: `-l` para login shell no Unix).
    pub args: Vec<String>,
    /// `powershell` | `posix` — decide como rodar uma linha de comando.
    pub kind: ShellKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Powershell,
    Posix,
}

/// O que o ambiente oferece para resolver o shell (injetável nos testes).
pub struct ShellEnv<'a> {
    /// `$SHELL` (Unix) ou `COMSPEC` (Windows), quando definidos.
    pub shell_var: Option<String>,
    /// Resolve um executável no PATH.
    pub which: &'a dyn Fn(&str) -> Option<PathBuf>,
}

/// Recursos que o front consulta para decidir UI (botões de janela, Snap…).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// O app desenha minimizar/maximizar/fechar (falso no macOS: semáforos nativos).
    pub custom_caption_buttons: bool,
    /// Snap Layouts do Windows 11 no botão maximizar.
    pub snap_layouts: bool,
    /// Backdrop Mica.
    pub mica: bool,
    /// Sistema de arquivos padrão não diferencia maiúsculas (Windows, APFS).
    pub paths_case_insensitive: bool,
    /// Menu nativo do app (macOS).
    pub native_menu: bool,
}

/// Snapshot serializado uma vez para o front (`window.__FLUENT_PLATFORM__`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: Os,
    pub arch: &'static str,
    pub family: &'static str,
    /// `XDG_CURRENT_DESKTOP` no Linux (GNOME, KDE…).
    pub desktop: Option<String>,
    pub wayland: bool,
    pub capabilities: Capabilities,
}

/// Comportamento por SO. As impls são puras: devolvem planos/valores, e quem
/// executa é `CommandRunner`.
pub trait Platform: Send + Sync {
    fn os(&self) -> Os;
    fn capabilities(&self) -> Capabilities;
    /// Plano para abrir o gerenciador de arquivos com `path` selecionado.
    fn reveal_plan(&self, path: &Path) -> Vec<Invocation>;
    /// Plano para abrir uma URL (http/https/mailto) ou um caminho no app padrão.
    fn open_plan(&self, target: &str) -> Vec<Invocation>;
    /// Shell padrão do terminal integrado.
    fn default_shell(&self, env: &ShellEnv) -> ShellSpec;
    /// Como rodar UMA linha de comando no shell do sistema (`cmd /C`, `sh -c`).
    fn shell_line(&self, line: &str) -> Invocation;
    /// Nome do executável (`dotnet` → `dotnet.exe` no Windows).
    fn exe_name(&self, base: &str) -> String;
    /// Diretório de dados do usuário (APPDATA, Application Support, XDG).
    fn user_data_dir(&self, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf>;
    /// Diretório home do usuário.
    fn home_dir(&self, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf>;
}

/// A impl deste binário.
pub fn current() -> &'static dyn Platform {
    for_os(Os::host())
}

/// A impl de um SO qualquer (os testes usam para exercitar as três).
pub fn for_os(os: Os) -> &'static dyn Platform {
    match os {
        Os::Windows => &windows::WindowsPlatform,
        Os::Macos => &macos::MacPlatform,
        Os::Linux => &linux::LinuxPlatform,
    }
}

pub fn info() -> PlatformInfo {
    let p = current();
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    PlatformInfo {
        os: p.os(),
        arch: std::env::consts::ARCH,
        family: std::env::consts::FAMILY,
        desktop: if p.os() == Os::Linux { env("XDG_CURRENT_DESKTOP") } else { None },
        wayland: p.os() == Os::Linux && (env("WAYLAND_DISPLAY").is_some() || env("XDG_SESSION_TYPE").as_deref() == Some("wayland")),
        capabilities: p.capabilities(),
    }
}

/// Script injetado em toda webview antes do primeiro paint: o front lê o SO
/// daqui (síncrono), sem depender de `navigator.platform` (deprecado).
pub fn init_script() -> String {
    let json = serde_json::to_string(&info()).unwrap_or_else(|_| "null".into());
    format!("window.__FLUENT_PLATFORM__ = Object.freeze({json});")
}

/// Plugin Tauri que só registra o `init_script` (vale para todas as janelas,
/// inclusive as criadas em runtime).
pub fn init_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("fluent-platform")
        .js_init_script(init_script())
        .build()
}

// ---------------------------------------------------------------- execução ---

/// Executor de processos (trocado por um fake nos testes).
pub trait CommandRunner {
    /// Dispara sem esperar. `Err` se o executável não pôde ser iniciado.
    fn spawn(&self, inv: &Invocation) -> Result<(), String>;
    /// Espera terminar (com teto). `Ok(true)` = saiu com sucesso.
    fn run(&self, inv: &Invocation, timeout: Duration) -> Result<bool, String>;
}

/// Executor real: stdio nulo, sem janela de console no Windows, filhos sempre
/// colhidos (nada de zumbi).
pub struct SystemRunner;

impl CommandRunner for SystemRunner {
    fn spawn(&self, inv: &Invocation) -> Result<(), String> {
        let mut child = system_command(inv)
            .spawn()
            .map_err(|e| format!("{}: {e}", inv.program))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }

    fn run(&self, inv: &Invocation, timeout: Duration) -> Result<bool, String> {
        let mut child = system_command(inv)
            .spawn()
            .map_err(|e| format!("{}: {e}", inv.program))?;
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Ok(status.success()),
                Ok(None) if started.elapsed() >= timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(false);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => return Err(e.to_string()),
            }
        }
    }
}

fn system_command(inv: &Invocation) -> std::process::Command {
    let mut cmd = std::process::Command::new(&inv.program);
    cmd.args(&inv.args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::child_process::hide_console_window(&mut cmd);
    cmd
}

/// Executa um plano: o primeiro passo que funcionar encerra. Passos `wait`
/// usam o código de saída; passos `spawn`, o sucesso do spawn.
pub fn execute_plan(plan: &[Invocation], runner: &dyn CommandRunner) -> Result<(), String> {
    let mut last = String::from("nenhum comando disponível");
    for inv in plan {
        let ok = if inv.wait {
            runner.run(inv, Duration::from_secs(5))
        } else {
            runner.spawn(inv).map(|_| true)
        };
        match ok {
            Ok(true) => return Ok(()),
            Ok(false) => last = format!("{} terminou com erro", inv.program),
            Err(e) => last = e,
        }
    }
    Err(last)
}

// ------------------------------------------------------------- operações ---

/// Abre o gerenciador de arquivos do SO com `path` selecionado.
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    execute_plan(&current().reveal_plan(path), &SystemRunner)
        .map_err(|e| format!("Não foi possível revelar o item no gerenciador de arquivos: {e}"))
}

/// Só http(s)/mailto saem para o navegador/cliente de e-mail do sistema.
pub fn is_safe_external_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        && !url.chars().any(|c| c.is_control())
}

/// Abre uma URL no navegador do sistema (nunca numa webview do app).
pub fn open_external_url(url: &str) -> Result<(), String> {
    if !is_safe_external_url(url) {
        return Err(format!("URL externa recusada: {url}"));
    }
    execute_plan(&current().open_plan(url.trim()), &SystemRunner).map_err(|e| format!("Falha ao abrir {url}: {e}"))
}

/// Abre um caminho local existente no app padrão do sistema.
pub fn open_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Caminho não encontrado: {}", path.display()));
    }
    let target = path.to_string_lossy().to_string();
    execute_plan(&current().open_plan(&target), &SystemRunner)
        .map_err(|e| format!("Falha ao abrir {}: {e}", path.display()))
}

/// Move para a lixeira do SO (recuperável).
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| format!("Não foi possível mover para a Lixeira: {e}"))
}

/// Shell padrão resolvido com o ambiente real.
pub fn default_shell() -> ShellSpec {
    let which = |name: &str| which::which(name).ok();
    let var = if current().os() == Os::Windows { "COMSPEC" } else { "SHELL" };
    current().default_shell(&ShellEnv {
        shell_var: std::env::var(var).ok().filter(|s| !s.trim().is_empty()),
        which: &which,
    })
}

/// Home do usuário com o ambiente real.
pub fn home_dir() -> Option<PathBuf> {
    current().home_dir(&|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
}

/// RID .NET (`win-x64`, `linux-arm64`…) de um par SO/arquitetura, no formato
/// de `std::env::consts`. `None` = sem build publicado para esse alvo.
pub fn dotnet_rid(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("win-x64"),
        ("windows", "aarch64") => Some("win-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("macos", "x86_64") => Some("osx-x64"),
        ("macos", "aarch64") => Some("osx-arm64"),
        _ => None,
    }
}

/// RID deste binário.
pub fn host_dotnet_rid() -> Option<&'static str> {
    dotnet_rid(std::env::consts::OS, std::env::consts::ARCH)
}

// ------------------------------------------------------------- file URIs ---

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decodifica `%XX` (bytes UTF-8). Sequências inválidas ficam como estão.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Codifica um caminho absoluto como `file://` URI (RFC 8089). Tudo fora de
/// `A-Za-z0-9-._~/` vira `%XX` — inclusive `,` e `'`, o que deixa a URI segura
/// dentro de `array:string:` (dbus-send) e de literais GVariant (gdbus).
pub fn path_to_file_uri(path: &Path, os: Os) -> String {
    let raw = path.to_string_lossy().to_string();
    let (prefix, rest) = if os == Os::Windows {
        let p = raw.strip_prefix(r"\\?\").unwrap_or(&raw).replace('\\', "/");
        if let Some(unc) = p.strip_prefix("//") {
            let (host, tail) = unc.split_once('/').unwrap_or((unc, ""));
            (format!("file://{host}"), format!("/{tail}"))
        } else {
            ("file://".to_string(), format!("/{p}"))
        }
    } else {
        ("file://".to_string(), raw)
    };
    let mut out = prefix;
    for b in rest.bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') || (os == Os::Windows && b == b':');
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Converte uma `file://` URI num caminho nativo do SO indicado.
///
/// - Unix: `file:///home/u/a b` → `/home/u/a b` (sempre absoluto).
/// - Windows: `file:///C:/x` e `file:///c%3A/x` → `C:\x`; `file://srv/share/x`
///   → `\\srv\share\x`.
///
/// `None` se não for `file:` ou se tiver host remoto no Unix.
pub fn file_uri_to_path(uri: &str, os: Os) -> Option<PathBuf> {
    let scheme_ok = uri.len() >= 7 && uri[..7].eq_ignore_ascii_case("file://");
    if !scheme_ok {
        return None;
    }
    let after = &uri[7..];
    // Sem query/fragmento num caminho de arquivo.
    let after = after.split(['?', '#']).next().unwrap_or(after);
    let (authority, path) = match after.find('/') {
        Some(i) => (&after[..i], &after[i..]),
        None => (after, "/"),
    };
    let authority = percent_decode(authority);
    let path = percent_decode(path);
    let has_host = !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost");
    match os {
        Os::Windows => {
            if has_host {
                return Some(PathBuf::from(format!(r"\\{}{}", authority, path.replace('/', "\\"))));
            }
            let p = path.strip_prefix('/').unwrap_or(&path);
            let bytes = p.as_bytes();
            if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
                let mut s = p.replace('/', "\\");
                s[..1].make_ascii_uppercase();
                return Some(PathBuf::from(s));
            }
            Some(PathBuf::from(path.replace('/', "\\")))
        }
        Os::Linux | Os::Macos => {
            if has_host {
                return None;
            }
            Some(PathBuf::from(path))
        }
    }
}

#[cfg(test)]
mod tests;
