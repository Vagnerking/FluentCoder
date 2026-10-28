//! Linux (e outros Unix não-macOS): FileManager1 via D-Bus, `xdg-open`,
//! `$SHELL`/bash, diretórios XDG.

use super::{
    path_to_file_uri, Capabilities, Invocation, Os, Platform, ShellEnv, ShellKind, ShellSpec,
};
use std::path::{Path, PathBuf};

pub struct LinuxPlatform;

impl Platform for LinuxPlatform {
    fn os(&self) -> Os {
        Os::Linux
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            custom_caption_buttons: true,
            snap_layouts: false,
            mica: false,
            paths_case_insensitive: false,
            native_menu: false,
        }
    }

    /// 1. `org.freedesktop.FileManager1.ShowItems` via `gdbus` (GNOME Files,
    ///    Dolphin, Nemo, Caja, Thunar… implementam) — abre a pasta com o item
    ///    selecionado;
    /// 2. o mesmo via `dbus-send` (quando não há `gdbus`);
    /// 3. `xdg-open` da pasta-pai (sem seleção, mas sempre funciona).
    ///
    /// Os passos D-Bus esperam o código de saída: sem serviço registrado o
    /// `gdbus` falha e o próximo passo é tentado.
    fn reveal_plan(&self, path: &Path) -> Vec<Invocation> {
        let uri = path_to_file_uri(path, Os::Linux);
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        vec![
            Invocation::wait(
                "gdbus",
                &[
                    "call",
                    "--session",
                    "--timeout",
                    "4",
                    "--dest",
                    "org.freedesktop.FileManager1",
                    "--object-path",
                    "/org/freedesktop/FileManager1",
                    "--method",
                    "org.freedesktop.FileManager1.ShowItems",
                    &format!("['{uri}']"),
                    "",
                ],
            ),
            Invocation::wait(
                "dbus-send",
                &[
                    "--session",
                    "--print-reply",
                    "--reply-timeout=4000",
                    "--dest=org.freedesktop.FileManager1",
                    "--type=method_call",
                    "/org/freedesktop/FileManager1",
                    "org.freedesktop.FileManager1.ShowItems",
                    &format!("array:string:{uri}"),
                    "string:",
                ],
            ),
            Invocation::spawn("xdg-open", &[&parent]),
        ]
    }

    /// `xdg-open`, com `gio open` de reserva (sistemas sem xdg-utils).
    fn open_plan(&self, target: &str) -> Vec<Invocation> {
        vec![
            Invocation::spawn("xdg-open", &[target]),
            Invocation::spawn("gio", &["open", target]),
        ]
    }

    /// `$SHELL` como login shell (PATH do perfil: cargo, fnm, dotnet…), senão
    /// `/bin/bash`, senão `/bin/sh`.
    fn default_shell(&self, env: &ShellEnv) -> ShellSpec {
        let program = env
            .shell_var
            .clone()
            .or_else(|| (env.which)("bash").map(|p| p.to_string_lossy().to_string()))
            .unwrap_or_else(|| "/bin/sh".to_string());
        ShellSpec {
            program,
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
        env("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| self.home_dir(env).map(|h| h.join(".local").join("share")))
    }

    fn home_dir(&self, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
        env("HOME").map(PathBuf::from)
    }
}
