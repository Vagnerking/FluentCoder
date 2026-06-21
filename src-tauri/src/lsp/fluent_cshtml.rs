//! Resolves the launch command for the built-in `fluent-cshtml-lsp` server.
//!
//! The server binary is compiled alongside the Tauri app and lives in the same
//! directory as the main executable (sidecar pattern). No download or npm step
//! is needed — resolution is always synchronous and instant.

use tauri::AppHandle;

/// Returns `(program, args)` ready for `LspProcess::spawn`.
///
/// In development (`debug_assertions`), looks for the binary in the Cargo
/// `target/debug/` directory. In release it expects the binary next to the main
/// executable (bundled by Tauri's `externalBin` sidecar mechanism or placed
/// there by the CI build script).
pub fn resolve_launch(_app: &AppHandle) -> Result<(String, Vec<String>), String> {
    let bin_name = if cfg!(windows) {
        "fluent-cshtml-lsp.exe"
    } else {
        "fluent-cshtml-lsp"
    };

    // 1. Same directory as the running executable (release / sidecar path).
    if let Ok(exe_dir) = std::env::current_exe().map(|p| {
        p.parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_default()
    }) {
        let candidate = exe_dir.join(bin_name);
        if candidate.is_file() {
            return Ok((candidate.to_string_lossy().into_owned(), vec![]));
        }
    }

    // 2. Debug build: target/debug/ relative to the workspace root.
    //    `CARGO_MANIFEST_DIR` is set at compile time for debug builds.
    if cfg!(debug_assertions) {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let debug_bin = std::path::Path::new(manifest_dir)
            .join("target")
            .join("debug")
            .join(bin_name);
        if debug_bin.is_file() {
            return Ok((debug_bin.to_string_lossy().into_owned(), vec![]));
        }
        // Also try the workspace-level target directory (one level up from src-tauri).
        let workspace_debug_bin = std::path::Path::new(manifest_dir)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default()
            .join("target")
            .join("debug")
            .join(bin_name);
        if workspace_debug_bin.is_file() {
            return Ok((workspace_debug_bin.to_string_lossy().into_owned(), vec![]));
        }
    }

    Err(format!(
        "fluent-cshtml-lsp binary not found. In debug, run `cargo build --bin fluent-cshtml-lsp` first."
    ))
}
