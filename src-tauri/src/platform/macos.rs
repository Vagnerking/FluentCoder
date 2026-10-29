//! macOS: Finder (`open -R`), `open`, zsh, Application Support.

use super::{Capabilities, Invocation, Os, Platform, ShellEnv, ShellKind, ShellSpec};
use std::path::{Path, PathBuf};

pub struct MacPlatform;

impl Platform for MacPlatform {
    fn os(&self) -> Os {
        Os::Macos
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            // Janela decorada: os semáforos nativos já existem.
            custom_caption_buttons: false,
            snap_layouts: false,
            mica: false,
            // APFS/HFS+ não diferenciam maiúsculas por padrão.
            paths_case_insensitive: true,
            native_menu: true,
        }
    }

    fn reveal_plan(&self, path: &Path) -> Vec<Invocation> {
        vec![Invocation::wait("open", &["-R", &path.to_string_lossy()])]
    }

    fn open_plan(&self, target: &str) -> Vec<Invocation> {
        vec![Invocation::spawn("open", &[target])]
    }

    /// `$SHELL` (o padrão do macOS desde o Catalina é zsh), senão `/bin/zsh`.
    fn default_shell(&self, env: &ShellEnv) -> ShellSpec {
        ShellSpec {
            program: env.shell_var.clone().unwrap_or_else(|| "/bin/zsh".to_string()),
            args: vec!["-l".into()],
            kind: ShellKind::Posix,
        }
    }

    fn shell_line(&self, line: &str) -> Invocation {
        Invocation::spawn("/bin/sh", &["-c", line])
    }

    fn exe_name(&self, base: &str) -> String {
        base.to_string()
    }

    fn user_data_dir(&self, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
        self.home_dir(env).map(|h| h.join("Library").join("Application Support"))
    }

    fn home_dir(&self, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
        env("HOME").map(PathBuf::from)
    }
}
