//! Acquisition of the Roslyn C# language server
//! (`Microsoft.CodeAnalysis.LanguageServer`).
//!
//! The server is distributed as a NuGet package (a ZIP). On first use it is
//! downloaded, hash-verified, and extracted into
//! `app_data_dir()/lsp/roslyn/<version>/`; subsequent launches reuse the cache.
//!
//! The package is the per-RID NuGet build published to nuget.org's flat
//! container (verified: `…win-x64/5.0.0-1.25277.114` downloads as a 62.7 MB
//! `.nupkg`). The server executable ships at
//! `content/LanguageServer/<rid>/Microsoft.CodeAnalysis.LanguageServer.exe`,
//! self-contained (no `dotnet exec` needed). `--logLevel` AND
//! `--extensionLogDirectory` are both REQUIRED by the server's CLI; omitting the
//! log directory makes it exit immediately.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Pinned Roslyn LSP version. Update together with `ROSLYN_SHA256` and the URL.
/// `5.0.0-1.25277.114` is the version published for the per-RID packages on
/// nuget.org's flat container.
const ROSLYN_VERSION: &str = "5.0.0-1.25277.114";

/// NuGet package id for the platform-specific Roslyn LSP build.
/// Microsoft ships per-RID packages: `Microsoft.CodeAnalysis.LanguageServer.<rid>`.
fn roslyn_package_id() -> &'static str {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        "microsoft.codeanalysis.languageserver.win-x64"
    }
    #[cfg(all(windows, target_arch = "aarch64"))]
    {
        "microsoft.codeanalysis.languageserver.win-arm64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "microsoft.codeanalysis.languageserver.linux-x64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "microsoft.codeanalysis.languageserver.osx-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "microsoft.codeanalysis.languageserver.osx-x64"
    }
}

/// Expected SHA-256 of the downloaded `.nupkg`, per RID (the hash differs per
/// platform package). A zeroed value means "unverified" — verification is
/// skipped for that RID until a real hash is pinned. Only `win-x64` was
/// downloaded and verified in this environment.
fn roslyn_sha256() -> &'static str {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        // Verified against api.nuget.org flat-container, 62.7 MB .nupkg.
        "7c96c59532a81f710be95a48e6dd25c4e4d17875a37f5a7171a90e82f8ab57a6"
    }
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        // Unverified for this RID — fill in after downloading the real package.
        "0000000000000000000000000000000000000000000000000000000000000000"
    }
}

/// Builds the NuGet flat-container download URL for the pinned version.
fn roslyn_download_url() -> String {
    let id = roslyn_package_id();
    format!(
        "https://api.nuget.org/v3-flatcontainer/{id}/{ver}/{id}.{ver}.nupkg",
        id = id,
        ver = ROSLYN_VERSION
    )
}

/// Name of the server executable inside the extracted package.
fn server_executable_name() -> &'static str {
    #[cfg(windows)]
    {
        "Microsoft.CodeAnalysis.LanguageServer.exe"
    }
    #[cfg(not(windows))]
    {
        "Microsoft.CodeAnalysis.LanguageServer"
    }
}

/// Cache directory for the pinned Roslyn version.
fn roslyn_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(base.join("lsp").join("roslyn").join(ROSLYN_VERSION))
}

/// Recursively searches `dir` for the server executable.
fn find_executable(dir: &Path) -> Option<PathBuf> {
    let target = server_executable_name();
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

/// Emits a download-progress event to the frontend.
fn emit_progress(app: &AppHandle, state: &str, message: &str) {
    let _ = app.emit(
        "lsp-download-progress",
        serde_json::json!({ "server": "csharp", "state": state, "message": message }),
    );
}

/// Ensures the Roslyn server is present in the cache, downloading and extracting
/// it on first use. Returns the path to the server executable.
pub async fn ensure_roslyn_server(app: &AppHandle) -> Result<PathBuf, String> {
    let cache_dir = roslyn_cache_dir(app)?;

    // Cache hit: executable already extracted.
    if cache_dir.exists() {
        if let Some(exe) = find_executable(&cache_dir) {
            return Ok(exe);
        }
    }

    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("failed to create cache dir: {e}"))?;

    // --- Download ---
    emit_progress(app, "downloading", "Baixando o servidor C# (Roslyn)…");
    let url = roslyn_download_url();
    let bytes = download_bytes(&url).await.map_err(|e| {
        let msg = format!("Não foi possível baixar o servidor C#. Verifique a conexão. ({e})");
        emit_progress(app, "error", &msg);
        msg
    })?;

    // --- Verify hash (skipped for RIDs whose hash isn't pinned yet) ---
    let expected = roslyn_sha256();
    if expected != "0000000000000000000000000000000000000000000000000000000000000000" {
        let actual = sha256_hex(&bytes);
        if actual != expected {
            let msg = format!("Download corrompido (hash {actual} != esperado {expected}).");
            emit_progress(app, "error", &msg);
            return Err(msg);
        }
    }

    // --- Extract (the .nupkg is a ZIP) — on a blocking thread so the synchronous
    //     std::fs/zip I/O doesn't stall the async runtime (CodeRabbit). ---
    emit_progress(app, "extracting", "Extraindo o servidor C#…");
    let extract_dir = cache_dir.clone();
    tokio::task::spawn_blocking(move || extract_zip(&bytes, &extract_dir))
        .await
        .map_err(|e| format!("tarefa de extração falhou: {e}"))?
        .map_err(|e| {
            let msg = format!("Falha ao extrair o servidor C#: {e}");
            emit_progress(app, "error", &msg);
            msg
        })?;

    let exe = find_executable(&cache_dir).ok_or_else(|| {
        let msg = "Executável do servidor C# não encontrado após a extração.".to_string();
        emit_progress(app, "error", &msg);
        msg
    })?;

    emit_progress(app, "ready", "Servidor C# pronto.");
    Ok(exe)
}

