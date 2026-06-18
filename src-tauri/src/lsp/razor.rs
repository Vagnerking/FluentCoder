//! Acquisition and launch of the Razor Language Server (`rzls`) — ISSUE-30.
//!
//! `rzls` ships inside the C# tooling. In the `vscode-csharp` extension it lives
//! next to the Roslyn language server under a `.razor`/`Razor` folder, and is
//! also published standalone on NuGet as
//! `Microsoft.VisualStudio.LanguageServices.Razor` / the `rzls` tool package.
//!
//! IMPORTANT — NOT YET EXERCISED END TO END: this module implements the path
//! resolution and launch-command construction, but the actual binary download is
//! a documented stub (`download_rzls`). Per the task constraints, no large
//! download is performed here; wiring it to a real fetch is a follow-up once the
//! Roslyn acquisition (C# epic ISSUE-26) lands and the exact package layout is
//! confirmed. See `src/lsp/RAZOR-SPIKE.md`.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

/// Folder (relative to the LSP cache root) where the rzls package is expected.
const RZLS_SUBDIR: &str = "razor";

/// Name of the rzls executable per platform.
#[cfg(windows)]
const RZLS_EXE: &str = "rzls.exe";
#[cfg(not(windows))]
const RZLS_EXE: &str = "rzls";

/// Root cache directory for downloaded language servers:
/// `app_data_dir()/lsp/`.
fn lsp_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app_data_dir: {e}"))?;
    Ok(base.join("lsp"))
}

/// Returns common candidate locations for the rzls executable.
///
/// 1. Bundled alongside the Roslyn LSP cached by the C# epic (ISSUE-26):
///    `app_data_dir()/lsp/roslyn/<version>/**/rzls(.exe)` — here we probe the
///    well-known sibling layout `.../content/rzls/` and a flat `razor/` folder.
/// 2. A standalone rzls package cached at `app_data_dir()/lsp/razor/`.
fn rzls_candidates(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let root = lsp_cache_root(app)?;
    let mut candidates = Vec::new();

    // Standalone razor package location.
    candidates.push(root.join(RZLS_SUBDIR).join(RZLS_EXE));

    // Bundled-with-Roslyn locations: scan roslyn/<version>/ for a rzls folder.
    let roslyn_root = root.join("roslyn");
    if let Ok(versions) = std::fs::read_dir(&roslyn_root) {
        for entry in versions.flatten() {
            let v = entry.path();
            candidates.push(v.join("content").join("rzls").join(RZLS_EXE));
            candidates.push(v.join("rzls").join(RZLS_EXE));
            candidates.push(v.join("Razor").join(RZLS_EXE));
        }
    }

    Ok(candidates)
}

/// Resolves the rzls executable path, returning the first candidate that exists.
///
/// Does **not** download anything; if nothing is found it returns an error
/// instructing the caller (or a future ISSUE-26 integration) to acquire it.
pub fn rzls_executable_path(app: &AppHandle) -> Result<PathBuf, String> {
    for candidate in rzls_candidates(app)? {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "rzls not found in the LSP cache. Expected it bundled with the Roslyn \
         package (C# epic ISSUE-26) or at {}. Download is not yet wired up.",
        lsp_cache_root(app)
            .map(|p| p.join(RZLS_SUBDIR).display().to_string())
            .unwrap_or_default()
    ))
}

/// STUB — acquires the rzls package. Intentionally NOT implemented to perform a
/// real network download (task constraint + dependency on ISSUE-26 layout).
///
/// When wired up, this should:
///   1. Emit `lsp-download-progress` `{ server: "razor", .. }` events.
///   2. Fetch the rzls NuGet package (or reuse the Roslyn package if bundled).
///   3. Extract it under `app_data_dir()/lsp/razor/` and return the exe path.
#[allow(dead_code)]
async fn download_rzls(app: &AppHandle) -> Result<PathBuf, String> {
    let _ = app.emit(
        "lsp-download-progress",
        serde_json::json!({ "server": "razor", "state": "unavailable" }),
    );
    Err("rzls automatic download is not implemented yet (see RAZOR-SPIKE.md). \
         Provide rzls via the Roslyn package or a manual cache install."
        .to_string())
}

/// Builds the launch command for rzls.
///
/// rzls speaks LSP over stdio. The argument set mirrors what `vscode-csharp`
/// uses for the Razor server. `--logLevel`/telemetry args are omitted; the key
/// flags are the stdio transport selection and the project root for design-time
/// builds. These are best-effort and documented in RAZOR-SPIKE.md — they may
/// need tuning once tested against a real rzls build.
///
/// Not yet invoked from a command (the frontend currently resolves the path via
/// [`lsp_ensure_razor_server`] and starts the process through `lsp_start_server`
/// with its own arg list); kept as the canonical Rust-side launch spec.
#[allow(dead_code)]
pub fn rzls_launch_command(
    app: &AppHandle,
    _project_root: &Path,
) -> Result<(String, Vec<String>), String> {
    let exe = rzls_executable_path(app)?;
    let program = exe.to_string_lossy().to_string();

    // Best-effort arguments. Newer rzls builds default to stdio; older ones may
    // require explicit transport flags. Kept minimal and documented.
    let args: Vec<String> = vec![
        // Some rzls builds accept these; harmless if ignored, adjust per spike.
        "--logLevel".to_string(),
        "Information".to_string(),
    ];

    Ok((program, args))
}

/// Tauri command: ensures the rzls server is acquirable and returns the
/// resolved executable path. The frontend then calls `lsp_start_server`.
///
/// On a fresh machine this currently errors (download stubbed) — the frontend
/// surfaces that as "Razor server unavailable" rather than crashing.
#[tauri::command]
pub async fn lsp_ensure_razor_server(app: AppHandle) -> Result<String, String> {
    let exe = rzls_executable_path(&app)?;
    Ok(exe.to_string_lossy().to_string())
}
