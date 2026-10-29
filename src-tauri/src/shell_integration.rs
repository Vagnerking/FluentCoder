//! Shell integration (estilo VS Code) para os terminais das extensões:
//! bash/zsh/fish são iniciados com um script NOSSO que carrega a configuração do
//! usuário (sem tocar nos dotfiles dele) e emite as sequências OSC 633
//! (`A`/`B` prompt, `E` linha de comando, `C` início, `D;<código>` fim,
//! `P;Cwd=<pasta>`). O frontend lê as sequências do PTY
//! (`src/extensions/shellIntegration.ts`) e o host de extensões dispara
//! `onDidStart/EndTerminalShellExecution` com o código de saída real.
//!
//! - bash: `bash --init-file <dir>/fluent-bash.sh -i` (o script emula o login:
//!   /etc/profile + ~/.bash_profile|~/.bash_login|~/.profile);
//! - zsh: `ZDOTDIR=<dir>/zsh` com `.zshenv/.zprofile/.zshrc/.zlogin` que
//!   carregam os do usuário (`FLUENT_USER_ZDOTDIR`) e devolvem o ZDOTDIR dele;
//! - fish: `fish -l --init-command "source <dir>/fluent-fish.fish"`.
//!
//! Os scripts ficam em `<app_data_dir>/shell-integration/` (regravados só se
//! o conteúdo mudou).

use std::path::{Path, PathBuf};

const BASH: &str = include_str!("../shell-integration/fluent-bash.sh");
const FISH: &str = include_str!("../shell-integration/fluent-fish.fish");
const ZSH_FILES: [(&str, &str); 4] = [
    (".zshenv", include_str!("../shell-integration/zsh/.zshenv")),
    (".zprofile", include_str!("../shell-integration/zsh/.zprofile")),
    (".zshrc", include_str!("../shell-integration/zsh/.zshrc")),
    (".zlogin", include_str!("../shell-integration/zsh/.zlogin")),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Bash,
    Zsh,
    Fish,
}

/// Shell suportado pelo nome do executável (`/usr/bin/zsh`, `bash.exe`…).
pub fn shell_kind(program: &str) -> Option<ShellKind> {
    // Separa por `/` e `\` (caminhos do Windows também em outros SOs).
    let name = program.rsplit(['/', '\\']).next()?.to_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    match name {
        "bash" => Some(ShellKind::Bash),
        "zsh" => Some(ShellKind::Zsh),
        "fish" => Some(ShellKind::Fish),
        _ => None,
    }
}

fn write_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)
}

/// Grava os scripts em `dir` (idempotente).
pub fn install_scripts(dir: &Path) -> std::io::Result<()> {
    write_if_changed(&dir.join("fluent-bash.sh"), BASH)?;
    write_if_changed(&dir.join("fluent-fish.fish"), FISH)?;
    for (name, content) in ZSH_FILES {
        write_if_changed(&dir.join("zsh").join(name), content)?;
    }
    Ok(())
}

/// Argumentos e variáveis que ligam a integração num shell suportado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Injection {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

fn nonce() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{:x}{:x}", t, std::process::id())
}

/// Como iniciar `kind` com a integração. `user_zdotdir` = ZDOTDIR original
/// (ou o HOME) do usuário, só para o zsh.
pub fn injection(kind: ShellKind, dir: &Path, user_zdotdir: Option<&str>) -> Injection {
    let mut env = vec![
        ("FLUENT_SHELL_INTEGRATION".to_string(), "1".to_string()),
        ("FLUENT_SI_NONCE".to_string(), nonce()),
    ];
    let args = match kind {
        ShellKind::Bash => {
            env.push(("FLUENT_SHELL_LOGIN".into(), "1".into()));
            vec![
                "--init-file".into(),
                dir.join("fluent-bash.sh").to_string_lossy().into_owned(),
                "-i".into(),
            ]
        }
        ShellKind::Zsh => {
            env.push(("ZDOTDIR".into(), dir.join("zsh").to_string_lossy().into_owned()));
            let home = std::env::var("HOME").unwrap_or_default();
            env.push((
                "FLUENT_USER_ZDOTDIR".into(),
                user_zdotdir.filter(|s| !s.is_empty()).map(str::to_string).unwrap_or(home),
            ));
            vec!["-l".into(), "-i".into()]
        }
        ShellKind::Fish => {
            let script = dir.join("fluent-fish.fish").to_string_lossy().replace('\'', "\\'");
            vec!["-l".into(), "--init-command".into(), format!("source '{script}'")]
        }
    };
    Injection { args, env }
}

