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
        .find_map(|kv| {
            kv.trim_end_matches('\r')
                .strip_prefix("PATH=")
                .map(str::to_string)
        })
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
    let mut command = std::process::Command::new(shell);
    command.args(["-ilc", &format!("printf '%s' '{MARK}'; env")]);
    path_from_shell_command(command, timeout)
}

#[cfg(unix)]
fn path_from_shell_command(
    mut command: std::process::Command,
    timeout: Duration,
) -> Option<String> {
    use std::io::Read;
    use std::os::fd::AsRawFd;

    struct ReapChild(std::process::Child);
    impl Drop for ReapChild {
        fn drop(&mut self) {
            if !matches!(self.0.try_wait(), Ok(Some(_))) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }

    let mut child = ReapChild(
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?,
    );
    let mut stdout = child.0.stdout.take()?;
    let fd = stdout.as_raw_fd();
    // SAFETY: stdout owns this live pipe descriptor throughout the calls;
    // F_GETFL takes no pointer and does not transfer ownership.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 {
        return None;
    }
    // SAFETY: same live descriptor; F_SETFL expects an integer flags argument.
    // Preserve existing flags and make only our read end nonblocking.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return None;
    }
    // A profile can leave stdout open in a background child even after the
    // shell exits. Poll pipe and child under the same deadline, with no reader
    // thread that can block on EOF after the timeout.
    const MAX_OUTPUT: usize = 8 * 1024 * 1024;
    let mut output = Vec::new();
    let mut buf = [0; 16 * 1024];
    let mut eof = false;
    let mut exited = false;
    let started = std::time::Instant::now();
    loop {
        if started.elapsed() >= timeout {
            return None;
        }
        let mut idle = eof;
        if !eof {
            match stdout.read(&mut buf) {
                Ok(0) => eof = true,
                Ok(n) => {
                    if output.len() + n > MAX_OUTPUT {
                        return None;
                    }
                    output.extend_from_slice(&buf[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => idle = true,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return None,
            }
        }
        if !exited {
            exited = child.0.try_wait().ok()?.is_some();
        }
        if eof && exited {
            return path_from_env_block(&output);
        }
        if idle {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// No boot (antes de qualquer thread do Tauri): se o app veio da GUI no
/// macOS/Linux, mescla o PATH do shell de login. No Windows é no-op.
pub fn apply_login_shell_path() {
    #[cfg(unix)]
    {
        if std::env::var_os("FLUENT_SKIP_LOGIN_ENV").is_some()
            || !launched_from_gui(std::env::var("TERM").ok().as_deref())
        {
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

    #[cfg(unix)]
    fn fixture_command(script: &str, root: &std::path::Path) -> std::process::Command {
        // Execute an existing shell with a controlled script and positional
        // argument. Writing and immediately executing a temporary script can
        // fail with ETXTBSY when another test forks during the write.
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", script, "fixture"]).arg(root);
        command
    }

    #[cfg(unix)]
    #[test]
    fn stdout_inherited_by_a_background_job_cannot_bypass_timeout() {
        let root = tempfile::tempdir().unwrap();
        let command = fixture_command(
            r#"root=$1
(sleep 3; printf done > "$root/done") &
printf '__FLUENT_ENV_BEGIN__PATH=/fixture/bin\n'
"#,
            root.path(),
        );
        let started = std::time::Instant::now();
        let result = path_from_shell_command(command, Duration::from_secs(1));
        let elapsed = started.elapsed();

        // The fixture's background child has a finite lifetime; wait for its
        // completion before assertions or removing the temporary directory.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !root.path().join("done").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(root.path().join("done").exists());
        assert!(result.is_none(), "incomplete output must time out");
        assert!(
            elapsed < Duration::from_millis(2500),
            "probe took {elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn shell_that_never_exits_is_stopped_at_the_deadline() {
        let root = tempfile::tempdir().unwrap();
        let command = fixture_command("while :; do :; done", root.path());
        let started = std::time::Instant::now();
        assert_eq!(
            path_from_shell_command(command, Duration::from_millis(100)),
            None
        );
        assert!(started.elapsed() < Duration::from_millis(750));
    }

    #[cfg(unix)]
    #[test]
    fn excessive_profile_output_is_rejected_instead_of_used_partially() {
        let root = tempfile::tempdir().unwrap();
        let command = fixture_command(
            "printf '__FLUENT_ENV_BEGIN__PATH=/fixture/bin\\n'; head -c 16777216 /dev/zero",
            root.path(),
        );
        assert_eq!(
            path_from_shell_command(command, Duration::from_secs(5)),
            None
        );
    }

    #[test]
    fn parses_path_after_noise_from_rc_files() {
        let out = b"Bem-vindo!\nPATH=/falso\n__FLUENT_ENV_BEGIN__HOME=/home/u\nPATH=/home/u/.cargo/bin:/usr/bin\nSHELL=/bin/zsh\n";
        assert_eq!(
            path_from_env_block(out).as_deref(),
            Some("/home/u/.cargo/bin:/usr/bin")
        );
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
