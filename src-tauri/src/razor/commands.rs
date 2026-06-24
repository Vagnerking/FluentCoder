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

/// Canonical map key for a `.cshtml` path: forward slashes, and case-folded ONLY
/// on case-insensitive filesystems (Windows). On Linux/macOS (case-sensitive),
/// `Views/Admin.cshtml` and `Views/admin.cshtml` are DISTINCT files, so folding
/// them together would collide their maps/pending/contexts (and shadow dir) and
/// serve the wrong projection.
fn canonical_key(p: &Path) -> String {
    let normalized = p.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        normalized.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized
    }
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

/// Where the broker materializes its shadow project for one user `.csproj`.
///
/// MUST live OUTSIDE the user's source tree: if the shadow's projected `.g.cs`
/// sat under the opened folder (the common case where the workspace IS the
/// project), the user project's SDK would glob it and hit duplicate-type errors
/// for the Razor page class. The OS temp dir, keyed per `.csproj`, is always safe
/// and is reused across prepares (incremental).
///
/// Keyed by the `.csproj` PATH (not its directory) so two distinct projects in the
/// same folder get separate shadows — otherwise the second would overwrite the
/// first's `ShadowRazor.csproj`/`RazorShadow.sln`/`.g.cs` and mix their
/// references/diagnostics. The frontend's `workspace_dir` is unused for placement.
fn shadow_workspace_for(user_csproj_path: &Path) -> PathBuf {
    std::env::temp_dir()
        .join("fluent-razor")
        .join(path_hash(user_csproj_path))
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
    let csproj_for_shadow = user_csproj_path.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let rels: Vec<PathBuf> = cshtml_rels.iter().map(PathBuf::from).collect();
        // Key the shadow by the .csproj path, so two projects in the same dir don't
        // share (and clobber) one shadow.
        let shadow_ws = shadow_workspace_for(Path::new(&csproj_for_shadow));
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

    let proj_dir_path = Path::new(&user_project_dir);
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

            // Collect the HIERARCHICAL `_ViewImports`/`_ViewStart` chain for THIS
            // view (project root → the view's own folder), so subfolder/Area views
            // get the nearest imports/layout — matching what `dotnet build` globs
            // (the live `.g.cs` would otherwise diverge from build/on-save).
            let imports = collect_hierarchical_imports(proj_dir_path, &proj.cshtml_rel);

            // Per-cshtml file list = the import chain (each with its text) + this
            // file (its own TargetPath; its text travels in cshtmlText at emit).
            let mut files = imports.specs.clone();
            files.push(FileSpec {
                path: abs.to_string_lossy().to_string(),
                target_path_b64: target_path_b64(&rel_str),
                text: None,
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
                // Singular fields carry the NEAREST import/viewstart for sidecars on
                // the old protocol; the full chain rides in `files`.
                view_imports_path: imports.nearest_imports.as_ref().map(|(p, _)| p.clone()),
                view_imports_text: imports.nearest_imports.as_ref().map(|(_, t)| t.clone()),
                view_start_path: imports.nearest_start.as_ref().map(|(p, _)| p.clone()),
                view_start_text: imports.nearest_start.as_ref().map(|(_, t)| t.clone()),
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

/// The `_ViewImports`/`_ViewStart` chain that applies to one view, collected from
/// the project root down to the view's own folder.
struct HierarchicalImports {
    /// Every applicable import/viewstart as an AdditionalText FileSpec (with text).
    specs: Vec<FileSpec>,
    /// The closest `_ViewImports.cshtml` (path, text), for the singular protocol field.
    nearest_imports: Option<(String, String)>,
    /// The closest `_ViewStart.cshtml` (path, text), for the singular protocol field.
    nearest_start: Option<(String, String)>,
}

/// Collect the hierarchical `_ViewImports.cshtml`/`_ViewStart.cshtml` that apply to
/// `cshtml_rel`, walking each directory from `project_dir` down to (and including)
/// the view's parent folder. This mirrors ASP.NET's hierarchy: imports/layouts in
/// ancestor folders compose with the nearest ones — so a view in `Areas/Admin/...`
/// or a deep `Views/...` subfolder gets the right usings/inherits/inject/layout.
///
/// The `dotnet build` path already globs these via the SDK; this brings the live
/// sidecar `emit` to parity. The view file itself is never returned here.
fn collect_hierarchical_imports(project_dir: &Path, cshtml_rel: &Path) -> HierarchicalImports {
    let mut specs: Vec<FileSpec> = Vec::new();
    let mut nearest_imports: Option<(String, String)> = None;
    let mut nearest_start: Option<(String, String)> = None;

    // The directories to scan, project root first → the view's own folder last, so
    // the LAST hit for each kind is the nearest (overrides `nearest_*`).
    let mut dirs: Vec<PathBuf> = vec![PathBuf::new()]; // project root (empty rel)
    if let Some(parent) = cshtml_rel.parent() {
        let mut acc = PathBuf::new();
        for comp in parent.components() {
            acc.push(comp);
            dirs.push(acc.clone());
        }
    }

    for dir_rel in &dirs {
        for (file, is_imports) in [("_ViewImports.cshtml", true), ("_ViewStart.cshtml", false)] {
            let rel = if dir_rel.as_os_str().is_empty() {
                PathBuf::from(file)
            } else {
                dir_rel.join(file)
            };
            let abs = project_dir.join(&rel);
            if !abs.exists() {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&abs) else {
                continue;
            };
            let abs_str = abs.to_string_lossy().to_string();
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            specs.push(FileSpec {
                path: abs_str.clone(),
                target_path_b64: target_path_b64(&rel_str),
                text: Some(text.clone()),
            });
            if is_imports {
                nearest_imports = Some((abs_str, text));
            } else {
                nearest_start = Some((abs_str, text));
            }
        }
    }

    HierarchicalImports { specs, nearest_imports, nearest_start }
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

    // Sidecar call (fast ~ms, but synchronous pipe I/O with a timeout). Dispatch
    // to `spawn_blocking` so a burst of keystrokes never ties up the async
    // runtime's worker threads (same pattern as `razor_prepare`/`razor_ensure_sidecar`).
    let cshtml_abs = ctx.cshtml_abs.clone();
    let sidecar = state.clone_sidecar_ref();
    let emitted = tauri::async_runtime::spawn_blocking(move || {
        sidecar.emit(&ctx.inputs, &ctx.cshtml_abs, &text)
    })
    .await
    .map_err(|e| format!("razor emit join error: {e}"))?;
    let generated = match emitted {
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
        eprintln!("[razor:live] emit produced EMPTY .g.cs for {cshtml_abs}");
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
        // primes the driver/TagHelper scan regardless of exact content). Dispatch
        // the synchronous sidecar I/O to `spawn_blocking` so it never ties up an
        // async worker thread (same pattern as `razor_prepare`).
        let sidecar = state.clone_sidecar_ref();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let seed = std::fs::read_to_string(&ctx.cshtml_abs).unwrap_or_default();
            sidecar.warm(&ctx.inputs, &ctx.cshtml_abs, &seed)
        })
        .await;
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_project() -> PathBuf {
        let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("fluent-razor-imports-{id}"));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn collect_hierarchical_imports_walks_root_to_view_folder() {
        let proj = temp_project();
        // Project root imports, plus Views/ and Views/Home/ overrides + an Area.
        std::fs::write(proj.join("_ViewImports.cshtml"), "@using App").unwrap();
        std::fs::create_dir_all(proj.join("Views/Home")).unwrap();
        std::fs::write(proj.join("Views/_ViewImports.cshtml"), "@using App.Views").unwrap();
        std::fs::write(proj.join("Views/_ViewStart.cshtml"), "@{ Layout = \"_Layout\"; }").unwrap();
        std::fs::write(proj.join("Views/Home/_ViewImports.cshtml"), "@using App.Home").unwrap();

        let imports =
            collect_hierarchical_imports(&proj, Path::new("Views/Home/Index.cshtml"));

        // All FOUR applicable import/viewstart files are collected (not just root/Views).
        let rels: Vec<String> = imports
            .specs
            .iter()
            .map(|s| s.path.replace('\\', "/"))
            .map(|p| p.rsplit("fluent-razor-imports-").next().unwrap().to_string())
            .collect();
        assert_eq!(imports.specs.len(), 4, "got: {rels:?}");
        // The nearest _ViewImports is the deepest one (Views/Home).
        let (np, _) = imports.nearest_imports.as_ref().expect("nearest imports");
        assert!(np.replace('\\', "/").ends_with("Views/Home/_ViewImports.cshtml"), "got {np}");
        // The nearest _ViewStart is Views/ (none deeper exists).
        let (sp, _) = imports.nearest_start.as_ref().expect("nearest start");
        assert!(sp.replace('\\', "/").ends_with("Views/_ViewStart.cshtml"), "got {sp}");
        // The view file itself is never included.
        assert!(imports.specs.iter().all(|s| !s.path.ends_with("Index.cshtml")));
        // Every spec carries its text + TargetPath.
        assert!(imports.specs.iter().all(|s| s.text.is_some() && !s.target_path_b64.is_empty()));

        let _ = std::fs::remove_dir_all(&proj);
    }

    #[test]
    fn collect_hierarchical_imports_empty_when_none_exist() {
        let proj = temp_project();
        std::fs::create_dir_all(proj.join("Views/Home")).unwrap();
        let imports =
            collect_hierarchical_imports(&proj, Path::new("Views/Home/Index.cshtml"));
        assert!(imports.specs.is_empty());
        assert!(imports.nearest_imports.is_none());
        assert!(imports.nearest_start.is_none());
        let _ = std::fs::remove_dir_all(&proj);
    }

    #[test]
    fn canonical_key_normalizes_separators() {
        // Backslashes always fold to forward slashes (both platforms). Case is
        // folded only on Windows (see canonical_key), so compare accordingly.
        let key = canonical_key(Path::new("Views\\Index.cshtml"));
        assert!(!key.contains('\\'), "separators not normalized: {key}");
        let expected = if cfg!(windows) {
            "views/index.cshtml"
        } else {
            "Views/Index.cshtml"
        };
        assert_eq!(key, expected);
    }

    #[cfg(windows)]
    #[test]
    fn canonical_key_is_case_insensitive_on_windows() {
        assert_eq!(
            canonical_key(Path::new("C:\\WS\\Views\\Index.cshtml")),
            canonical_key(Path::new("c:/ws/views/index.cshtml"))
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn canonical_key_is_case_sensitive_off_windows() {
        // On case-sensitive filesystems, distinct-case paths must NOT collide.
        assert_ne!(
            canonical_key(Path::new("/ws/Views/Admin.cshtml")),
            canonical_key(Path::new("/ws/Views/admin.cshtml"))
        );
    }

    #[test]
    fn shadow_workspace_is_outside_project_and_stable() {
        let (proj_dir, csproj) = if cfg!(windows) {
            (Path::new("C:\\src\\SampleMvc"), Path::new("C:\\src\\SampleMvc\\SampleMvc.csproj"))
        } else {
            (Path::new("/src/SampleMvc"), Path::new("/src/SampleMvc/SampleMvc.csproj"))
        };
        let ws = shadow_workspace_for(csproj);
        // Never inside the user's source tree (else the SDK globs the projection).
        assert!(
            !ws.starts_with(proj_dir),
            "shadow workspace must not be under the project: {ws:?}"
        );
        assert!(ws.starts_with(std::env::temp_dir()));
        // Stable per .csproj (same path → same shadow).
        assert_eq!(ws, shadow_workspace_for(csproj));
        // Distinct projects → distinct shadows.
        let other = if cfg!(windows) {
            Path::new("C:\\src\\Other\\Other.csproj")
        } else {
            Path::new("/src/Other/Other.csproj")
        };
        assert_ne!(ws, shadow_workspace_for(other));
    }

    #[test]
    fn shadow_workspace_isolates_two_csproj_in_same_dir() {
        // Two distinct projects sharing a directory must NOT share a shadow.
        let (a, b) = if cfg!(windows) {
            (Path::new("C:\\src\\Mono\\A.csproj"), Path::new("C:\\src\\Mono\\B.csproj"))
        } else {
            (Path::new("/src/Mono/A.csproj"), Path::new("/src/Mono/B.csproj"))
        };
        assert_ne!(shadow_workspace_for(a), shadow_workspace_for(b));
    }

    #[cfg(windows)]
    #[test]
    fn shadow_workspace_is_case_insensitive_on_windows() {
        // On Windows the .csproj path is case-insensitive → same shadow dir.
        assert_eq!(
            shadow_workspace_for(Path::new("C:\\src\\SampleMvc\\SampleMvc.csproj")),
            shadow_workspace_for(Path::new("c:/src/samplemvc/samplemvc.csproj"))
        );
    }
}
