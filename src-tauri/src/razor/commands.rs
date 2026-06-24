//! Tauri command bridge for the projection broker (ADR 0002).
//!
//! `razor_prepare` runs the (blocking) pipeline off the UI thread via
//! `spawn_blocking`, stashes one [`RazorSourceMap`] per `.cshtml` in app state,
//! and returns a serializable summary (shadow/solution paths + which `.cshtml`
//! got a projection vs not). The Monaco providers then call the fast
//! `razor_remap_*` commands to map positions between the `.cshtml` and the
//! projected C# the Roslyn client analyzes (over `solution_path`).
//!
//! Single source of truth: remapping stays in Rust (no duplicated logic in TS).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::Serialize;
use tauri::State;

use super::remap::{self, LspPos};
use super::runtime;
use super::sidecar::{FileSpec, ProjectInputs, Sidecar};
use super::sourcemap::RazorSourceMap;

/// Everything the live sidecar needs to re-emit ONE `.cshtml` from buffer text.
/// Captured at `razor_prepare` so a keystroke `razor_emit_live` needs no re-derive.
#[derive(Clone)]
struct ProjectionContext {
    inputs: ProjectInputs,
    /// Absolute `.cshtml` path (the file to re-emit).
    cshtml_abs: String,
}

/// App-managed broker state.
#[derive(Default)]
pub struct RazorState {
    /// The ACTIVE source map per open `.cshtml` — what `razor_remap_*` (hover/
    /// completion/definition) read. Only ever the map for the `.g.cs` Roslyn has
    /// open, so remapping stays in lockstep with the projection.
    maps: Mutex<HashMap<String, RazorSourceMap>>,
    /// PENDING live-emit maps awaiting commit: `key → (generation, map)`. A live
    /// emit parks its map here; the frontend promotes it to `maps` via
    /// `razor_commit_live_map` ONLY after it synced Roslyn with the matching text.
    /// A dropped/stale response never gets committed, so `maps` can't run ahead of
    /// the `.g.cs` Roslyn actually has open (Codex).
    pending: Mutex<HashMap<String, (u64, RazorSourceMap)>>,
    /// Per-`.cshtml` live-emit context (refs/globals/files) captured at prepare.
    contexts: Mutex<HashMap<String, ProjectionContext>>,
    /// Monotonic generation stamped on each live emit; the frontend uses it to drop
    /// stale out-of-order responses and to commit the matching pending map.
    generation: AtomicU64,
    /// The live emit process host (Arc so build can run on a blocking task).
    sidecar: Arc<Sidecar>,
}

impl RazorState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Kill the live sidecar process (app teardown / reset).
    pub fn shutdown_sidecar(&self) {
        self.sidecar.shutdown();
    }

    /// A shared handle to the sidecar (for off-thread build/emit).
    fn clone_sidecar_ref(&self) -> Arc<Sidecar> {
        Arc::clone(&self.sidecar)
    }
}

/// Windows-insensitive key for a `.cshtml` path (lowercase, forward slashes).
fn canonical_key(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_ascii_lowercase()
}

