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

use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::broker::{self, BrokerInputs, BrokerPlan};
use super::derive;
use super::exec;
use super::sourcemap::RazorSourceMap;

/// Default timeout for a `dotnet` invocation (derive/emit). Builds can be slow on
/// first run; tune via [`prepare_with_timeout`].
pub const DEFAULT_DOTNET_TIMEOUT: Duration = Duration::from_secs(180);

/// Run a command capturing stdout, killing it (and erroring) if it exceeds
/// `timeout`. Prevents a hung `dotnet` from blocking the caller forever.
fn run_capturing(program: &str, args: &[String], cwd: &Path, timeout: Duration) -> io::Result<Vec<u8>> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    // Drain stdout on a thread so a full pipe buffer can't deadlock the child.
    let mut stdout = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait(); // reap the killed child
            // Detach the stdout-drain thread instead of joining: a `dotnet`
            // descendant (e.g. VBCSCompiler) may still hold the pipe, and joining
            // could block past the timeout. Dropping the handle lets it finish on
            // its own without blocking us.
            drop(reader);
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("`{program}` timed out after {}s", timeout.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(reader.join().unwrap_or_default())
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
    // 1. derive TFM + framework references from the user project (MSBuild eval).
    let (dprog, dargs) = derive::derive_command(&user_csproj_path.to_string_lossy());
    let derive_out = run_capturing(&dprog, &dargs, user_project_dir, timeout)?;
    let derived = derive::parse_derived(&String::from_utf8_lossy(&derive_out)).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "could not derive TargetFramework (multi-targeting? pass an explicit TFM)",
        )
    })?;

    // 2. plan.
    let plan = broker::plan(&BrokerInputs {
        workspace_dir,
        user_project_dir,
        user_csproj_path,
        derived: &derived,
        config,
        root_namespace: None, // V1: shadow root namespace not derived (minor)
        cshtml_rels,
    });

    // 3. emit the projected .g.cs (tolerate non-zero exit — generator still emits).
    let (eprog, eargs) = &plan.emit_command;
    let _ = run_capturing(eprog, eargs, &plan.emit_cwd, timeout)?;

    // 4. materialize the shadow (write csproj, copy/remove-stale projections, .sln).
    exec::materialize(&plan)?;

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

    Ok(PreparedShadow {
        plan,
        projections,
        missing,
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
