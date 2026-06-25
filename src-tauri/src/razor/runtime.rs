//! Runtime orchestrator (ADR 0002) — the single entry the app's LSP layer calls
//! to prepare projection serving for a user project.
//!
//! `prepare()` runs the V1 pipeline (derive TFM/refs → plan → emit `.g.cs` via
//! `dotnet build` → materialize the shadow) and returns the materialized
//! [`BrokerPlan`] plus, per `.cshtml`, a [`RazorSourceMap`] parsed from the
//! materialized projection. The LSP layer then `solution/open`s
//! `plan.solution_path` (its existing Roslyn client infra) and the Monaco
//! providers remap positions/results with these maps (via [`super::remap`]).
//!
//! Process execution (dotnet) lives here; it is exercised by the `#[ignore]`
//! end-to-end test below against the real SampleMvc fixture.

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use super::broker::{self, BrokerInputs, BrokerPlan};
use super::derive::{self, DerivedRefs};
use super::exec;
use super::sourcemap::RazorSourceMap;

/// Per-project cache of derived TFM/framework refs, keyed by the `.csproj` path
/// and invalidated by a fingerprint (see [`derive_inputs_fingerprint`]). The
/// derive is a `dotnet` MSBuild eval (~0.6s); re-preparing on save (same session)
/// reuses it instead of re-spawning `dotnet`.
static DERIVE_CACHE: OnceLock<Mutex<HashMap<String, (SystemTime, DerivedRefs)>>> = OnceLock::new();

/// Newest modified time among the files that can change the derived TFM/refs: the
/// `.csproj` plus the MSBuild import files MSBuild discovers by walking up
/// (`Directory.Build.props`/`.targets`, `Directory.Packages.props`, `global.json`).
/// `None` if the `.csproj` mtime is unreadable (caller then re-derives, uncached).
fn derive_inputs_fingerprint(csproj: &Path, project_dir: &Path) -> Option<SystemTime> {
    let mut newest = std::fs::metadata(csproj).and_then(|m| m.modified()).ok()?;
    const IMPORTS: [&str; 4] = [
        "Directory.Build.props",
        "Directory.Build.targets",
        "Directory.Packages.props",
        "global.json",
    ];
    let mut dir = Some(project_dir);
    while let Some(d) = dir {
        for name in IMPORTS {
            if let Ok(m) = std::fs::metadata(d.join(name)).and_then(|m| m.modified()) {
                if m > newest {
                    newest = m;
                }
            }
        }
        dir = d.parent();
    }
    Some(newest)
}

/// Derive (or reuse the cached) refs for `csproj`. Re-derives when any derive
/// input changed since the cache entry, or when there is no usable fingerprint.
fn derive_cached(csproj: &Path, project_dir: &Path, timeout: Duration) -> io::Result<DerivedRefs> {
    let key = csproj.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    let mtime = derive_inputs_fingerprint(csproj, project_dir);
    let cache = DERIVE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(mt) = mtime {
        if let Ok(guard) = cache.lock() {
            if let Some((cached_mt, refs)) = guard.get(&key) {
                if *cached_mt == mt {
                    return Ok(refs.clone());
                }
            }
        }
    }
    let (dprog, dargs) = derive::derive_command(&csproj.to_string_lossy());
    let out = run_capturing(&dprog, &dargs, project_dir, timeout)?;
    let mut derived = derive::parse_derived(&String::from_utf8_lossy(&out)).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "could not derive a TargetFramework (no TargetFramework or TargetFrameworks)",
        )
    })?;
    // Multi-targeting: the first eval had no active TFM, so `ReferencePath` came
    // back empty. Re-derive pinned to the selected TFM (`-f`) to resolve that
    // framework's real references — without this the live sidecar's compilation
    // would be missing assemblies for multi-target projects.
    if derived.multi_target_selected {
        let (p, a) = derive::derive_command_for_tfm(&csproj.to_string_lossy(), Some(&derived.tfm));
        if let Ok(out2) = run_capturing(&p, &a, project_dir, timeout) {
            if let Some(d2) = derive::parse_derived(&String::from_utf8_lossy(&out2)) {
                derived = d2;
            }
        }
    }
    if let Some(mt) = mtime {
        if let Ok(mut guard) = cache.lock() {
            guard.insert(key, (mt, derived.clone()));
        }
    }
    Ok(derived)
}

/// Default timeout for a `dotnet` invocation (derive/emit). Builds can be slow on
/// first run; tune via [`prepare_with_timeout`].
pub const DEFAULT_DOTNET_TIMEOUT: Duration = Duration::from_secs(180);

/// True if `a` is at least as new as `b` (by modified time). Conservative: any
/// missing/unreadable mtime returns false, so callers re-do the work rather than
/// trust a stale artifact.
fn is_newer_or_equal(a: &Path, b: &Path) -> bool {
    match (
        std::fs::metadata(a).and_then(|m| m.modified()),
        std::fs::metadata(b).and_then(|m| m.modified()),
    ) {
        (Ok(ta), Ok(tb)) => ta >= tb,
        _ => false,
    }
}