/// Stable FNV-1a hex of a normalized path — names the per-project shadow dir.
fn path_hash(p: &Path) -> String {
    let s = canonical_key(p);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Where the broker materializes its shadow project for `user_project_dir`.
///
/// MUST live OUTSIDE the user's source tree: if the shadow's projected `.g.cs`
/// sat under the opened folder (the common case where the workspace IS the
/// project), the user project's SDK would glob it and hit duplicate-type errors
/// for the Razor page class. The OS temp dir, keyed per project, is always safe
/// and is reused across prepares (incremental). The frontend's `workspace_dir`
/// is no longer used to place the shadow.
fn shadow_workspace_for(user_project_dir: &Path) -> PathBuf {
    std::env::temp_dir()
        .join("fluent-razor")
        .join(path_hash(user_project_dir))
}

/// One materialized projection the frontend can serve: the `.cshtml` it came
/// from plus the projected `.g.cs` the Roslyn client must `didOpen`/address.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RazorProjectionInfo {
    /// `.cshtml` path relative to the user project (as requested).
    pub cshtml_rel: String,
    /// Absolute `.cshtml` path — the exact key the `razor_remap_*` commands use.
    pub cshtml_path: String,
    /// Absolute path to the projected C# inside the shadow (what Roslyn opens).
    pub generated_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RazorPrepareResult {
    pub shadow_dir: String,
    pub solution_path: String,
    /// `.cshtml` that got a usable projection (with the projected `.g.cs` path).
    pub available: Vec<RazorProjectionInfo>,
    /// `.cshtml` (relative) requested but with no projection (degraded).
    pub missing: Vec<String>,
}

#[derive(Serialize)]
pub struct RemapPos {
    pub line: u32,
    pub character: u32,
}

/// Prepare projection serving for `cshtml_rels` (relative to `user_project_dir`)
/// and cache their source maps. Runs `dotnet` off the UI thread.
#[tauri::command]
pub async fn razor_prepare(
    state: State<'_, RazorState>,
    // Kept for the binding's shape, but the shadow is materialized in the OS temp
    // dir (see `shadow_workspace_for`) — NEVER inside the opened folder, which
    // would let the user project's SDK glob the projected `.g.cs`.
    workspace_dir: String,
    user_project_dir: String,
    user_csproj_path: String,
    config: String,
    cshtml_rels: Vec<String>,
) -> Result<RazorPrepareResult, String> {
    let _ = workspace_dir;
    let project_dir = user_project_dir.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let rels: Vec<PathBuf> = cshtml_rels.iter().map(PathBuf::from).collect();
        let shadow_ws = shadow_workspace_for(Path::new(&project_dir));
        runtime::prepare(
            &shadow_ws,
            Path::new(&project_dir),
            Path::new(&user_csproj_path),
            &config,
            &rels,
        )
    })
    .await
    .map_err(|e| format!("razor prepare join error: {e}"))?
    .map_err(|e| e.to_string())?;

    let missing: Vec<String> = prepared
        .missing
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    // Shared per-project file specs: every .cshtml that got a projection + the
    // project-level _ViewImports/_ViewStart, each with its base64 TargetPath.
    let proj_dir_path = Path::new(&user_project_dir);
    let mut shared_files: Vec<FileSpec> = Vec::new();
    let mut view_imports: Option<(String, String)> = None;
    let mut view_start: Option<(String, String)> = None;
    for rel in ["Views/_ViewImports.cshtml", "_ViewImports.cshtml"] {
        let p = proj_dir_path.join(rel);
        if p.exists() {
            if let Ok(text) = std::fs::read_to_string(&p) {
                shared_files.push(FileSpec {
                    path: p.to_string_lossy().to_string(),
                    target_path_b64: target_path_b64(rel),
                });
                view_imports = Some((p.to_string_lossy().to_string(), text));
            }
            break;
        }
    }
    for rel in ["Views/_ViewStart.cshtml", "_ViewStart.cshtml"] {
        let p = proj_dir_path.join(rel);
        if p.exists() {
            if let Ok(text) = std::fs::read_to_string(&p) {
                shared_files.push(FileSpec {
                    path: p.to_string_lossy().to_string(),
                    target_path_b64: target_path_b64(rel),
                });
                view_start = Some((p.to_string_lossy().to_string(), text));
            }
            break;
        }
    }

    let d = &prepared.derived;
    let mut available = Vec::new();
    {
        let mut maps = state.maps.lock().map_err(|_| "razor state poisoned".to_string())?;
        let mut pending = state.pending.lock().map_err(|_| "razor state poisoned".to_string())?;
        let mut contexts = state.contexts.lock().map_err(|_| "razor state poisoned".to_string())?;
        for proj in prepared.projections {
            let abs = Path::new(&user_project_dir).join(&proj.cshtml_rel);
            let key = canonical_key(&abs);
            let rel_str = proj.cshtml_rel.to_string_lossy().to_string();
            // A fresh prepare (open/save) is authoritative: drop any in-flight
            // pending live map so a late live commit can't clobber it.
            pending.remove(&key);

            // Per-cshtml file list = shared + this file (its own TargetPath).
            let mut files = shared_files.clone();
            files.push(FileSpec {
                path: abs.to_string_lossy().to_string(),
                target_path_b64: target_path_b64(&rel_str),
            });

            let inputs = ProjectInputs {
                project_dir: user_project_dir.clone(),
                references: d.reference_paths.clone(),
                root_namespace: d.root_namespace.clone(),
                razor_lang_version: if d.razor_lang_version.is_empty() {
                    "8.0".to_string()
                } else {
                    d.razor_lang_version.clone()
                },
                using_microsoft_net_sdk_web: d.using_microsoft_net_sdk_web,
                tfm: d.tfm.clone(),
                view_imports_path: view_imports.as_ref().map(|(p, _)| p.clone()),
                view_imports_text: view_imports.as_ref().map(|(_, t)| t.clone()),
                view_start_path: view_start.as_ref().map(|(p, _)| p.clone()),
                view_start_text: view_start.as_ref().map(|(_, t)| t.clone()),
                files,
            };
            contexts.insert(
                key.clone(),
                ProjectionContext { inputs, cshtml_abs: abs.to_string_lossy().to_string() },
            );

            maps.insert(key, proj.source_map);
            available.push(RazorProjectionInfo {
                cshtml_rel: rel_str,
                cshtml_path: abs.to_string_lossy().to_string(),
                generated_path: proj.shadow_gcs.to_string_lossy().to_string(),
            });
        }
    }

    Ok(RazorPrepareResult {
        shadow_dir: prepared.plan.shadow_dir.to_string_lossy().to_string(),
        solution_path: prepared.plan.solution_path.to_string_lossy().to_string(),
        available,
        missing,
    })
}

