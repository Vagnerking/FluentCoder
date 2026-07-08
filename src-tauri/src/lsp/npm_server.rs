//! Generic acquisition + launch of npm-distributed language servers.
//!
//! Many modern LSPs ship as npm packages launched as `node <entry> <args>`
//! (Pyright, yaml-language-server, the vscode-langservers, bash-language-server,
//! the Dockerfile server, …). This installs them on demand into
//! `app_data/lsp/<server_id>` and resolves the launch command from the package's
//! `bin` field — so adding a language is a one-line spec in `spec_for`, with no
//! new Rust module. Progress is reported via `lsp-download-progress`, like C#/TS.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// `{ program, args }` the frontend forwards to `lsp_start_server`.
#[derive(Serialize, Clone, Debug)]
pub struct LaunchInfo {
    pub program: String,
    pub args: Vec<String>,
}

/// Declarative spec for one npm-based language server.
pub struct NpmServerSpec {
    /// Session id (kept equal to the primary Monaco language id), e.g. "python".
    pub server_id: &'static str,
    /// Friendly name for progress messages, e.g. "Python (Pyright)".
    pub label: &'static str,
    /// npm packages to install.
    pub packages: &'static [&'static str],
    /// Package whose `bin` holds the server entry point.
    pub entry_package: &'static str,
    /// Which `bin` entry to launch (a package can expose several); None = first.
    pub bin_name: Option<&'static str>,
    /// CLI args to start the server in stdio mode, e.g. `["--stdio"]`.
    pub args: &'static [&'static str],
}

/// Returns the spec for a known npm-based server id, or `None`. Add a language by
/// adding one arm here (and a frontend registry entry).
pub fn spec_for(server_id: &str) -> Option<NpmServerSpec> {
    Some(match server_id {
        "python" => NpmServerSpec {
            server_id: "python",
            label: "Python (Pyright)",
            packages: &["pyright"],
            entry_package: "pyright",
            bin_name: Some("pyright-langserver"),
            args: &["--stdio"],
        },
        "yaml" => NpmServerSpec {
            server_id: "yaml",
            label: "YAML",
            packages: &["yaml-language-server"],
            entry_package: "yaml-language-server",
            bin_name: Some("yaml-language-server"),
            args: &["--stdio"],
        },
        "json" => NpmServerSpec {
            server_id: "json",
            label: "JSON",
            packages: &["vscode-langservers-extracted"],
            entry_package: "vscode-langservers-extracted",
            bin_name: Some("vscode-json-language-server"),
            args: &["--stdio"],
        },
        "html" => NpmServerSpec {
            server_id: "html",
            label: "HTML",
            packages: &["vscode-langservers-extracted"],
            entry_package: "vscode-langservers-extracted",
            bin_name: Some("vscode-html-language-server"),
            args: &["--stdio"],
        },
        "css" => NpmServerSpec {
            server_id: "css",
            label: "CSS",
            packages: &["vscode-langservers-extracted"],
            entry_package: "vscode-langservers-extracted",
            bin_name: Some("vscode-css-language-server"),
            args: &["--stdio"],
        },
        "shell" => NpmServerSpec {
            server_id: "shell",
            label: "Bash",
            packages: &["bash-language-server"],
            entry_package: "bash-language-server",
            bin_name: Some("bash-language-server"),
            args: &["start"],
        },
        "dockerfile" => NpmServerSpec {
            server_id: "dockerfile",
            label: "Dockerfile",
            packages: &["dockerfile-language-server-nodejs"],
            entry_package: "dockerfile-language-server-nodejs",
            bin_name: Some("docker-langserver"),
            args: &["--stdio"],
        },
        _ => return None,
    })
}

fn cache_dir(app: &AppHandle, server_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(base.join("lsp").join(server_id))
}

fn emit_progress(app: &AppHandle, server_id: &str, state: &str, message: &str) {
    let _ = app.emit(
        "lsp-download-progress",
        serde_json::json!({ "server": server_id, "state": state, "message": message }),
    );
}

/// Resolves the server entry script from the installed package's `bin` field.
/// Handles both `"bin": "x.js"` and `"bin": { "name": "x.js", … }`.
fn resolve_entry(cache: &Path, entry_package: &str, bin_name: Option<&str>) -> Option<PathBuf> {
    let pkg_dir = cache.join("node_modules").join(entry_package);
    let content = std::fs::read_to_string(pkg_dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let rel = match json.get("bin")? {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(map) => match bin_name {
            Some(name) => map.get(name).and_then(|v| v.as_str())?.to_string(),
            None => map.values().next().and_then(|v| v.as_str())?.to_string(),
        },
        _ => return None,
    };
    let entry = pkg_dir.join(rel);
    entry.is_file().then_some(entry)
}

/// Ensures the server is installed in the app cache (installing with `npm` on
/// first use) and returns the `node`-based launch command.
pub async fn ensure_npm_server(
    app: &AppHandle,
    spec: &NpmServerSpec,
) -> Result<LaunchInfo, String> {
    let node = which::which("node").map_err(|_| {
        "Node.js não encontrado no PATH. Instale o Node.js (https://nodejs.org) para o editor \
         baixar os servidores de linguagem automaticamente."
            .to_string()
    })?;
    let cache = cache_dir(app, spec.server_id)?;

    let entry = match resolve_entry(&cache, spec.entry_package, spec.bin_name) {
        Some(entry) => entry,
        None => {
            let npm = which::which("npm").map_err(|_| {
                "npm não encontrado no PATH. Instale o Node.js para o download automático."
                    .to_string()
            })?;
            std::fs::create_dir_all(&cache)
                .map_err(|e| format!("não foi possível criar o cache: {e}"))?;
            emit_progress(
                app,
                spec.server_id,
                "downloading",
                &format!("Baixando servidor de {}…", spec.label),
            );

            let cache_arg = cache.to_string_lossy().to_string();
            let packages: Vec<String> = spec.packages.iter().map(|s| s.to_string()).collect();
            let output = tokio::task::spawn_blocking(move || {
                let mut cmd = std::process::Command::new(npm);
                cmd.arg("install").arg("--prefix").arg(&cache_arg);
                for package in &packages {
                    cmd.arg(package);
                }
                cmd.args(["--no-audit", "--no-fund", "--loglevel", "error"]);
                crate::child_process::hide_console_window(&mut cmd);
                cmd.output()
            })
            .await
            .map_err(|e| format!("falha ao iniciar o npm: {e}"))?
            .map_err(|e| format!("falha ao executar o npm: {e}"))?;

            if !output.status.success() {
                emit_progress(
                    app,
                    spec.server_id,
                    "error",
                    &format!("Falha ao baixar servidor de {}", spec.label),
                );
                return Err(format!(
                    "npm install falhou: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }

            match resolve_entry(&cache, spec.entry_package, spec.bin_name) {
                Some(entry) => entry,
                None => {
                    emit_progress(
                        app,
                        spec.server_id,
                        "error",
                        "Servidor não encontrado após a instalação",
                    );
                    return Err(format!(
                        "entry do servidor '{}' não encontrado após o npm install",
                        spec.server_id
                    ));
                }
            }
        }
    };

    emit_progress(
        app,
        spec.server_id,
        "ready",
        &format!("Servidor de {} pronto", spec.label),
    );

    let mut args = vec![entry.to_string_lossy().to_string()];
    args.extend(spec.args.iter().map(|s| s.to_string()));
    Ok(LaunchInfo {
        program: node.to_string_lossy().to_string(),
        args,
    })
}
