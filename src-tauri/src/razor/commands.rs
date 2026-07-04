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

use super::exec;
use super::remap::{self, LspPos};
use super::runtime;
use super::sidecar::{built_fingerprint, FileSpec, ProjectInputs, Sidecar};
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
    /// Derived reference DLLs that do NOT exist on disk (ProjectReferences the
    /// user never built). Semantics degrade for types from these assemblies —
    /// the frontend surfaces this honestly instead of letting Roslyn report
    /// false "type does not exist" errors with no explanation.
    pub missing_references: Vec<String>,
}

#[derive(Serialize)]
pub struct RemapPos {
    pub line: u32,
    pub character: u32,
}

/// One 0-based LSP range on the wire (batch remap input/output).
#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemapRange {
    pub start_line: u32,
    pub start_character: u32,
    pub end_line: u32,
    pub end_character: u32,
}

/// One fully-prepared view, produced off the UI thread and installed into
/// [`RazorState`] afterwards (locks are held only for the in-memory inserts —
/// never across filesystem/process I/O).
struct PreparedView {
    rel_str: String,
    abs: PathBuf,
    map: RazorSourceMap,
    generated_path: String,
    context: ProjectionContext,
}

struct PrepareOutcome {
    shadow_dir: String,
    solution_path: String,
    views: Vec<PreparedView>,
    missing: Vec<String>,
    missing_references: Vec<String>,
}

/// Prepare projection serving for `cshtml_rels` (relative to `user_project_dir`)
/// and cache their source maps. Runs everything blocking off the UI thread.
///
/// SIDECAR-FIRST: each projection is emitted in-memory by the live sidecar (the
/// same engine the keystroke path uses) — `dotnet build` of the user project is
/// only a LAST-RESORT fallback when the sidecar is unavailable. Opening or saving
/// a `.cshtml` therefore never builds the user's dependency graph.
#[tauri::command]
pub async fn razor_prepare(
    app: tauri::AppHandle,
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
    use tauri::Manager;
    let _ = workspace_dir;
    let sidecar = state.clone_sidecar_ref();
    let sidecar_src = resolve_sidecar_source_root(&app);
    let app_data = app.path().app_data_dir().ok();

    let project_dir = user_project_dir.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        prepare_blocking(
            sidecar,
            sidecar_src,
            app_data,
            &project_dir,
            &user_csproj_path,
            &config,
            &cshtml_rels,
        )
    })
    .await
    .map_err(|e| format!("razor prepare join error: {e}"))?
    .map_err(|e| e.to_string())?;

    let mut available = Vec::new();
    {
        let mut maps = state.maps.lock().map_err(|_| "razor state poisoned".to_string())?;
        let mut pending = state.pending.lock().map_err(|_| "razor state poisoned".to_string())?;
        let mut contexts = state.contexts.lock().map_err(|_| "razor state poisoned".to_string())?;
        for view in outcome.views {
            let key = canonical_key(&view.abs);
            // A fresh prepare (open/save) is authoritative: drop any in-flight
            // pending live map so a late live commit can't clobber it.
            pending.remove(&key);
            contexts.insert(key.clone(), view.context);
            maps.insert(key, view.map);
            available.push(RazorProjectionInfo {
                cshtml_rel: view.rel_str,
                cshtml_path: view.abs.to_string_lossy().to_string(),
                generated_path: view.generated_path,
            });
        }
    }

    Ok(RazorPrepareResult {
        shadow_dir: outcome.shadow_dir,
        solution_path: outcome.solution_path,
        available,
        missing: outcome.missing,
        missing_references: outcome.missing_references,
    })
}