/// Pasta dos scripts para este app.
pub fn scripts_dir(app_data: &Path) -> PathBuf {
    app_data.join("shell-integration")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_shells() {
        assert_eq!(shell_kind("/usr/bin/bash"), Some(ShellKind::Bash));
        assert_eq!(shell_kind("/bin/zsh"), Some(ShellKind::Zsh));
        assert_eq!(shell_kind("C:\\Program Files\\Git\\bin\\bash.exe"), Some(ShellKind::Bash));
        assert_eq!(shell_kind("/usr/local/bin/fish"), Some(ShellKind::Fish));
        assert_eq!(shell_kind("/bin/sh"), None);
        assert_eq!(shell_kind("powershell.exe"), None);
    }

    #[test]
    fn installs_scripts_idempotently() {
        let dir = std::env::temp_dir().join(format!("fluent-si-{}", nonce()));
        install_scripts(&dir).unwrap();
        install_scripts(&dir).unwrap();
        assert!(dir.join("fluent-bash.sh").is_file());
        assert!(dir.join("fluent-fish.fish").is_file());
        for f in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            assert!(dir.join("zsh").join(f).is_file(), "{f}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn injection_args_never_touch_user_dotfiles() {
        let dir = Path::new("/data/si");
        let bash = injection(ShellKind::Bash, dir, None);
        assert_eq!(bash.args, vec![
            "--init-file".to_string(),
            dir.join("fluent-bash.sh").to_string_lossy().to_string(),
            "-i".to_string(),
        ]);
        assert!(bash.env.iter().any(|(k, v)| k == "FLUENT_SHELL_LOGIN" && v == "1"));
        let zsh = injection(ShellKind::Zsh, dir, Some("/home/u/.config/zsh"));
        assert!(zsh.env.iter().any(|(k, v)| k == "ZDOTDIR" && v == &dir.join("zsh").to_string_lossy()));
        assert!(zsh.env.iter().any(|(k, v)| k == "FLUENT_USER_ZDOTDIR" && v == "/home/u/.config/zsh"));
        let fish = injection(ShellKind::Fish, dir, None);
        assert_eq!(fish.args[2], format!("source '{}'", dir.join("fluent-fish.fish").display()));
    }

    /// Roda o bash real num PTY com o nosso script (HOME temporário, sem a
    /// configuração do usuário) e confere as sequências OSC 633.
    #[cfg(unix)]
    #[test]
    fn bash_emits_osc_633_with_exit_codes() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        let Ok(bash) = which::which("bash") else {
            eprintln!("bash ausente — teste ignorado");
            return;
        };
        let dir = std::env::temp_dir().join(format!("fluent-si-bash-{}", nonce()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        install_scripts(&dir).unwrap();
        let inj = injection(ShellKind::Bash, &dir, None);
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 120, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new(bash);
        cmd.args(&inj.args);
        cmd.env_clear();
        cmd.env("HOME", &home);
        cmd.env("PATH", std::env::var("PATH").unwrap_or_default());
        cmd.env("TERM", "xterm-256color");
        for (k, v) in &inj.env {
            cmd.env(k, v);
        }
        cmd.cwd(&home);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut out = String::new();
        let mut wait_for = |needle: &str, out: &mut String| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !out.contains(needle) && std::time::Instant::now() < deadline {
                if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
                    out.push_str(&String::from_utf8_lossy(&chunk));
                }
            }
            out.contains(needle)
        };
        assert!(wait_for("\x1b]633;A\x07", &mut out), "sem prompt: {out:?}");
        writer.write_all(b"echo ola; false\r").unwrap();
        assert!(wait_for("\x1b]633;D;1\x07", &mut out), "sem D;1: {out:?}");
        writer.write_all(b"true\r").unwrap();
        assert!(wait_for("\x1b]633;D;0\x07", &mut out), "sem D;0: {out:?}");
        writer.write_all(b"exit\r").unwrap();
        let _ = child.wait();
        assert!(out.contains("\x1b]633;E;echo ola\\x3b false;"), "linha de comando escapada: {out:?}");
        assert!(out.contains("\x1b]633;C\x07"));
        assert!(out.contains("\x1b]633;P;Cwd="));
        assert!(out.contains("633;B"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