/// Base64 of the project-relative path with backslash separators — the
/// `build_metadata.AdditionalFiles.TargetPath` the Razor generator reads (it
/// derives the generated class name + route from this). MUST be `\`-separated.
fn target_path_b64(rel: &str) -> String {
    let backslashed = rel.replace('/', "\\");
    base64::engine::general_purpose::STANDARD.encode(backslashed.as_bytes())
}

/// Result of a live emit: the fresh projected C# + the generation it was applied
/// under. The frontend feeds `generated_text` straight into Roslyn (didOpen) and
/// uses `generation`/`ok` to drop stale out-of-order responses.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmitLiveResult {
    pub generated_text: String,
    pub generation: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Re-emit `cshtml_path`'s projection from the in-memory `text` via the live
/// sidecar (no `dotnet build`), reparse the `#line` map, and install it under a
/// fresh generation — atomically, so the returned text and the cached map are the
/// same generation. The caller didOpens `generated_text` into Roslyn and re-pulls
/// diagnostics. Returns `ok:false` (never errs hard) so the caller can fall back
/// to the on-save `dotnet build` path without surfacing an exception.
#[tauri::command]
pub async fn razor_emit_live(
    state: State<'_, RazorState>,
    cshtml_path: String,
    text: String,
) -> Result<EmitLiveResult, String> {
    let key = canonical_key(Path::new(&cshtml_path));
    let ctx = {
        let contexts = state.contexts.lock().map_err(|_| "razor state poisoned".to_string())?;
        match contexts.get(&key) {
            Some(c) => c.clone(),
            None => {
                // No prepared context (e.g. before the first prepare) — let the
                // caller fall back to reprepare.
                return Ok(EmitLiveResult {
                    generated_text: String::new(),
                    generation: 0,
                    ok: false,
                    error: Some("no projection context (reprepare first)".to_string()),
                });
            }
        }
    };

    // Sidecar call (fast ~ms). Runs on Tauri's async worker, not the UI thread.
    let generated = match state.sidecar.emit(&ctx.inputs, &ctx.cshtml_abs, &text) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("[razor:live] emit FAILED: {e}");
            return Ok(EmitLiveResult {
                generated_text: String::new(),
                generation: 0,
                ok: false,
                error: Some(e),
            });
        }
    };
    if generated.is_empty() {
        // The sidecar ran but produced nothing (e.g. a generator error on a
        // transient invalid buffer). Don't blank Roslyn's view with empty text —
        // return ok:false so the caller KEEPS the last good projection. The next
        // valid edit re-emits a real `.g.cs`.
        eprintln!("[razor:live] emit produced EMPTY .g.cs for {}", ctx.cshtml_abs);
        return Ok(EmitLiveResult {
            generated_text: String::new(),
            generation: 0,
            ok: false,
            error: Some("sidecar produced empty .g.cs".to_string()),
        });
    }

    // Parse the map from the EXACT text we return, PARK it as pending under a fresh
    // generation, and return the text+gen. The frontend commits the pending map
    // (razor_commit_live_map) only after it synced Roslyn with this text — so the
    // ACTIVE map never runs ahead of the `.g.cs` Roslyn has open. A dropped/stale
    // response simply never commits (and is overwritten by the next pending).
    let map = RazorSourceMap::parse(&generated, &cshtml_path);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut pending = state.pending.lock().map_err(|_| "razor state poisoned".to_string())?;
        pending.insert(key, (generation, map));
    }
    Ok(EmitLiveResult { generated_text: generated, generation, ok: true, error: None })
}

