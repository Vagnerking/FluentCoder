//! Windows: Explorer, `rundll32` para URLs, PowerShell (pwsh quando houver).

use super::{Capabilities, Invocation, Os, Platform, ShellEnv, ShellKind, ShellSpec};
use std::path::{Path, PathBuf};

pub struct WindowsPlatform;

impl Platform for WindowsPlatform {
    fn os(&self) -> Os {
        Os::Windows
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            custom_caption_buttons: true,
            snap_layouts: true,
            mica: true,
            paths_case_insensitive: true,
            native_menu: false,
        }
    }

    /// `explorer /select,<path>`. O Explorer devolve código != 0 mesmo quando
    /// funciona, então o passo é `spawn` (não usa o status).
    fn reveal_plan(&self, path: &Path) -> Vec<Invocation> {
        let raw = path.to_string_lossy();
        let p = if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else {
            raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string()
        };
        vec![Invocation {
            program: "explorer".into(),
            args: vec!["/select,".into(), p],
            wait: false,
        }]
    }

    fn open_plan(&self, target: &str) -> Vec<Invocation> {
        vec![Invocation::spawn(
            "rundll32",
            &["url.dll,FileProtocolHandler", target],
        )]
    }

    /// `pwsh.exe` (PowerShell 7) quando instalado, senão `powershell.exe`.
    fn default_shell(&self, env: &ShellEnv) -> ShellSpec {
        let program = if (env.which)("pwsh.exe").is_some() {
            "pwsh.exe"
        } else {
            "powershell.exe"
        };
        ShellSpec {
            program: program.into(),
            args: vec![],
            kind: ShellKind::Powershell,
        }
    }

    fn shell_line(&self, line: &str) -> Invocation {
        Invocation::spawn("cmd.exe", &["/C", line])
    }

    fn exe_name(&self, base: &str) -> String {
        if base.to_ascii_lowercase().ends_with(".exe") {
            base.to_string()
        } else {
            format!("{base}.exe")
        }
    }

    fn user_data_dir(&self, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
        env("APPDATA").map(PathBuf::from).or_else(|| {
            self.home_dir(env)
                .map(|h| h.join("AppData").join("Roaming"))
        })
    }

    fn home_dir(&self, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
        env("USERPROFILE")
            .or_else(|| match (env("HOMEDRIVE"), env("HOMEPATH")) {
                (Some(d), Some(p)) => Some(format!("{d}{p}")),
                _ => None,
            })
            .or_else(|| env("HOME"))
            .map(PathBuf::from)
    }
}
