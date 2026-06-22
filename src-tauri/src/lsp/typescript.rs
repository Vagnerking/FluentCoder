//! Locating and launching `typescript-language-server` (a Node.js process).
//!
//! Strategy: prefer the project's local `node_modules` install (respects the
//! project's TypeScript version), fall back to a global npm install, and finally
//! auto-install into an app-managed cache (`app_data_dir/lsp/typescript`) with
//! `npm` so the user never has to set it up by hand. Progress is reported via the
//! `lsp-download-progress` event, like the Roslyn (C#) acquisition.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// `{ program, args }` the frontend forwards to `lsp_start_server`, plus the
/// resolved `tsserver.js` path it passes via `initializationOptions.tsserver.path`
/// (current `typescript-language-server` rejects the old `--tsserver-path` flag).
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
    pub program: String,
    pub args: Vec<String>,
    pub tsserver_path: Option<String>,
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

/// Resolves the launch command for the TS language server, auto-installing it
/// into the app cache when it isn't found in the project or globally.
///
/// Returns `(node_path, [cli.mjs, "--stdio", "--tsserver-path", <tsserver.js>])`.
pub async fn resolve_ts_launch(
    app: &AppHandle,
    project_root: &Path,
    prefer_editor: bool,
) -> Result<LaunchInfo, String> {
    let node = detect_node()?;
    // Project-local / global install wins (honors the project's TS version);
    // otherwise fall back to the auto-installed cache.
    let server = match detect_ts_language_server(project_root) {
        Ok(server) => server,
        Err(_) => ensure_ts_cached(app).await?,
    };

    let args = vec![server.to_string_lossy().to_string(), "--stdio".to_string()];

    // tsserver = the TypeScript version. By default we prefer the project's (the
    // recommended choice); the user can force the editor-managed (cached) one.
    // It's handed to the server via `initializationOptions.tsserver.path` on the
    // front end — the old `--tsserver-path` CLI flag was removed and now errors.
    let tsserver = if prefer_editor {
        let _ = ensure_ts_cached(app).await; // make sure the cached TS exists
        cached_tsserver(app)
    } else {
        detect_tsserver(project_root).or_else(|| cached_tsserver(app))
    };
    let tsserver_path = tsserver.map(|p| p.to_string_lossy().to_string());

    Ok(LaunchInfo {
        program: node.to_string_lossy().to_string(),
        args,
        tsserver_path,
    })
}

/// Cache directory for the auto-installed TypeScript language server.
fn ts_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(base.join("lsp").join("typescript"))
}

/// Emits a download-progress event for the TypeScript server (mirrors C#).
fn emit_progress(app: &AppHandle, state: &str, message: &str) {
    let _ = app.emit(
        "lsp-download-progress",
        serde_json::json!({ "server": "typescript", "state": state, "message": message }),
    );
}

/// `cli.mjs` of the cached language server, if it's installed.
fn cached_ts_language_server(app: &AppHandle) -> Option<PathBuf> {
    let cli = ts_cache_dir(app)
        .ok()?
        .join("node_modules")
        .join("typescript-language-server")
        .join("lib")
        .join("cli.mjs");
    cli.is_file().then_some(cli)
}

/// Project + editor-managed TypeScript versions, for the "Select TS Version"
/// picker (mirrors VS Code showing both version numbers).
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TsVersions {
    /// The project's `typescript` version (`node_modules/typescript`), if installed.
    pub project: Option<String>,
    /// The editor-managed (cached) `typescript` version, if downloaded.
    pub editor: Option<String>,
}

/// Reads the `version` field from a `typescript` package's `package.json`.
fn read_ts_version(ts_pkg_dir: &Path) -> Option<String> {
    let content = std::fs::read_to_string(ts_pkg_dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

/// The TypeScript versions available to the project (its own + the editor's).
pub fn ts_versions(app: &AppHandle, project_root: &Path) -> TsVersions {
    let project = read_ts_version(&project_root.join("node_modules").join("typescript"));
    let editor = ts_cache_dir(app)
        .ok()
        .and_then(|dir| read_ts_version(&dir.join("node_modules").join("typescript")));
    TsVersions { project, editor }
}

/// `tsserver.js` from the cached `typescript` package, if present.
fn cached_tsserver(app: &AppHandle) -> Option<PathBuf> {
    let server = ts_cache_dir(app)
        .ok()?
        .join("node_modules")
        .join("typescript")
        .join("lib")
        .join("tsserver.js");
    server.is_file().then_some(server)
}

/// Ensures the TypeScript language server is installed in the app cache,
/// installing it with `npm` on first use. Returns the path to `cli.mjs`.
pub async fn ensure_ts_cached(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(cli) = cached_ts_language_server(app) {
        return Ok(cli);
    }

    let npm = which::which("npm").map_err(|_| {
        "npm não encontrado no PATH. Instale o Node.js (https://nodejs.org) para o editor \
         baixar o servidor de TypeScript automaticamente."
            .to_string()
    })?;
    let cache = ts_cache_dir(app)?;
    std::fs::create_dir_all(&cache)
        .map_err(|e| format!("não foi possível criar o cache do TypeScript: {e}"))?;

    emit_progress(app, "downloading", "Baixando o servidor de TypeScript…");

    // npm install is blocking and slow; run it off the async runtime.
    let cache_arg = cache.to_string_lossy().to_string();
    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(npm);
        cmd.args([
            "install",
            "--prefix",
            &cache_arg,
            "typescript-language-server",
            "typescript",
            "--no-audit",
            "--no-fund",
            "--loglevel",
            "error",
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.output()
    })
    .await
    .map_err(|e| format!("falha ao iniciar o npm: {e}"))?
    .map_err(|e| format!("falha ao executar o npm: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        emit_progress(app, "error", "Falha ao baixar o servidor de TypeScript");
        return Err(format!("npm install falhou: {stderr}"));
    }

    match cached_ts_language_server(app) {
        Some(cli) => {
            emit_progress(app, "ready", "Servidor de TypeScript pronto");
            Ok(cli)
        }
        None => {
            emit_progress(app, "error", "Servidor não encontrado após a instalação");
            Err("typescript-language-server não encontrado após o npm install".to_string())
        }
    }
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