/// The blocking body of [`razor_prepare`]: shell (derive/plan/materialize/restore)
/// → per-view sidecar emit (skipping views whose on-disk projection is current)
/// → one dotnet-build fallback for whatever the sidecar couldn't produce.
fn prepare_blocking(
    sidecar: Arc<Sidecar>,
    sidecar_src: Option<PathBuf>,
    app_data: Option<PathBuf>,
    user_project_dir: &str,
    user_csproj_path: &str,
    config: &str,
    cshtml_rels: &[String],
) -> std::io::Result<PrepareOutcome> {
    let rels: Vec<PathBuf> = cshtml_rels.iter().map(PathBuf::from).collect();
    let proj_dir_path = Path::new(user_project_dir);
    let csproj_path = Path::new(user_csproj_path);
    // Key the shadow by the .csproj path, so two projects in the same dir don't
    // share (and clobber) one shadow.
    let shadow_ws = shadow_workspace_for(csproj_path);

    let shell = runtime::prepare_shell(
        &shadow_ws,
        proj_dir_path,
        csproj_path,
        config,
        &rels,
        runtime::DEFAULT_DOTNET_TIMEOUT,
    )?;
    let d = &shell.derived;

    // Missing reference DLLs (unbuilt ProjectReferences): semantics will degrade
    // for their types. Surfaced to the frontend; never silently dropped.
    let missing_references: Vec<String> = d
        .reference_paths
        .iter()
        .filter(|p| !Path::new(p.as_str()).exists())
        .cloned()
        .collect();
    if !missing_references.is_empty() {
        eprintln!(
            "[razor:refs] {} referenced DLL(s) missing on disk (project not built?) — first: {}",
            missing_references.len(),
            missing_references[0]
        );
    }

    // Sidecar availability is best-effort: a build failure keeps us on the
    // dotnet-build fallback (logged, not fatal). Cheap when the fingerprint
    // matches (no dotnet spawn).
    let sidecar_ready = match (&sidecar_src, &app_data) {
        (Some(root), Some(cache)) => match sidecar.ensure_built(root, cache) {
            Ok(_) => true,
            Err(e) => {
                eprintln!("[razor:sidecar] unavailable, falling back to build: {e}");
                false
            }
        },
        _ => false,
    };

    // The freshness skip below (`projection_current`) compares the projection
    // against its INPUTS (cshtml/csproj/imports mtimes) — it can't see that the
    // EMITTER changed. A sidecar upgrade changes the CODEGEN SHAPE (ex.: o
    // compilador Razor do SDK 10 mapeia o tipo do `@model` com `#line`; o da
    // banda 8.0 não), so a projection pinned by the OLD emitter would keep
    // ctrl+click/hover no tipo do @model quebrados PARA SEMPRE — the stale
    // `.g.cs` is always "fresher" than its unchanged `.cshtml`. Record the
    // emitter fingerprint in the shadow; on mismatch, bypass the freshness skip
    // once and re-emit every requested view.
    let emitter_marker = shadow_ws.join(".fluent-emitter-fp");
    let emitter_fp = if sidecar_ready {
        app_data.as_ref().and_then(|c| built_fingerprint(c))
    } else {
        None
    };
    let emitter_stale = match &emitter_fp {
        Some(fp) => std::fs::read_to_string(&emitter_marker)
            .map(|recorded| &recorded != fp)
            .unwrap_or(true),
        None => false,
    };
    if emitter_stale {
        eprintln!("[razor:sidecar] emitter changed — re-emitting pinned projections");
    }

    let mut views: Vec<PreparedView> = Vec::new();
    let mut fallback: Vec<usize> = Vec::new(); // indices into plan.projections
    let mut contexts_by_idx: Vec<ProjectionContext> = Vec::new();

    for (idx, pf) in shell.plan.projections.iter().enumerate() {
        let abs = proj_dir_path.join(&pf.cshtml_rel);
        let rel_str = pf.cshtml_rel.to_string_lossy().to_string();

        // Collect the HIERARCHICAL `_ViewImports`/`_ViewStart` chain for THIS
        // view (project root → the view's own folder), so subfolder/Area views
        // get the nearest imports/layout.
        let imports = collect_hierarchical_imports(proj_dir_path, &pf.cshtml_rel);
        let mut files = imports.specs.clone();
        files.push(FileSpec {
            path: abs.to_string_lossy().to_string(),
            target_path_b64: target_path_b64(&rel_str),
            text: None,
        });
        let inputs = ProjectInputs {
            project_dir: user_project_dir.to_string(),
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
        let context = ProjectionContext {
            inputs,
            cshtml_abs: abs.to_string_lossy().to_string(),
        };
        contexts_by_idx.push(context.clone());

        // Re-open with no edit: the on-disk projection is still current — parse
        // it instead of re-emitting (instant). Bypassed when the EMITTER changed
        // (see `emitter_stale` above): same inputs, different codegen.
        if !emitter_stale && runtime::projection_current(proj_dir_path, csproj_path, pf) {
            if let Ok(generated) = std::fs::read_to_string(&pf.shadow_gcs) {
                views.push(PreparedView {
                    rel_str,
                    map: RazorSourceMap::parse(&generated, &abs.to_string_lossy()),
                    generated_path: pf.shadow_gcs.to_string_lossy().to_string(),
                    context,
                    abs,
                });
                continue;
            }
        }

        // PRIMARY: sidecar in-memory emit (same engine as the keystroke path;
        // COLD budget — the first emit of a project loads its references).
        if sidecar_ready {
            let text = std::fs::read_to_string(&abs).unwrap_or_default();
            if !text.is_empty() {
                match sidecar.emit_cold(&context.inputs, &context.cshtml_abs, &text) {
                    Ok(generated) if !generated.is_empty() => {
                        if let Some(parent) = pf.shadow_gcs.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        // Content-aware write: Roslyn watches the shadow dir.
                        let _ = exec::write_if_changed(&pf.shadow_gcs, &generated);
                        views.push(PreparedView {
                            rel_str,
                            map: RazorSourceMap::parse(&generated, &abs.to_string_lossy()),
                            generated_path: pf.shadow_gcs.to_string_lossy().to_string(),
                            context,
                            abs,
                        });
                        continue;
                    }
                    Ok(_) => eprintln!("[razor:sidecar] cold emit EMPTY for {rel_str}"),
                    Err(e) => eprintln!("[razor:sidecar] cold emit failed for {rel_str}: {e}"),
                }
            }
        }
        fallback.push(idx);
    }

    // LAST RESORT: one scoped `dotnet build` for the views the sidecar couldn't
    // produce (sidecar unbuilt/crashed, unreadable source, generator failure).
    let mut missing: Vec<String> = Vec::new();
    if !fallback.is_empty() {
        eprintln!(
            "[razor:timing] emit-fallback for {} view(s) (sidecar path unavailable)",
            fallback.len()
        );
        if let Err(e) =
            runtime::emit_fallback(&shell.plan, proj_dir_path, runtime::DEFAULT_DOTNET_TIMEOUT)
        {
            eprintln!("[razor:error] emit-fallback failed: {e}");
        }
        for idx in fallback {
            let pf = &shell.plan.projections[idx];
            let abs = proj_dir_path.join(&pf.cshtml_rel);
            let rel_str = pf.cshtml_rel.to_string_lossy().to_string();
            match std::fs::read_to_string(&pf.shadow_gcs) {
                Ok(generated) => views.push(PreparedView {
                    rel_str,
                    map: RazorSourceMap::parse(&generated, &abs.to_string_lossy()),
                    generated_path: pf.shadow_gcs.to_string_lossy().to_string(),
                    context: contexts_by_idx[idx].clone(),
                    abs,
                }),
                Err(_) => missing.push(rel_str), // no projection at all (degraded)
            }
        }
    }

    // Record which emitter produced this sweep, so the next prepare with the
    // SAME sidecar build can trust the freshness skip again.
    if let Some(fp) = &emitter_fp {
        let _ = std::fs::write(&emitter_marker, fp);
    }

    Ok(PrepareOutcome {
        shadow_dir: shell.plan.shadow_dir.to_string_lossy().to_string(),
        solution_path: shell.plan.solution_path.to_string_lossy().to_string(),
        views,
        missing,
        missing_references,
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
    let emit_started = std::time::Instant::now();
    let emitted = tauri::async_runtime::spawn_blocking(move || {
        sidecar.emit(&ctx.inputs, &ctx.cshtml_abs, &text)
    })
    .await
    .map_err(|e| format!("razor emit join error: {e}"))?;
    let emit_ms = emit_started.elapsed();
    // The live sidecar is the per-keystroke path; it must stay in the low-ms range
    // or typing feels laggy. Trace every emit (and flag slow ones) so a degraded
    // sidecar is visible in razor-diag.log instead of just "the editor feels slow".
    if emit_ms.as_millis() >= 250 {
        crate::rdiag!("[razor:live] SLOW emit {:?} for {}", emit_ms, cshtml_abs);
    } else {
        crate::rdiag!("[razor:live] emit {:?}", emit_ms);
    }
    let generated = match emitted {
        Ok(g) => g,
        Err(e) => {
            crate::rdiag!("[razor:live] emit FAILED for {cshtml_abs}: {e}");
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
        crate::rdiag!("[razor:live] emit produced EMPTY .g.cs for {cshtml_abs}");
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
    let key = canonical_key(Path::new(&cshtml_path));
    let Some(map) = maps.get(&key) else {
        // No cached map for this `.cshtml` → every remap fails (mapped=0). Sample
        // the failure so a key mismatch / missing map is visible in razor-diag.log.
        crate::razor::diag::sample_remap_miss(&format!(
            "[razor:remap] NO MAP for key={key} (cached keys: {})",
            maps.keys().take(4).cloned().collect::<Vec<_>>().join(" | ")
        ));
        return None;
    };
    let mapped = remap::generated_pos_to_source(map, LspPos::new(line, character));
    if mapped.is_none() {
        // Map present but this generated position fell outside every region.
        // Sample it (with the map's region count) to tell "map empty" from
        // "position genuinely synthetic".
        crate::razor::diag::sample_remap_miss(&format!(
            "[razor:remap] gen ({line},{character}) UNMAPPED — regions={}",
            map.region_count()
        ));
    }
    mapped.map(|p| RemapPos { line: p.line, character: p.character })
}


/// Append a line from the frontend LSP/projection chain to the shared
/// `razor-diag.log`. Lets the `.cshtml` projection client (TS side) land its
/// trace in the SAME ordered file as the backend pipeline steps, so a failing
/// C#/Razor run reads as one timeline (didOpen → pull → remap alongside
/// derive/emit/restore). Best-effort; never errors back to the UI.
#[tauri::command]
pub fn razor_diag_log(line: String) {
    crate::razor::diag::log(&line);
}

/// Remap N generated-C# ranges back to the `.cshtml` in ONE IPC round-trip —
/// the diagnostics publish path was doing 2 position IPCs per diagnostic per
/// pull (hundreds of calls per save in a file with many errors). Entry `i` of
/// the result corresponds to entry `i` of `ranges`; `None` = unmappable
/// (synthetic C#). Uses the CLAMPED range mapper: for diagnostics, a squiggle
/// truncated at its region's end beats a silently dropped one.
#[tauri::command]
pub fn razor_remap_ranges_to_source(
    state: State<'_, RazorState>,
    cshtml_path: String,
    ranges: Vec<RemapRange>,
) -> Vec<Option<RemapRange>> {
    let Ok(maps) = state.maps.lock() else {
        return ranges.iter().map(|_| None).collect();
    };
    let Some(map) = maps.get(&canonical_key(Path::new(&cshtml_path))) else {
        return ranges.iter().map(|_| None).collect();
    };
    ranges
        .iter()
        .map(|r| {
            remap::generated_range_to_source_clamped(
                map,
                remap::LspRange {
                    start: LspPos::new(r.start_line, r.start_character),
                    end: LspPos::new(r.end_line, r.end_character),
                },
            )
            .map(|out| RemapRange {
                start_line: out.start.line,
                start_character: out.start.character,
                end_line: out.end.line,
                end_character: out.end.character,
            })
        })
        .collect()
}

/// [`razor_remap_ranges_to_source`] with the STRICT mapper — for `TextEdit`s
/// (code actions / quick fixes), where a truncated range would APPLY an edit at
/// the wrong span and corrupt the document. Any range not fully inside ONE
/// mapped region comes back `None`; the caller must then DROP the whole action
/// (contract: results born in synthetic text never become a `TextEdit`).
#[tauri::command]
pub fn razor_remap_ranges_to_source_strict(
    state: State<'_, RazorState>,
    cshtml_path: String,
    ranges: Vec<RemapRange>,
) -> Vec<Option<RemapRange>> {
    let Ok(maps) = state.maps.lock() else {
        return ranges.iter().map(|_| None).collect();
    };
    let Some(map) = maps.get(&canonical_key(Path::new(&cshtml_path))) else {
        return ranges.iter().map(|_| None).collect();
    };
    ranges
        .iter()
        .map(|r| {
            remap::generated_range_to_source(
                map,
                remap::LspRange {
                    start: LspPos::new(r.start_line, r.start_character),
                    end: LspPos::new(r.end_line, r.end_character),
                },
            )
            .map(|out| RemapRange {
                start_line: out.start.line,
                start_character: out.start.character,
                end_line: out.end.line,
                end_character: out.end.character,
            })
        })
        .collect()
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

    /// End-to-end of the SIDECAR-FIRST prepare against the real SampleMvc fixture:
    /// builds the sidecar, derives design-time, emits the projection in-memory,
    /// writes the shadow `.g.cs`, parses the `#line` map — then asserts the
    /// CS1061 range (`Model.NonExistentProperty`, .cshtml line 16) remaps
    /// correctly through the BATCH (clamped) mapper the frontend now uses.
    /// Shells out to `dotnet` (slow) → `#[ignore]`. Run with:
    /// `cargo test --lib razor::commands::tests::e2e_sidecar_first -- --ignored --nocapture`
    #[test]
    #[ignore = "integration: runs dotnet + the sidecar (slow)"]
    fn e2e_sidecar_first_prepare_sample_mvc() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let fixture = repo_root.join("tools/razor-lsp-probe/fixtures/SampleMvc");
        assert!(fixture.join("SampleMvc.csproj").exists(), "fixture missing");
        let cache = std::env::temp_dir().join("fluent-razor-sidecar-first-test");
        let _ = std::fs::create_dir_all(&cache);

        let sidecar = Arc::new(Sidecar::new());
        let outcome = prepare_blocking(
            Arc::clone(&sidecar),
            Some(repo_root),
            Some(cache),
            &fixture.to_string_lossy(),
            &fixture.join("SampleMvc.csproj").to_string_lossy(),
            "Debug",
            &["Views/Home/Index.cshtml".to_string()],
        )
        .expect("prepare_blocking");
        sidecar.shutdown();

        assert!(outcome.missing.is_empty(), "missing: {:?}", outcome.missing);
        assert!(outcome.missing_references.is_empty(), "refs: {:?}", outcome.missing_references);
        assert_eq!(outcome.views.len(), 1, "one prepared view");
        let view = &outcome.views[0];

        // The projection landed on disk (what the frontend didOpens into Roslyn).
        let gcs = std::fs::read_to_string(&view.generated_path).expect("shadow .g.cs on disk");
        assert!(
            gcs.contains("Model.NonExistentProperty"),
            "projection must contain the probe expression"
        );
        assert!(view.map.region_count() > 0, "no #line regions parsed");

        // The `@model` TYPE must be source-mapped (`#line (1,8)-(1,37)` around
        // `SampleMvc.Models.WeatherModel` — Index.cshtml line 1, after `@model `).
        // Only the NEW Razor compiler emits this mapping; the old 8.0-band one the
        // sidecar used to pin does NOT — which silently killed ctrl+click/hover on
        // the model type for any view emitted live. Guards the sidecar's compiler
        // resolution (newest SDK) from regressing.
        assert!(
            gcs.contains("#line (1,8)"),
            "the @model type must be #line-mapped by the sidecar emit (old Razor \
             compiler resolved? see ResolveRazorCompilerDll in the sidecar)"
        );

        // Locate the probe line in the GENERATED text (0-based LSP), then remap
        // its range through the same batch mapper the diagnostics path uses.
        let gen_line = gcs
            .lines()
            .position(|l| l.trim_start().starts_with("Model.NonExistentProperty"))
            .expect("probe line in .g.cs") as u32;
        let len = "Model.NonExistentProperty".len() as u32;
        let mapped = remap::generated_range_to_source_clamped(
            &view.map,
            remap::LspRange {
                start: LspPos::new(gen_line, 0),
                end: LspPos::new(gen_line, len),
            },
        )
        .expect("CS1061 range must remap to the .cshtml");
        // Index.cshtml line 16 (1-based) → LSP line 15; `@Model.` starts at col 8
        // (0-based; the `#line (16,9)` directive is 1-based col 9).
        assert_eq!(mapped.start.line, 15, "mapped to .cshtml line 16 (1-based)");
        assert_eq!(mapped.start.character, 8, "mapped to the expression start");
        eprintln!(
            "[test] sidecar-first OK: gen line {} → cshtml ({},{})-({},{})",
            gen_line, mapped.start.line, mapped.start.character, mapped.end.line, mapped.end.character
        );
    }

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