/// Run a command capturing stdout, killing it (and erroring) if it exceeds
/// `timeout`. Prevents a hung `dotnet` from blocking the caller forever.
fn run_capturing(program: &str, args: &[String], cwd: &Path, timeout: Duration) -> io::Result<Vec<u8>> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // On Windows, don't flash a console window for the spawned `dotnet`.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
    // Drain stdout on a thread so a full pipe buffer can't deadlock the child. The
    // thread sends the captured bytes over a channel when stdout reaches EOF —
    // letting us wait for it with a DEADLINE rather than an unbounded `join()`.
    let mut stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf); // ignore: receiver may be gone (we timed out)
    });
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait(); // reap the killed child
            // The reader thread is detached (we hold only `rx`): a `dotnet`
            // descendant (e.g. VBCSCompiler) may still hold the pipe, so we never
            // block on it — dropping `rx` lets it finish on its own.
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("`{program}` timed out after {}s", timeout.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // The child exited cleanly, but stdout EOF can still lag if a descendant kept
    // the write end open. Wait for the reader only until the deadline — never
    // unboundedly (the bug: a held pipe would make `join()` hang past the timeout).
    // On timeout, return what the child produced as far as we know (usually empty),
    // detaching the reader rather than blocking `prepare()` forever.
    let remaining = deadline.saturating_duration_since(Instant::now());
    match rx.recv_timeout(remaining.max(Duration::from_millis(1))) {
        Ok(buf) => Ok(buf),
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("`{program}` exited but its stdout stayed open past the timeout"),
        )),
    }
}

/// A materialized projection ready to serve.
pub struct PreparedProjection {
    pub cshtml_rel: PathBuf,
    /// The projected C# inside the shadow (opened in Roslyn).
    pub shadow_gcs: PathBuf,
    /// Bidirectional `#line` map between this projection and the `.cshtml`.
    pub source_map: RazorSourceMap,
}

/// Result of [`prepare`]: the materialized shadow plan + per-file source maps.
pub struct PreparedShadow {
    pub plan: BrokerPlan,
    pub projections: Vec<PreparedProjection>,
    /// `.cshtml` (relative) that requested serving but got NO projection (emit
    /// failed/produced nothing). Lets the caller show "Razor projection
    /// unavailable" — distinct from "no .cshtml requested".
    pub missing: Vec<PathBuf>,
    /// The derived TFM/refs/globals — the live sidecar's project inputs.
    pub derived: DerivedRefs,
}

/// Prepare projection serving: derive → plan → emit → materialize → parse maps.
///
/// `cshtml_rels` are paths relative to `user_project_dir`. Tolerates a non-zero
/// `dotnet build` exit (the generator still emits when the user's C# has errors)
/// and simply skips `.cshtml` whose projection wasn't produced.
pub fn prepare(
    workspace_dir: &Path,
    user_project_dir: &Path,
    user_csproj_path: &Path,
    config: &str,
    cshtml_rels: &[PathBuf],
) -> io::Result<PreparedShadow> {
    prepare_with_timeout(
        workspace_dir,
        user_project_dir,
        user_csproj_path,
        config,
        cshtml_rels,
        DEFAULT_DOTNET_TIMEOUT,
    )
}

