//! netcoredbg acquisition (roadmap csharp-ide-parity, Fase B).
//!
//! Downloads Samsung's `netcoredbg` (MIT — usable outside VS/VS Code, unlike
//! Microsoft's proprietary `vsdbg`) from its GitHub release, verifies the
//! pinned SHA-256, extracts into the app cache and returns the executable
//! path. Mirrors the Roslyn download in `lsp/csharp.rs` (same helpers).

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::lsp::csharp::{download_bytes, extract_zip, sha256_hex};

/// Pinned release tag (github.com/Samsung/netcoredbg/releases).
const NETCOREDBG_VERSION: &str = "3.2.0-1092";

/// Per-platform release asset + its pinned SHA-256 (computed 03/07/2026 from
/// the published assets). A new version bump MUST re-pin all of these.
fn asset_for_platform() -> Result<(&'static str, &'static str), String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok((
            "netcoredbg-win64.zip",
            "3c410a45fa502415203a94fcb88654af65bf8e3dac158a5527a722e7a6b9274a",
        )),
        ("linux", "x86_64") => Ok((
            "netcoredbg-linux-amd64.tar.gz",
            "080eb3b2d2152465f599d3b33d1ee6e747794e11cc0a3773ec689f5e5f2c5afa",
        )),
        ("linux", "aarch64") => Ok((
            "netcoredbg-linux-arm64.tar.gz",
            "065ff49badec8a695dbea2de6ab6a330c774a191e426a217ab8cc05250627ccb",
        )),
        // The project publishes only an arm64 build for macOS (Rosetta runs it
        // on x64 hosts anyway, but we don't advertise that).
        ("macos", "aarch64") => Ok((
            "netcoredbg-osx-arm64.zip",
            "f4fa33b3ff874910cc184b4bb3b9c56d0abdf5c6521cee0b144d7c6e4a6e59ea",
        )),
        (os, arch) => Err(format!("netcoredbg: plataforma sem build publicado: {os}/{arch}")),
    }
}

fn download_url(asset: &str) -> String {
    format!(
        "https://github.com/Samsung/netcoredbg/releases/download/{NETCOREDBG_VERSION}/{asset}"
    )
}

fn executable_name() -> &'static str {
    if cfg!(windows) { "netcoredbg.exe" } else { "netcoredbg" }
}

/// Recursively locate the debugger executable inside the extracted tree.
fn find_executable(dir: &Path) -> Option<PathBuf> {
    let target = executable_name();
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_executable(&path) {
                return Some(found);
            }
        } else if path.file_name().and_then(|n| n.to_str()) == Some(target) {
            return Some(path);
        }
    }
    None
}

/// Extracts a `.tar.gz` (the Linux release assets) into `dest`.
fn extract_tar_gz(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
    let mut archive = tar::Archive::new(gz);
    archive.unpack(dest).map_err(|e| e.to_string())
}

/// Download-progress events for the frontend status bar (same channel shape as
/// the Roslyn download, distinguished by `server: "netcoredbg"`).
fn emit_progress(app: &AppHandle, state: &str, message: &str) {
    let _ = app.emit(
        "lsp-download-progress",
        serde_json::json!({ "server": "netcoredbg", "state": state, "message": message }),
    );
}

/// Ensures netcoredbg is present in the cache (download+verify+extract on first
/// use) and returns the executable path.
pub async fn ensure_netcoredbg(app: &AppHandle) -> Result<PathBuf, String> {
    let (asset, want_sha) = asset_for_platform()?;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("dap")
        .join("netcoredbg")
        .join(NETCOREDBG_VERSION);

    if let Some(exe) = find_executable(&base) {
        return Ok(exe);
    }

    emit_progress(app, "downloading", "Baixando o depurador .NET (netcoredbg)…");
    let url = download_url(asset);
    let bytes = download_bytes(&url).await.map_err(|e| {
        emit_progress(app, "error", &format!("Falha no download do netcoredbg: {e}"));
        format!("download de {url}: {e}")
    })?;

    let got = sha256_hex(&bytes);
    if got != want_sha {
        emit_progress(app, "error", "Verificação de integridade do netcoredbg falhou");
        return Err(format!(
            "netcoredbg {asset}: SHA-256 não confere (esperado {want_sha}, obtido {got})"
        ));
    }

    emit_progress(app, "extracting", "Extraindo o depurador .NET…");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let dest = base.clone();
    let is_targz = asset.ends_with(".tar.gz");
    let extract = tokio::task::spawn_blocking(move || {
        if is_targz {
            extract_tar_gz(&bytes, &dest)
        } else {
            extract_zip(&bytes, &dest)
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(e) = extract {
        // Never leave a half-extracted tree that a later run would trust.
        let _ = std::fs::remove_dir_all(&base);
        emit_progress(app, "error", "Extração do netcoredbg falhou");
        return Err(e);
    }

    let exe = find_executable(&base).ok_or_else(|| {
        let _ = std::fs::remove_dir_all(&base);
        "netcoredbg extraído mas o executável não foi encontrado".to_string()
    })?;
    emit_progress(app, "ready", "Depurador .NET pronto");
    Ok(exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_pinned_for_this_platform() {
        // The build machine must always resolve to a pinned asset+sha.
        let (asset, sha) = asset_for_platform().expect("platform supported");
        assert!(asset.starts_with("netcoredbg-"));
        assert_eq!(sha.len(), 64, "sha256 hex");
        assert!(download_url(asset).contains(NETCOREDBG_VERSION));
    }

    #[test]
    fn tar_gz_roundtrip_extracts() {
        // Build a tiny tar.gz in memory and extract it.
        let mut tar_bytes = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(&mut tar_bytes, flate2::Compression::fast());
            let mut builder = tar::Builder::new(enc);
            let data = b"#!/bin/sh\n";
            let mut header = tar::Header::new_gnu();
            header.set_path("bin/netcoredbg").unwrap();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append(&header, &data[..]).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let dest = std::env::temp_dir().join(format!(
            "netcoredbg-targz-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dest);
        extract_tar_gz(&tar_bytes, &dest).expect("extract");
        assert!(dest.join("bin/netcoredbg").exists());
        let _ = std::fs::remove_dir_all(&dest);
    }
}
