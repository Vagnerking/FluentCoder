//! Locating and launching `typescript-language-server` (a Node.js process).
//!
//! Strategy: prefer the project's local `node_modules/.bin` install (respects
//! the project's TypeScript version), fall back to a global npm install. No
//! auto-download — emit a clear, actionable error if anything is missing.

use std::path::{Path, PathBuf};

/// `{ program, args }` the frontend forwards to `lsp_start_server`.
#[derive(serde::Serialize, Clone, Debug)]
pub struct LaunchInfo {
    pub program: String,
    pub args: Vec<String>,
}

/// Locates the `node` executable on the PATH.
pub fn detect_node() -> Result<PathBuf, String> {
    which::which("node").map_err(|_| {
        "Node.js não encontrado no PATH. Para usar IntelliSense de TypeScript/JavaScript, \
         instale o Node.js (https://nodejs.org) e reinicie o editor."
            .to_string()
    })
}

/// Locates the `typescript-language-server` entry script.
///
/// Prefers `{project_root}/node_modules/.bin/typescript-language-server`, then
/// falls back to a global npm install (`npm root -g`).
pub fn detect_ts_language_server(project_root: &Path) -> Result<PathBuf, String> {
    // The portable, Node-launchable entry point is the JS file under the
    // package's `lib/`, not the platform `.cmd`/shell shim in `.bin`.
    let local = project_root
        .join("node_modules")
        .join("typescript-language-server")
        .join("lib")
        .join("cli.mjs");
    if local.is_file() {
        return Ok(local);
    }

    // Fallback: global install.
    if let Some(global_root) = npm_global_root() {
        let global = global_root
            .join("typescript-language-server")
            .join("lib")
            .join("cli.mjs");
        if global.is_file() {
            return Ok(global);
        }
    }

    Err("typescript-language-server não encontrado. Instale no projeto com \
         `npm install -D typescript-language-server typescript` ou globalmente com \
         `npm install -g typescript-language-server typescript`."
        .to_string())
}

/// Locates `tsserver.js` (the actual TypeScript server bundle).
///
/// Prefers the project-local `typescript` package so the project's TS version
/// is honored; falls back to a global install. Returns `None` (not an error) if
/// not found — `typescript-language-server` can still locate its own bundled TS.
pub fn detect_tsserver(project_root: &Path) -> Option<PathBuf> {
    let local = project_root
        .join("node_modules")
        .join("typescript")
        .join("lib")
        .join("tsserver.js");
    if local.is_file() {
        return Some(local);
    }

    if let Some(global_root) = npm_global_root() {
        let global = global_root
            .join("typescript")
            .join("lib")
            .join("tsserver.js");
        if global.is_file() {
            return Some(global);
        }
    }

    None
}

/// Builds the launch command for the TS language server.
///
/// Returns `(node_path, [cli.mjs, "--stdio", "--tsserver-path", <tsserver.js>])`.
pub fn ts_launch_command(project_root: &Path) -> Result<LaunchInfo, String> {
    let node = detect_node()?;
    let server = detect_ts_language_server(project_root)?;

    let mut args = vec![
        server.to_string_lossy().to_string(),
        "--stdio".to_string(),
    ];

    if let Some(tsserver) = detect_tsserver(project_root) {
        // typescript-language-server expects the directory containing tsserver,
        // i.e. node_modules/typescript/lib.
        if let Some(lib_dir) = tsserver.parent() {
            args.push("--tsserver-path".to_string());
            args.push(lib_dir.to_string_lossy().to_string());
        }
    }

    Ok(LaunchInfo {
        program: node.to_string_lossy().to_string(),
        args,
    })
}

/// Returns the global npm modules root (`npm root -g`), if resolvable.
fn npm_global_root() -> Option<PathBuf> {
    let npm = which::which("npm").ok()?;
    let mut cmd = std::process::Command::new(npm);
    cmd.args(["root", "-g"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}
