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
use std::hash::{Hash, Hasher};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
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

/// Canonical cache/lock key for a project path. Case-folds only on Windows —
/// on case-sensitive filesystems two paths differing by case are distinct
/// projects (mirrors `canonical_key` in `commands.rs`).
fn project_key(csproj: &Path) -> String {
    let k = csproj.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { k.to_ascii_lowercase() } else { k }
}

/// Run one derive eval and parse it, mapping every failure to an error that
/// carries the dotnet stderr/exit context (no more silent "could not derive").
fn run_derive(
    cmd: (String, Vec<String>),
    project_dir: &Path,
    timeout: Duration,
) -> io::Result<DerivedRefs> {
    let (prog, args) = cmd;
    let out = run_capturing(&prog, &args, project_dir, timeout)?;
    if !out.success {
        return Err(io::Error::other(format!(
            "derive eval failed (exit {}): {}",
            out.exit_code_display(),
            out.stderr_tail()
        )));
    }
    derive::parse_derived(&String::from_utf8_lossy(&out.stdout)).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "could not derive a TargetFramework (no TargetFramework or TargetFrameworks)",
        )
    })
}

/// Derive (or reuse the cached) refs for `csproj`. Re-derives when any derive
/// input changed since the cache entry, or when there is no usable fingerprint.
///
/// The eval is design-time + `--no-restore` (never builds/restores the graph).
/// If it fails — typically a project that was NEVER restored on this machine —
/// we retry ONCE with the restoring variant, which is O(NuGet graph) but genuinely
/// unavoidable at that point.
fn derive_cached(csproj: &Path, project_dir: &Path, timeout: Duration) -> io::Result<DerivedRefs> {
    let key = project_key(csproj);
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
    let csproj_str = csproj.to_string_lossy();
    let mut derived = match run_derive(derive::derive_command(&csproj_str), project_dir, timeout) {
        Ok(d) => d,
        Err(first_err) => {
            // One-shot restore retry: covers the "assets missing" first-ever case.
            eprintln!("[razor:derive] no-restore eval failed ({first_err}); retrying with restore");
            run_derive(
                derive::derive_command_with_restore(&csproj_str, None),
                project_dir,
                timeout,
            )?
        }
    };
    // Multi-targeting: the first eval had no active TFM, so `ReferencePath` came
    // back empty. Re-derive pinned to the selected TFM (`-f`) to resolve that
    // framework's real references — without this the live sidecar's compilation
    // would be missing assemblies for multi-target projects.
    if derived.multi_target_selected {
        match run_derive(
            derive::derive_command_for_tfm(&csproj_str, Some(&derived.tfm)),
            project_dir,
            timeout,
        ) {
            Ok(d2) => derived = d2,
            Err(e) => {
                // Keeping the TFM-less eval would silently serve EMPTY references
                // (every project type resolves as "missing"). Fail loudly instead.
                return Err(io::Error::other(format!(
                    "multi-target re-derive for {} failed: {e}",
                    derived.tfm
                )));
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

/// Every `_ViewImports.cshtml`/`_ViewStart.cshtml` that affects `cshtml_rel`: the
/// Razor compiler merges the chain from the view's own folder up to the project
/// root, so an edit to ANY of them (including `Areas/**` and nested `Views/`
/// subfolders) must invalidate the emitted projection.
pub(crate) fn view_import_chain(user_project_dir: &Path, cshtml_rel: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut dir = cshtml_rel.parent();
    loop {
        let base = match dir {
            Some(d) => user_project_dir.join(d),
            None => user_project_dir.to_path_buf(),
        };
        for name in ["_ViewImports.cshtml", "_ViewStart.cshtml"] {
            let p = base.join(name);
            if p.exists() {
                out.push(p);
            }
        }
        match dir {
            Some(d) if !d.as_os_str().is_empty() => dir = d.parent(),
            _ => break,
        }
    }
    out
}

/// Stable fingerprint of a text (shadow csproj content) for restore skipping.
fn content_fingerprint(text: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// True if `a` is at least as new as `b` (by modified time). Conservative: any
/// missing/unreadable mtime returns false, so callers re-do the work rather than
/// trust a stale artifact.
pub(crate) fn is_newer_or_equal(a: &Path, b: &Path) -> bool {
    match (
        std::fs::metadata(a).and_then(|m| m.modified()),
        std::fs::metadata(b).and_then(|m| m.modified()),
    ) {
        (Ok(ta), Ok(tb)) => ta >= tb,
        _ => false,
    }
}

/// Output of a captured child process: stdout, a bounded stderr tail (for error
/// reporting — never the user's code, just tool output), and the exit status.
pub struct Captured {
    pub stdout: Vec<u8>,
    stderr: Vec<u8>,
    pub success: bool,
    exit_code: Option<i32>,
}

impl Captured {
    /// Last ~2KB of stderr, lossily decoded and whitespace-trimmed — enough to
    /// say WHY dotnet failed without flooding logs.
    pub fn stderr_tail(&self) -> String {
        const CAP: usize = 2048;
        let start = self.stderr.len().saturating_sub(CAP);
        String::from_utf8_lossy(&self.stderr[start..]).trim().to_string()
    }

    pub fn exit_code_display(&self) -> String {
        self.exit_code.map_or_else(|| "signal".to_string(), |c| c.to_string())
    }
}

/// Run a command capturing stdout AND stderr, killing it (and erroring) if it
/// exceeds `timeout`. Prevents a hung `dotnet` from blocking the caller forever.
/// Callers decide what a non-zero exit means (`Captured::success`) — a failing
/// user compile still emits generator output, but a failing restore is fatal.
fn run_capturing(program: &str, args: &[String], cwd: &Path, timeout: Duration) -> io::Result<Captured> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // On Windows, don't flash a console window for the spawned `dotnet`.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
    // Drain each pipe on its own thread so a full buffer can't deadlock the child.
    // The threads send the captured bytes over channels at EOF — letting us wait
    // with a DEADLINE rather than an unbounded `join()`.
    let mut stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf); // ignore: receiver may be gone (we timed out)
    });
    let mut stderr_pipe = child.stderr.take().expect("piped stderr");
    let (etx, erx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        let _ = etx.send(buf);
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break st;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait(); // reap the killed child
            // The reader threads are detached (we hold only the receivers): a
            // `dotnet` descendant (e.g. VBCSCompiler) may still hold the pipes, so
            // we never block on them — dropping the receivers lets them finish.
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("`{program}` timed out after {}s", timeout.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // The child exited, but pipe EOF can still lag if a descendant kept a write
    // end open. Wait for the readers only until the deadline — never unboundedly.
    let remaining = deadline.saturating_duration_since(Instant::now());
    let stdout_buf = match rx.recv_timeout(remaining.max(Duration::from_millis(1))) {
        Ok(buf) => buf,
        Err(_) => {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("`{program}` exited but its stdout stayed open past the timeout"),
            ))
        }
    };
    // stderr is best-effort context: don't fail the call over a lagging pipe.
    let stderr_buf = erx.try_recv().or_else(|_| {
        erx.recv_timeout(Duration::from_millis(200))
    }).unwrap_or_default();
    Ok(Captured {
        stdout: stdout_buf,
        stderr: stderr_buf,
        success: status.success(),
        exit_code: status.code(),
    })
}

/// Per-project prepare serialization: two concurrent `prepare()`s for the SAME
/// project (open+open, open+save) would race `dotnet` over the same `obj/` and
/// the same shadow dir. The second caller blocks briefly and then finds every
/// cache warm, instead of doubling the work.
static PREPARE_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

fn prepare_lock_for(csproj: &Path) -> Arc<Mutex<()>> {
    let locks = PREPARE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = locks.lock().unwrap_or_else(|p| p.into_inner());
    guard.entry(project_key(csproj)).or_default().clone()
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

/// Result of [`prepare_shell`]: the plan + derived refs, with the shadow shell
/// (csproj/sln) materialized and restored — but NO projections emitted yet. The
/// caller produces each `.g.cs` via the live sidecar (fast path) and only falls
/// back to [`emit_fallback`] (a `dotnet build`) when the sidecar can't.
pub struct ShellPrepared {
    pub plan: BrokerPlan,
    pub derived: DerivedRefs,
}

/// Derive → plan → materialize shell → restore. Never emits — the whole point of
/// the redesign is that NOTHING on the open/save path builds the user's project.
pub fn prepare_shell(
    workspace_dir: &Path,
    user_project_dir: &Path,
    user_csproj_path: &Path,
    config: &str,
    cshtml_rels: &[PathBuf],
    timeout: Duration,
) -> io::Result<ShellPrepared> {
    let started = Instant::now();

    // Serialize per project: a concurrent prepare for the same project would
    // race dotnet over the same obj/ and shadow. The loser of the race finds
    // warm caches when it acquires the lock.
    let lock = prepare_lock_for(user_csproj_path);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());

    // 1. derive TFM + framework references (cached per project; ~0.6s on a miss;
    //    design-time — no restore, no builds).
    let t = Instant::now();
    let derived = derive_cached(user_csproj_path, user_project_dir, timeout)?;
    eprintln!("[razor:timing] derive {:?}", t.elapsed());

    // 2. plan (pure).
    let plan = broker::plan(&BrokerInputs {
        workspace_dir,
        user_project_dir,
        user_csproj_path,
        derived: &derived,
        config,
        root_namespace: derived.root_namespace.as_deref(),
        cshtml_rels,
    });

    // 3. materialize the shell (csproj + sln, content-aware: no mtime churn).
    let t = Instant::now();
    exec::materialize_shell(&plan)?;
    eprintln!("[razor:timing] materialize-shell {:?}", t.elapsed());

    // 4. restore the shadow so Roslyn can load it.
    restore_shadow(&plan, timeout);

    eprintln!("[razor:timing] prepare-shell TOTAL {:?}", started.elapsed());
    Ok(ShellPrepared { plan, derived })
}

/// Restore the shadow project (it won't restore itself; Roslyn only asks via
/// `workspace/_roslyn_projectNeedsRestore`). `-p:RestoreRecursive=false` restores
/// ONLY the shadow — without it, NuGet walks the ProjectReference into the user
/// project and its whole graph (23+ projects in a monorepo), which the user's own
/// restore already covers. Skips when the assets exist AND the shadow csproj
/// content hasn't changed since the restore that produced them (a bare "assets
/// exist" skip served stale assets after TFM/FrameworkReference changes forever).
fn restore_shadow(plan: &BrokerPlan, timeout: Duration) {
    let assets = plan.shadow_dir.join("obj").join("project.assets.json");
    let fp_path = plan.shadow_dir.join("obj").join(".fluent-restore-fp");
    let fp_current = content_fingerprint(&plan.shadow_csproj_content);
    let fp_on_disk = std::fs::read_to_string(&fp_path).unwrap_or_default();
    if assets.exists() && fp_on_disk == fp_current {
        eprintln!("[razor:timing] restore SKIPPED (shadow already restored)");
        return;
    }
    let t = Instant::now();
    let restore_args = vec![
        "restore".to_string(),
        plan.shadow_csproj_path.to_string_lossy().to_string(),
        "-p:RestoreRecursive=false".to_string(),
    ];
    match run_capturing("dotnet", &restore_args, &plan.shadow_dir, timeout) {
        Ok(out) if out.success => {
            // Record what we restored; failure to write only means an extra
            // restore next time.
            let _ = std::fs::write(&fp_path, &fp_current);
        }
        Ok(out) => eprintln!(
            "[razor:error] shadow restore exited {} — {}",
            out.exit_code_display(),
            out.stderr_tail()
        ),
        Err(e) => eprintln!("[razor:error] shadow restore failed to run: {e}"),
    }
    eprintln!("[razor:timing] restore {:?}", t.elapsed());
}

/// True when `pf`'s on-disk shadow projection is newer than every input that can
/// change its generated text: the `.cshtml` itself, the `.csproj` (refs/SDK), and
/// the `_ViewImports`/`_ViewStart` chain from the view's folder up to the project
/// root (including Areas/nested ones).
pub fn projection_current(
    user_project_dir: &Path,
    user_csproj_path: &Path,
    pf: &broker::ProjectionFile,
) -> bool {
    if !pf.shadow_gcs.exists() {
        return false;
    }
    let cshtml = user_project_dir.join(&pf.cshtml_rel);
    is_newer_or_equal(&pf.shadow_gcs, &cshtml)
        && is_newer_or_equal(&pf.shadow_gcs, user_csproj_path)
        && view_import_chain(user_project_dir, &pf.cshtml_rel)
            .iter()
            .all(|g| is_newer_or_equal(&pf.shadow_gcs, g))
}

/// FALLBACK emit: one `dotnet build` of the user project (scoped: single project,
/// single TFM, no dependency builds) + copy the emitted `.g.cs` into the shadow.
/// Only for when the sidecar can't produce a projection (not built / crashed).
/// Serialized by the same per-project lock as [`prepare_shell`].
pub fn emit_fallback(
    plan: &BrokerPlan,
    user_project_dir: &Path,
    timeout: Duration,
) -> io::Result<()> {
    let lock = prepare_lock_for(&plan.user_csproj_path);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());

    // Skip the build when every emitted file is already newer than its inputs
    // (re-open with no edit).
    let emit_current = plan.projections.iter().all(|pf| {
        match exec::resolve_emitted(pf) {
            Some(emitted) => {
                let cshtml = user_project_dir.join(&pf.cshtml_rel);
                is_newer_or_equal(emitted, &cshtml)
                    && is_newer_or_equal(emitted, &plan.user_csproj_path)
                    && view_import_chain(user_project_dir, &pf.cshtml_rel)
                        .iter()
                        .all(|g| is_newer_or_equal(emitted, g))
            }
            None => false,
        }
    });
    if emit_current {
        eprintln!("[razor:timing] emit-fallback SKIPPED (projections up-to-date)");
    } else {
        let t = Instant::now();
        let (eprog, eargs) = &plan.emit_command;
        let out = run_capturing(eprog, eargs, &plan.emit_cwd, timeout)?;
        if !out.success {
            // Non-zero emit is TOLERATED (the generator still emits when the
            // user's C# has errors) but no longer silent: if the .g.cs ends up
            // missing, this line says why.
            eprintln!(
                "[razor:error] emit-fallback exited {} — {}",
                out.exit_code_display(),
                out.stderr_tail()
            );
        }
        eprintln!("[razor:timing] emit-fallback {:?}", t.elapsed());
    }
    exec::materialize_projections(plan)
}

/// [`prepare`] with an explicit per-`dotnet` timeout. Legacy full pipeline
/// (shell + dotnet-build emit + map parse) — the command layer now drives the
/// sidecar-first flow itself and only uses [`emit_fallback`]; this remains for
/// the e2e test and as the complete non-sidecar reference path.
pub fn prepare_with_timeout(
    workspace_dir: &Path,
    user_project_dir: &Path,
    user_csproj_path: &Path,
    config: &str,
    cshtml_rels: &[PathBuf],
    timeout: Duration,
) -> io::Result<PreparedShadow> {
    let shell = prepare_shell(
        workspace_dir,
        user_project_dir,
        user_csproj_path,
        config,
        cshtml_rels,
        timeout,
    )?;
    emit_fallback(&shell.plan, user_project_dir, timeout)?;

    // Build a source map per materialized projection; record any that are missing.
    let mut projections = Vec::new();
    let mut missing = Vec::new();
    for pf in &shell.plan.projections {
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

    Ok(PreparedShadow {
        plan: shell.plan,
        projections,
        missing,
        derived: shell.derived,
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