/// Downloads a URL fully into memory.
pub(crate) async fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let resp = reqwest::get(url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}

/// Computes the lowercase hex SHA-256 of a byte slice.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Extracts a ZIP (the NuGet package) into `dest`.
pub(crate) fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(enclosed) = file.enclosed_name() else {
            continue; // skip unsafe paths
        };
        let out_path = dest.join(enclosed);
        if file.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Locates `dotnet` on the PATH. Returns a descriptive error if absent.
pub fn detect_dotnet() -> Result<String, String> {
    let program = if cfg!(windows) {
        "dotnet.exe"
    } else {
        "dotnet"
    };

    // `dotnet --version` succeeds iff the SDK/runtime is reachable.
    let mut command = std::process::Command::new(program);
    command.arg("--version");
    crate::child_process::hide_console_window(&mut command);
    let probe = command.output();

    match probe {
        Ok(out) if out.status.success() => Ok(program.to_string()),
        _ => Err(
            "Para usar o IntelliSense C#, instale o .NET SDK (https://dotnet.microsoft.com/download)."
                .to_string(),
        ),
    }
}

// ---- Razor cohosting via the C# extension's bundled Roslyn (issue #11) ----
//
// The standalone `rzls` is dead (deprecated 2020). The modern path is the Roslyn
// LSP itself serving Razor ("cohosting"). The C# extension's Roslyn build
// supports it, so we acquire the C# extension VSIX — it bundles a *matched*
// Roslyn LSP + the Razor extension under `extension/.roslyn/` — and launch Roslyn
// with the Razor cohosting args. One server then handles both C# and `.cshtml`.
// `--razorDesignTimePath` points at the installed .NET SDK's Razor targets.

/// Pinned C# extension version whose bundled Roslyn supports Razor cohosting.
const CSHARP_EXT_VERSION: &str = "2.144.9";

/// VS Marketplace target-platform tag for the current OS/arch (None if unknown).
fn csharp_ext_target_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("win32-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        _ => None,
    }
}

fn csharp_ext_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(base.join("lsp").join("csharp-ext").join(CSHARP_EXT_VERSION))
}

/// The bundled Roslyn apphost file name inside the VSIX's `.roslyn/` folder.
fn roslyn_apphost_name() -> &'static str {
    if cfg!(windows) {
        "Microsoft.CodeAnalysis.LanguageServer.exe"
    } else {
        "Microsoft.CodeAnalysis.LanguageServer"
    }
}

/// The cached `.roslyn/` dir from the C# extension, if its apphost is present.
fn csharp_ext_roslyn_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = csharp_ext_cache_dir(app)
        .ok()?
        .join("extension")
        .join(".roslyn");
    if dir.join(roslyn_apphost_name()).is_file() {
        Some(dir)
    } else {
        None
    }
}

/// Ensures the C# extension (Roslyn + Razor) is cached, downloading the VSIX on
/// first use. Returns its `.roslyn/` directory. On any failure, the partial
/// cache dir is removed so a later attempt starts clean (a half-extracted dir
/// would otherwise linger and mask the real state).
async fn ensure_csharp_ext(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = csharp_ext_roslyn_dir(app) {
        return Ok(dir);
    }
    let cache = csharp_ext_cache_dir(app)?;
    match download_and_extract_csharp_ext(app, &cache).await {
        Ok(dir) => Ok(dir),
        Err(e) => {
            // Best-effort cleanup of the partial/empty dir so the next launch
            // re-downloads from scratch instead of inspecting a broken cache.
            let _ = tokio::fs::remove_dir_all(&cache).await;
            Err(e)
        }
    }
}