/// [`prepare`] with an explicit per-`dotnet` timeout.
pub fn prepare_with_timeout(
    workspace_dir: &Path,
    user_project_dir: &Path,
    user_csproj_path: &Path,
    config: &str,
    cshtml_rels: &[PathBuf],
    timeout: Duration,
) -> io::Result<PreparedShadow> {
    // Each `dotnet` spawn costs ~1-1.5s (CLI + MSBuild). We time every step and
    // skip the ones whose output is already current, so re-opening a `.cshtml`
    // doesn't pay the full pipeline again. Timings go to stderr ([razor:timing]).
    let started = Instant::now();

    // 1. derive TFM + framework references (cached per project; ~0.6s on a miss).
    let t = Instant::now();
    let derived = derive_cached(user_csproj_path, user_project_dir, timeout)?;
    eprintln!("[razor:timing] derive {:?}", t.elapsed());

    // 2. plan.
    let plan = broker::plan(&BrokerInputs {
        workspace_dir,
        user_project_dir,
        user_csproj_path,
        derived: &derived,
        config,
        root_namespace: derived.root_namespace.as_deref(),
        cshtml_rels,
    });

    // 3. emit the projected .g.cs. Skip the `dotnet build` when every projection
    //    is already newer than ALL of its inputs (re-open with no edit) — the
    //    emitted files are still current. Inputs that change generated text: the
    //    `.cshtml` itself, the `.csproj` (refs/SDK), and the project-level
    //    `_ViewImports`/`_ViewStart` (usings/inherits/inject/TagHelpers). Any
    //    newer input forces a rebuild. (Deeply-nested `_ViewImports` aren't
    //    tracked here — a V1 edge; reprepare is `.cshtml`-save scoped.)
    let mut global_inputs: Vec<PathBuf> = vec![user_csproj_path.to_path_buf()];
    for rel in [
        "Views/_ViewImports.cshtml",
        "Views/_ViewStart.cshtml",
        "_ViewImports.cshtml",
        "_ViewStart.cshtml",
    ] {
        let p = user_project_dir.join(rel);
        if p.exists() {
            global_inputs.push(p);
        }
    }
    let emit_current = plan.projections.iter().all(|pf| {
        // Use whichever emit location actually holds the file (pinned or the obj
        // fallback the SDK may have used instead).
        match exec::resolve_emitted(pf) {
            Some(emitted) => {
                let cshtml = user_project_dir.join(&pf.cshtml_rel);
                is_newer_or_equal(emitted, &cshtml)
                    && global_inputs.iter().all(|g| is_newer_or_equal(emitted, g))
            }
            None => false,
        }
    });
    if emit_current {
        eprintln!("[razor:timing] emit SKIPPED (projections up-to-date)");
    } else {
        let t = Instant::now();
        let (eprog, eargs) = &plan.emit_command;
        let _ = run_capturing(eprog, eargs, &plan.emit_cwd, timeout)?;
        eprintln!("[razor:timing] emit {:?}", t.elapsed());
    }

    // 4. materialize the shadow (write csproj, copy/remove-stale projections, .sln).
    let t = Instant::now();
    exec::materialize(&plan)?;
    eprintln!("[razor:timing] materialize {:?}", t.elapsed());

    // 4.5 restore the shadow so Roslyn can load it (it won't restore itself; it
    //     only asks via `workspace/_roslyn_projectNeedsRestore`). The shadow's
    //     deps (FrameworkReference + ProjectReference) are stable, so once
    //     `obj/project.assets.json` exists we skip the costly restore — it
    //     persists in the temp shadow across app restarts.
    let assets = plan.shadow_dir.join("obj").join("project.assets.json");
    if assets.exists() {
        eprintln!("[razor:timing] restore SKIPPED (shadow already restored)");
    } else {
        let t = Instant::now();
        let restore_args = vec![
            "restore".to_string(),
            plan.shadow_csproj_path.to_string_lossy().to_string(),
        ];
        let _ = run_capturing("dotnet", &restore_args, &plan.shadow_dir, timeout);
        eprintln!("[razor:timing] restore {:?}", t.elapsed());
    }

    // 5. build a source map per materialized projection; record any that are missing.
    let mut projections = Vec::new();
    let mut missing = Vec::new();
    for pf in &plan.projections {
        if !pf.shadow_gcs.exists() {
            missing.push(pf.cshtml_rel.clone()); // emit produced no projection (degraded)
            continue;
        }
        let generated = std::fs::read_to_string(&pf.shadow_gcs)?;
        let cshtml_abs = user_project_dir.join(&pf.cshtml_rel);
        let source_map = RazorSourceMap::parse(&generated, &cshtml_abs.to_string_lossy());
        projections.push(PreparedProjection {
            cshtml_rel: pf.cshtml_rel.clone(),
            shadow_gcs: pf.shadow_gcs.clone(),
            source_map,
        });
    }

    eprintln!("[razor:timing] prepare TOTAL {:?}", started.elapsed());
    Ok(PreparedShadow {
        plan,
        projections,
        missing,
        derived,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::razor::remap::{source_pos_to_generated, LspPos};

    /// End-to-end of the Rust runtime against the real SampleMvc fixture. Shells
    /// out to `dotnet` (slow) → `#[ignore]`. Run with:
    /// `cargo test --lib razor::runtime::tests::e2e -- --ignored`.
    #[test]
    #[ignore = "integration: runs dotnet (slow)"]
    fn e2e_prepare_real_sample_mvc() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tools/razor-lsp-probe/fixtures/SampleMvc");
        assert!(fixture.join("SampleMvc.csproj").exists(), "fixture missing");

        let ws = std::env::temp_dir().join("fluent_razor_runtime_e2e");
        let _ = std::fs::remove_dir_all(&ws);

        let prepared = prepare(
            &ws,
            &fixture,
            &fixture.join("SampleMvc.csproj"),
            "Debug",
            &[PathBuf::from("Views/Home/Index.cshtml")],
        )
        .expect("prepare");

        // shadow materialized
        assert!(prepared.plan.shadow_csproj_path.exists());
        assert!(prepared.plan.solution_path.exists());

        // one projection, nothing missing (the deliberate CS1061 still emits the .g.cs)
        assert!(prepared.missing.is_empty(), "unexpected missing: {:?}", prepared.missing);
        assert_eq!(prepared.projections.len(), 1);
        let proj = &prepared.projections[0];
        assert!(proj.shadow_gcs.exists());
        assert!(proj.source_map.region_count() > 0, "no #line regions parsed");

        // the map actually remaps the `.cshtml` `@Model.City` (Index.cshtml line 8,
        // 1-based; LSP 0-based line 7) into the generated projection.
        let gen_pos = source_pos_to_generated(&proj.source_map, LspPos::new(7, 12));
        assert!(gen_pos.is_some(), "Model.City did not remap into the projection");

        let _ = std::fs::remove_dir_all(&ws);
    }
}
