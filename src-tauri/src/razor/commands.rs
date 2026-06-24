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
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use super::remap::{self, LspPos};
use super::runtime;
use super::sourcemap::RazorSourceMap;

/// App-managed broker state: one source map per open `.cshtml` (canonical key).
#[derive(Default)]
pub struct RazorState {
    maps: Mutex<HashMap<String, RazorSourceMap>>,
}

impl RazorState {
    pub fn new() -> Self {
        Self::default()
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

    let mut available = Vec::new();
    {
        let mut maps = state.maps.lock().map_err(|_| "razor state poisoned".to_string())?;
        for proj in prepared.projections {
            let abs = Path::new(&user_project_dir).join(&proj.cshtml_rel);
            maps.insert(canonical_key(&abs), proj.source_map);
            available.push(RazorProjectionInfo {
                cshtml_rel: proj.cshtml_rel.to_string_lossy().to_string(),
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

/// Drop a document's cached source map (on `.cshtml` close).
#[tauri::command]
pub fn razor_forget(state: State<'_, RazorState>, cshtml_path: String) {
    if let Ok(mut maps) = state.maps.lock() {
        maps.remove(&canonical_key(Path::new(&cshtml_path)));
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