async fn download_and_extract_csharp_ext(app: &AppHandle, cache: &Path) -> Result<PathBuf, String> {
    let platform = csharp_ext_target_platform()
        .ok_or_else(|| "sem build da extensão C# para esta plataforma".to_string())?;
    tokio::fs::create_dir_all(cache)
        .await
        .map_err(|e| format!("failed to create C# ext cache: {e}"))?;

    let url = format!(
        "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-dotnettools/vsextensions/csharp/{ver}/vspackage?targetPlatform={plat}",
        ver = CSHARP_EXT_VERSION,
        plat = platform
    );
    emit_progress(
        app,
        "downloading",
        "Baixando o servidor C#/Razor (cohosting)…",
    );
    // The marketplace serves the .vsix with `Content-Encoding: gzip`; reqwest's
    // `gzip` feature (enabled in Cargo.toml) transparently decompresses it so the
    // bytes below are the raw ZIP. Without it, extraction fails and Razor silently
    // regresses to standalone Roslyn.
    let bytes = download_bytes(&url).await.map_err(|e| {
        let m = format!("Não foi possível baixar o servidor C#/Razor. ({e})");
        emit_progress(app, "error", &m);
        m
    })?;
    // Extract on a blocking thread (synchronous zip I/O off the async runtime).
    emit_progress(app, "extracting", "Extraindo o servidor C#/Razor…");
    let extract_dir = cache.to_path_buf();
    tokio::task::spawn_blocking(move || extract_zip(&bytes, &extract_dir))
        .await
        .map_err(|e| format!("tarefa de extração falhou: {e}"))?
        .map_err(|e| {
            let m = format!("Falha ao extrair o servidor C#/Razor: {e}");
            emit_progress(app, "error", &m);
            m
        })?;
    csharp_ext_roslyn_dir(app)
        .ok_or_else(|| "Roslyn não encontrado após extrair a extensão C#.".to_string())
}

/// Builds the Roslyn launch command with Razor cohosting enabled (issue #11) —
/// one Roslyn server handling both C# and `.cshtml`. The arg shape mirrors what
/// the C# extension uses in *standalone* mode (reverse-engineered from the bundled
/// `extension.js` and verified against the server's `--help`): load the Razor
/// extension assembly via `--extension` — which turns on cohosting (default in
/// this build) and finds its own bundled Razor design-time targets — and point
/// `--csharpDesignTimePath` at the extension's C# targets. The older
/// `--razorSourceGenerator`/`--razorDesignTimePath` flags do NOT exist on this
/// Roslyn (confirmed via `--help`) and would make it exit immediately.
pub async fn cohosting_launch_command(app: &AppHandle) -> Result<(String, Vec<String>), String> {
    let roslyn_dir = ensure_csharp_ext(app).await?;
    let exe = roslyn_dir.join(roslyn_apphost_name());
    let razor_extension = roslyn_dir.join("Microsoft.VisualStudioCode.RazorExtension.dll");
    if !razor_extension.is_file() {
        return Err("RazorExtension.dll ausente no pacote da extensão C#.".to_string());
    }
    let csharp_designtime = roslyn_dir
        .join("Targets")
        .join("Microsoft.CSharpExtension.DesignTime.targets");

    let log_dir = roslyn_dir.join("logs");
    let _ = tokio::fs::create_dir_all(&log_dir).await;

    let mut args = vec![
        "--logLevel".to_string(),
        "Information".to_string(),
        "--extensionLogDirectory".to_string(),
        log_dir.to_string_lossy().to_string(),
        "--stdio".to_string(),
        "--extension".to_string(),
        razor_extension.to_string_lossy().to_string(),
    ];
    if csharp_designtime.is_file() {
        args.push("--csharpDesignTimePath".to_string());
        args.push(csharp_designtime.to_string_lossy().to_string());
    }
    emit_progress(app, "ready", "Servidor C#/Razor pronto.");
    Ok((exe.to_string_lossy().to_string(), args))
}

/// Launch command for the standalone Roslyn 5.0.0 (C# only, no Razor cohosting).
///
/// `--logLevel` and `--extensionLogDirectory` are REQUIRED by the server CLI —
/// the process exits immediately without them. The per-RID exe is self-contained,
/// so no `dotnet exec` wrapper is needed.
pub async fn standalone_launch_command(app: &AppHandle) -> Result<(String, Vec<String>), String> {
    // Don't hard-fail if dotnet is missing — the bundled server still starts;
    // log a hint instead. (detect_dotnet returns Err with an install message.)
    if let Err(hint) = detect_dotnet() {
        eprintln!("[lsp/csharp] {hint}");
    }

    let exe = ensure_roslyn_server(app).await?;
    let program = exe.to_string_lossy().to_string();

    // Log directory is REQUIRED by the server CLI. Keep it beside the cache.
    let log_dir = roslyn_cache_dir(app)?.join("logs");
    tokio::fs::create_dir_all(&log_dir)
        .await
        .map_err(|e| format!("failed to create Roslyn log dir: {e}"))?;

    let args = vec![
        "--logLevel".to_string(),
        "Information".to_string(),
        "--extensionLogDirectory".to_string(),
        log_dir.to_string_lossy().to_string(),
        "--stdio".to_string(),
    ];
    Ok((program, args))
}

/// Resolves the launch command for the C# Roslyn LSP (standalone, no Razor).
///
/// Uses standalone Roslyn 5.0.0 (`Microsoft.CodeAnalysis.LanguageServer`) which
/// correctly emits `DocumentCompilerSemantic` diagnostics. Razor is served by a
/// separate cohosting instance started via `lsp_ensure_razor_server`.
pub async fn roslyn_launch_command(
    app: &AppHandle,
    _project_root: &Path,
) -> Result<(String, Vec<String>), String> {
    standalone_launch_command(app).await
}
