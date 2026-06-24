//! Launching language servers that ship with the user's installed SDK/toolchain.
//!
//! For languages whose LSP comes with the SDK (Dart, Go, …), the most reliable,
//! version-correct path is to launch the SDK's own server straight from the PATH
//! — no download, always matching the user's project. We locate the command and
//! return the launch line; an actionable error names what to install if missing.

use serde::Serialize;

/// `{ program, args }` the frontend forwards to `lsp_start_server`.
#[derive(Serialize, Clone, Debug)]
pub struct LaunchInfo {
    pub program: String,
    pub args: Vec<String>,
}

/// Declarative spec for one PATH-resolved language server. `server_id`/`label`
/// are kept for parity with the other server specs and future progress events.
#[allow(dead_code)]
pub struct SystemServerSpec {
    /// Session id (kept equal to the primary Monaco language id), e.g. "dart".
    pub server_id: &'static str,
    pub label: &'static str,
    /// Executable to find on the PATH (the SDK's LSP), e.g. "dart" / "gopls".
    pub command: &'static str,
    /// Args to start it in LSP/stdio mode.
    pub args: &'static [&'static str],
    /// Shown when the command isn't found, telling the user how to install it.
    pub install_hint: &'static str,
}

/// Returns the spec for a known SDK-provided server id, or `None`. One arm per
/// language (plus a frontend registry entry).
pub fn spec_for(server_id: &str) -> Option<SystemServerSpec> {
    Some(match server_id {
        "dart" => SystemServerSpec {
            server_id: "dart",
            label: "Dart",
            command: "dart",
            args: &["language-server", "--protocol=lsp"],
            install_hint: "Instale o Dart/Flutter SDK e garanta que `dart` está no PATH.",
        },
        "go" => SystemServerSpec {
            server_id: "go",
            label: "Go",
            command: "gopls",
            args: &[],
            install_hint: "Instale o Go e rode `go install golang.org/x/tools/gopls@latest`.",
        },
        _ => return None,
    })
}

/// Locates the SDK's language-server executable on the PATH and builds the launch
/// command. Errors with an actionable install hint when it isn't found.
pub fn resolve_system_server(spec: &SystemServerSpec) -> Result<LaunchInfo, String> {
    let program = which::which(spec.command).map_err(|_| {
        format!(
            "`{}` não encontrado no PATH. {}",
            spec.command, spec.install_hint
        )
    })?;
    Ok(LaunchInfo {
        program: program.to_string_lossy().to_string(),
        args: spec.args.iter().map(|s| s.to_string()).collect(),
    })
}