/// Promote the pending live map for `cshtml_path` to ACTIVE — called by the
/// frontend after it synced Roslyn with the matching `generation`'s text. No-op if
/// the pending entry is for a different (newer) generation (a stale commit).
#[tauri::command]
pub fn razor_commit_live_map(
    state: State<'_, RazorState>,
    cshtml_path: String,
    generation: u64,
) -> Result<bool, String> {
    let key = canonical_key(Path::new(&cshtml_path));
    let map = {
        let mut pending = state.pending.lock().map_err(|_| "razor state poisoned".to_string())?;
        match pending.get(&key) {
            // Only commit if the pending map is exactly this generation. Take it out
            // so a later stale commit for the same gen can't double-apply.
            Some((g, _)) if *g == generation => pending.remove(&key).map(|(_, m)| m),
            _ => None,
        }
    };
    match map {
        Some(m) => {
            let mut maps = state.maps.lock().map_err(|_| "razor state poisoned".to_string())?;
            maps.insert(key, m);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Warm the live sidecar for `cshtml_path` (pays the cold generator cost up front
/// so the first keystroke is fast). Best-effort; errors are swallowed.
#[tauri::command]
pub async fn razor_warm(state: State<'_, RazorState>, cshtml_path: String) -> Result<(), String> {
    let key = canonical_key(Path::new(&cshtml_path));
    let ctx = {
        let contexts = state.contexts.lock().map_err(|_| "razor state poisoned".to_string())?;
        contexts.get(&key).cloned()
    };
    if let Some(ctx) = ctx {
        // Warm with the current on-disk text (the buffer may differ, but warming
        // primes the driver/TagHelper scan regardless of exact content).
        let seed = std::fs::read_to_string(&ctx.cshtml_abs).unwrap_or_default();
        let _ = state.sidecar.warm(&ctx.inputs, &ctx.cshtml_abs, &seed);
    }
    Ok(())
}

/// Build the live sidecar binary on first use (off the UI thread). The sidecar
/// source dir is resolved from the app (bundled resource in prod, the repo's
/// `tools/razor-sidecar` in dev); it builds into the app data dir. Soft-fails
/// (returns false) so the caller stays on the on-save `dotnet build` path.
#[tauri::command]
pub async fn razor_ensure_sidecar(
    app: tauri::AppHandle,
    state: State<'_, RazorState>,
) -> Result<bool, String> {
    use tauri::Manager;
    let cache = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[razor:sidecar] no app_data_dir: {e}");
            return Ok(false);
        }
    };
    let src_root = resolve_sidecar_source_root(&app);
    match src_root {
        Some(root) => {
            let s = state.clone_sidecar_ref();
            // Build off the UI thread (dotnet build can take seconds the first time).
            let result = tauri::async_runtime::spawn_blocking(move || {
                s.ensure_built(&root, &cache)
            })
            .await
            .map_err(|e| format!("razor sidecar build join error: {e}"))?;
            match result {
                Ok(_) => Ok(true),
                Err(e) => {
                    eprintln!("[razor:sidecar] build failed: {e}");
                    Ok(false)
                }
            }
        }
        None => {
            eprintln!("[razor:sidecar] sidecar source not found (resource/dev)");
            Ok(false)
        }
    }
}

/// Find the `tools/razor-sidecar` source dir: bundled resource (prod) or the
/// repo's dir (dev). Returns the dir that CONTAINS `tools/razor-sidecar` (the
/// `ensure_built` joins `SIDECAR_SUBDIR`).
fn resolve_sidecar_source_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    // Prod: bundled under the resource dir (tauri.conf bundles `tools/razor-sidecar`).
    if let Ok(res) = app.path().resource_dir() {
        if res.join("tools/razor-sidecar/RazorSidecar.csproj").exists() {
            return Some(res);
        }
    }
    // Dev: the repo root, found by walking up from the crate dir to a dir that has
    // `tools/razor-sidecar`.
    let mut dir = Some(Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf());
    while let Some(d) = dir {
        if d.join("tools/razor-sidecar/RazorSidecar.csproj").exists() {
            return Some(d);
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }
    None
}

/// Map a `.cshtml` position (0-based LSP) to the projected C#. `None` if unmapped
/// or the document has no cached map.
#[tauri::command]
pub fn razor_remap_to_generated(
    state: State<'_, RazorState>,
    cshtml_path: String,
    line: u32,
    character: u32,
) -> Option<RemapPos> {
    let maps = state.maps.lock().ok()?;
    let map = maps.get(&canonical_key(Path::new(&cshtml_path)))?;
    remap::source_pos_to_generated(map, LspPos::new(line, character))
        .map(|p| RemapPos { line: p.line, character: p.character })
}

/// Map a projected-C# position (0-based LSP) back to the `.cshtml`. `None` if it
/// lands in synthetic/unmapped C# or there is no cached map.
#[tauri::command]
pub fn razor_remap_to_source(
    state: State<'_, RazorState>,
    cshtml_path: String,
    line: u32,
    character: u32,
) -> Option<RemapPos> {
    let maps = state.maps.lock().ok()?;
    let map = maps.get(&canonical_key(Path::new(&cshtml_path)))?;
    remap::generated_pos_to_source(map, LspPos::new(line, character))
        .map(|p| RemapPos { line: p.line, character: p.character })
}

/// Drop a document's cached source map + live-emit context (on `.cshtml` close).
#[tauri::command]
pub fn razor_forget(state: State<'_, RazorState>, cshtml_path: String) {
    let key = canonical_key(Path::new(&cshtml_path));
    if let Ok(mut maps) = state.maps.lock() {
        maps.remove(&key);
    }
    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(&key);
    }
    if let Ok(mut contexts) = state.contexts.lock() {
        contexts.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_key_is_windows_insensitive() {
        assert_eq!(
            canonical_key(Path::new("C:\\WS\\Views\\Index.cshtml")),
            canonical_key(Path::new("c:/ws/views/index.cshtml"))
        );
    }

    #[test]
    fn shadow_workspace_is_outside_project_and_stable() {
        let proj = Path::new("C:\\src\\SampleMvc");
        let ws = shadow_workspace_for(proj);
        // Never inside the user's source tree (else the SDK globs the projection).
        assert!(
            !ws.starts_with(proj),
            "shadow workspace must not be under the project: {ws:?}"
        );
        assert!(ws.starts_with(std::env::temp_dir()));
        // Stable per project, Windows-insensitive (same project → same shadow).
        assert_eq!(ws, shadow_workspace_for(Path::new("c:/src/samplemvc")));
        // Distinct projects → distinct shadows.
        assert_ne!(ws, shadow_workspace_for(Path::new("C:\\src\\Other")));
    }
}
