//! PATH do shell de login para apps abertos pela GUI (Dock, `.desktop`).
//!
//! Um app lançado pelo Finder/Dock (macOS, sempre) ou por alguns lançadores do
//! Linux não herda o `PATH` montado pelo `~/.zprofile`/`~/.bashrc`: `git`,
//! `dotnet`, `node`, `claude` e `codex` somem. Como o VS Code, rodamos o shell
//! de login uma vez no boot (`$SHELL -ilc env`, com teto de tempo) e
//! mesclamos o `PATH` dele no processo. Só o PATH: o resto do ambiente do app
//! fica como está.

use std::time::Duration;

/// Marcador para achar o bloco do `env -0` no meio do que o rc imprimir.
const MARK: &str = "__FLUENT_ENV_BEGIN__";

/// Extrai `PATH` da saída `MARK` + linhas `K=V` do `env` (puro).
pub fn path_from_env_block(out: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(out);
    let after = text.split_once(MARK)?.1;
    after
        .split('\n')
        .find_map(|kv| kv.trim_end_matches('\r').strip_prefix("PATH=").map(str::to_string))
        .filter(|p| !p.is_empty())
}

/// Junta o PATH do login shell na frente do atual, sem duplicar entradas.
pub fn merge_paths(login: &str, current: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    login
        .split(':')
        .chain(current.split(':'))
        .filter(|p| !p.is_empty() && seen.insert(p.to_string()))
        .collect::<Vec<_>>()
        .join(":")
}

/// Heurística de "aberto pela GUI": sem `TERM` (um terminal sempre define).
pub fn launched_from_gui(term: Option<&str>) -> bool {
    term.map(|t| t.is_empty() || t == "dumb").unwrap_or(true)
}

/// Executa o login shell e devolve o PATH dele (Unix). `None` em erro/timeout.
#[cfg(unix)]
fn login_shell_path(shell: &str, timeout: Duration) -> Option<String> {
    use std::io::Read;
    let mut child = std::process::Command::new(shell)
        .args(["-ilc", &format!("printf '%s' '{MARK}'; env")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => return None,
        }
    }
    path_from_env_block(&reader.join().ok()?)
}

/// No boot (antes de qualquer thread do Tauri): se o app veio da GUI no
/// macOS/Linux, mescla o PATH do shell de login. No Windows é no-op.
pub fn apply_login_shell_path() {
    #[cfg(unix)]
    {
        if std::env::var_os("FLUENT_SKIP_LOGIN_ENV").is_some() || !launched_from_gui(std::env::var("TERM").ok().as_deref()) {
            return;
        }
        let shell = super::default_shell().program;
        if let Some(login) = login_shell_path(&shell, Duration::from_secs(3)) {
            let current = std::env::var("PATH").unwrap_or_default();
            // Ainda single-thread (chamado no início de `run`), então set_var é seguro.
            std::env::set_var("PATH", merge_paths(&login, &current));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_path_after_noise_from_rc_files() {
        let out = b"Bem-vindo!\nPATH=/falso\n__FLUENT_ENV_BEGIN__HOME=/home/u\nPATH=/home/u/.cargo/bin:/usr/bin\nSHELL=/bin/zsh\n";
        assert_eq!(path_from_env_block(out).as_deref(), Some("/home/u/.cargo/bin:/usr/bin"));
        assert_eq!(path_from_env_block(b"sem marcador PATH=/x"), None);
        assert_eq!(path_from_env_block(b"__FLUENT_ENV_BEGIN__PATH=\n"), None);
    }

    #[test]
    fn merge_puts_login_first_without_duplicates() {
        assert_eq!(merge_paths("/a:/usr/bin", "/usr/bin:/b"), "/a:/usr/bin:/b");
        assert_eq!(merge_paths("", "/usr/bin"), "/usr/bin");
    }

    #[test]
    fn gui_launch_heuristic() {
        assert!(launched_from_gui(None));
        assert!(launched_from_gui(Some("dumb")));
        assert!(!launched_from_gui(Some("xterm-256color")));
    }

    #[cfg(unix)]
    #[test]
    fn real_login_shell_reports_a_path() {
        let p = login_shell_path("/bin/sh", Duration::from_secs(5)).expect("PATH do sh");
        assert!(p.contains('/'), "{p}");
    }
}
