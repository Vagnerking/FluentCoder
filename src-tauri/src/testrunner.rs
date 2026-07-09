//! .NET test runner (roadmap csharp-ide-parity, Fase C).
//!
//! Discovery via `dotnet test --list-tests` (forced to English so the header
//! parse is locale-stable) and execution via the TRX logger — TRX is XML and
//! locale-independent, so outcomes never depend on the CLI language. The tiny
//! attribute-scanning parser below avoids pulling an XML crate for one file.

use std::path::{Path, PathBuf};

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DotnetTestResult {
    pub name: String,
    /// `Passed` | `Failed` | `NotExecuted` (TRX vocabulary).
    pub outcome: String,
    pub duration_ms: Option<f64>,
    /// Failure message (first `<Message>` of the result), when present.
    pub message: Option<String>,
}

/// Line coverage for one source file, parsed from a Cobertura report.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileCoverage {
    /// Absolute source-file path (as recorded by the coverage collector).
    pub path: String,
    /// Fraction of lines covered, 0.0–1.0.
    pub line_rate: f64,
    /// Line numbers that were executed at least once (1-based).
    pub covered_lines: Vec<u32>,
    /// Line numbers present but never executed (1-based).
    pub uncovered_lines: Vec<u32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotnetTestRun {
    pub results: Vec<DotnetTestResult>,
    /// Tail of the console output — surfaced when something fails structurally
    /// (build error, no tests) so the user sees WHY instead of an empty list.
    pub output_tail: String,
    /// Per-file line coverage, when the run was asked to collect it (empty otherwise).
    pub coverage: Vec<FileCoverage>,
}

fn dotnet_command() -> std::process::Command {
    let mut cmd = std::process::Command::new("dotnet");
    // Locale-stable CLI output (the TRX content is locale-free already).
    cmd.env("DOTNET_CLI_UI_LANGUAGE", "en");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn tail(s: &str, chars: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(chars)).collect()
}

/// Lists fully-qualified test names of `csproj`. Builds the project as a side
/// effect (that's how vstest discovers), so the first call can take a while.
#[tauri::command]
pub async fn dotnet_test_list(csproj_path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = dotnet_command()
            .args(["test", &csproj_path, "--list-tests", "--nologo"])
            .output()
            .map_err(|e| format!("dotnet test: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        if !out.status.success() {
            return Err(format!(
                "descoberta de testes falhou: {}",
                tail(&stdout, 600)
            ));
        }
        Ok(parse_test_list(&stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Extracts the testhost PID that vstest prints under `VSTEST_HOST_DEBUG=1`
/// ("Host debugging is enabled. … Process Id: 12345, Name: dotnet"). Pure so it's
/// unit-tested; returns the first PID found on a "Process Id:" line.
pub(crate) fn parse_testhost_pid(line: &str) -> Option<u32> {
    let idx = line.find("Process Id:")?;
    let rest = &line[idx + "Process Id:".len()..];
    let digits: String = rest.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Builds the vstest `--filter` expression for the given fully-qualified names.
/// Empty ⇒ None (run all). Multiple names are OR-ed (`FullyQualifiedName=A|
/// FullyQualifiedName=B`), which is exactly what "re-run failed" needs. Pure so
/// it's unit-tested.
pub(crate) fn build_filter_expr(fqns: &[String]) -> Option<String> {
    let parts: Vec<String> = fqns
        .iter()
        .filter(|f| !f.trim().is_empty())
        .map(|f| format!("FullyQualifiedName={f}"))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("|"))
    }
}

/// Runs tests of `csproj`. `filters` empty ⇒ all; one FQN ⇒ single test; many ⇒
/// re-run those (OR-ed). `collect_coverage` adds `--collect:"XPlat Code Coverage"`
/// and parses the Cobertura report into per-file line coverage.
#[tauri::command]
pub async fn dotnet_test_run(
    csproj_path: String,
    filters: Vec<String>,
    collect_coverage: bool,
) -> Result<DotnetTestRun, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let results_dir = std::env::temp_dir().join(format!(
            "fluent-tests-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&results_dir).map_err(|e| e.to_string())?;

        let mut cmd = dotnet_command();
        cmd.args([
            "test",
            &csproj_path,
            "--nologo",
            "--logger",
            "trx;LogFileName=run.trx",
            "--results-directory",
        ]);
        cmd.arg(&results_dir);
        if let Some(expr) = build_filter_expr(&filters) {
            cmd.arg("--filter");
            cmd.arg(expr);
        }
        // A runsettings with IncludeTestAssembly=true so coverage isn't empty
        // when the code under test lives in the test project itself (the common
        // small-project case; multi-project layouts work either way).
        let runsettings = results_dir.join("coverage.runsettings");
        if collect_coverage {
            let _ = std::fs::write(&runsettings, COVERAGE_RUNSETTINGS);
            cmd.arg("--collect:XPlat Code Coverage");
            cmd.arg("--settings");
            cmd.arg(&runsettings);
        }
        // Exit code is non-zero when any test FAILS — that's a valid run, so the
        // TRX (not the status) decides between "failed tests" and "broken run".
        let out = cmd.output().map_err(|e| format!("dotnet test: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();

        let trx = find_trx(&results_dir);
        let results = trx
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|xml| parse_trx(&xml))
            .unwrap_or_default();

        // Coverage report lands in a GUID subfolder as `coverage.cobertura.xml`.
        let coverage = if collect_coverage {
            find_cobertura(&results_dir)
                .and_then(|p| std::fs::read_to_string(p).ok())
                .map(|xml| parse_cobertura(&xml))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let _ = std::fs::remove_dir_all(&results_dir);

        if results.is_empty() && !out.status.success() {
            return Err(format!("execução falhou: {}", tail(&stdout, 600)));
        }
        Ok(DotnetTestRun {
            results,
            output_tail: tail(&stdout, 400),
            coverage,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Launches `dotnet test --filter <fqn>` under `VSTEST_HOST_DEBUG=1`, which makes
/// the testhost print its PID and BLOCK until a debugger attaches. Reads stdout
/// in streaming, returns the testhost PID (so the frontend can `debugSession
/// .attach(pid)`), and drains the rest of the process in a detached thread so it
/// runs to completion after the attach — without us killing it.
///
/// Returns the PID on success. The caller attaches the DAP debugger to it; once
/// attached, the testhost continues and the test runs under the debugger.
#[tauri::command]
pub async fn dotnet_test_debug(csproj_path: String, fqn: String) -> Result<u32, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    tauri::async_runtime::spawn_blocking(move || {
        if fqn.trim().is_empty() {
            return Err("nome do teste vazio".to_string());
        }
        let mut cmd = dotnet_command();
        cmd.env("VSTEST_HOST_DEBUG", "1")
            .args(["test", &csproj_path, "--nologo", "--filter"])
            .arg(format!("FullyQualifiedName={fqn}"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("dotnet test (debug): {e}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sem stdout do dotnet test".to_string())?;

        let mut reader = BufReader::new(stdout);
        let mut pid: Option<u32> = None;
        let mut line = String::new();
        // Read until the "Process Id:" line (VSTEST_HOST_DEBUG prints it early,
        // then blocks). Bound the scan so a broken run can't loop forever.
        for _ in 0..200 {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // EOF before the PID → the run ended/failed
                Ok(_) => {
                    if let Some(found) = parse_testhost_pid(&line) {
                        pid = Some(found);
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        let Some(pid) = pid else {
            let _ = child.kill();
            let _ = child.wait(); // reap, so no zombie is left behind
            return Err(
                "não foi possível obter o PID do testhost (VSTEST_HOST_DEBUG). O projeto compila e o teste existe?"
                    .to_string(),
            );
        };

        // Drain the rest and reap the process in the background so the testhost
        // keeps running after the debugger attaches (we must NOT kill it).
        std::thread::spawn(move || {
            let mut sink = String::new();
            for l in reader.lines().map_while(Result::ok) {
                sink.push_str(&l);
                sink.push('\n');
                if sink.len() > 8192 {
                    sink.clear();
                }
            }
            let _ = child.wait();
        });

        Ok(pid)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn find_trx(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|x| x.to_str()) == Some("trx"))
}

/// XPlat coverage lands as `coverage.cobertura.xml` inside a GUID subfolder of
/// the results dir (unlike the flat TRX), so we recurse to find it. Depth-bounded
/// so a stray symlink cycle can't loop forever (the report is one level deep).
fn find_cobertura(dir: &Path) -> Option<PathBuf> {
    find_cobertura_depth(dir, 0)
}

fn find_cobertura_depth(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 8 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        // Use symlink_metadata so we never follow a symlinked directory.
        let meta = std::fs::symlink_metadata(&p).ok()?;
        if meta.is_dir() {
            if let Some(found) = find_cobertura_depth(&p, depth + 1) {
                return Some(found);
            }
        } else if p.file_name().and_then(|n| n.to_str()) == Some("coverage.cobertura.xml") {
            return Some(p);
        }
    }
    None
}

/// Runsettings that makes the collector include the test assembly and emit
/// Cobertura, so small single-project setups still produce coverage.
const COVERAGE_RUNSETTINGS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<RunSettings>
  <DataCollectionRunSettings>
    <DataCollectors>
      <DataCollector friendlyName="XPlat code coverage">
        <Configuration>
          <IncludeTestAssembly>true</IncludeTestAssembly>
          <Format>cobertura</Format>
        </Configuration>
      </DataCollector>
    </DataCollectors>
  </DataCollectionRunSettings>
</RunSettings>
"#;

/// Parses a Cobertura report into per-file line coverage, aggregating the
/// multiple `<class filename="…">` chunks that can target the same file (partial/
/// nested classes). A line with `hits > 0` is covered. `filename` is taken as-is
/// from the report (the collector records a project-relative path).
pub(crate) fn parse_cobertura(xml: &str) -> Vec<FileCoverage> {
    use std::collections::BTreeMap;
    // file → (covered set, uncovered set)
    let mut files: BTreeMap<String, (std::collections::BTreeSet<u32>, std::collections::BTreeSet<u32>)> =
        BTreeMap::new();

    for class_chunk in xml.split("<class ").skip(1) {
        let Some(filename) = attr(class_chunk, "filename") else { continue };
        // This class's lines run until the next `<class ` (already split) or the
        // closing `</class>`; scan `<line ` entries in that scope.
        let end = class_chunk.find("</class>").unwrap_or(class_chunk.len());
        let scope = &class_chunk[..end];
        let entry = files.entry(filename.to_string()).or_default();
        for line_chunk in scope.split("<line ").skip(1) {
            let Some(number) = attr(line_chunk, "number").and_then(|n| n.parse::<u32>().ok()) else {
                continue;
            };
            let hits = attr(line_chunk, "hits").and_then(|h| h.parse::<u64>().ok()).unwrap_or(0);
            if hits > 0 {
                entry.0.insert(number);
                entry.1.remove(&number);
            } else if !entry.0.contains(&number) {
                entry.1.insert(number);
            }
        }
    }

    files
        .into_iter()
        .map(|(path, (covered, uncovered))| {
            let total = covered.len() + uncovered.len();
            let line_rate = if total == 0 {
                0.0
            } else {
                covered.len() as f64 / total as f64
            };
            FileCoverage {
                path,
                line_rate,
                covered_lines: covered.into_iter().collect(),
                uncovered_lines: uncovered.into_iter().collect(),
            }
        })
        .collect()
}

/// `--list-tests` output: a localized header line, then one test per line
/// indented with (at least) four spaces. English is forced upstream, but the
/// indent rule alone is what we parse — resilient to header wording changes.
pub(crate) fn parse_test_list(stdout: &str) -> Vec<String> {
    let mut seen_header = false;
    let mut tests = Vec::new();
    for line in stdout.lines() {
        if !seen_header {
            if line.to_lowercase().contains("are available") {
                seen_header = true;
            }
            continue;
        }
        let trimmed = line.trim();
        if line.starts_with("    ") && !trimmed.is_empty() {
            tests.push(trimmed.to_string());
        }
    }
    tests
}

/// Extracts the value of `attr="…"` inside an XML tag chunk (no entities work
/// needed for the attributes we read — names/outcomes/durations).
fn attr<'a>(chunk: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let start = chunk.find(&needle)? + needle.len();
    let end = chunk[start..].find('"')? + start;
    Some(&chunk[start..end])
}

/// `duration="HH:MM:SS.fffffff"` → milliseconds.
fn duration_ms(v: &str) -> Option<f64> {
    let mut parts = v.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(((h * 60.0 + m) * 60.0 + s) * 1000.0)
}

/// Minimal XML entity unescape for failure messages.
fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Parses `<UnitTestResult …>` entries out of a TRX report.
pub(crate) fn parse_trx(xml: &str) -> Vec<DotnetTestResult> {
    let mut results = Vec::new();
    for chunk in xml.split("<UnitTestResult ").skip(1) {
        // The chunk runs until the next result (or EOF) — enough context for the
        // attributes and this result's optional <Message>.
        let end = chunk.find("</UnitTestResult>").unwrap_or(chunk.len());
        let scope = &chunk[..end];
        let Some(name) = attr(scope, "testName") else { continue };
        let outcome = attr(scope, "outcome").unwrap_or("NotExecuted");
        let message = scope
            .find("<Message>")
            .and_then(|s| scope[s + 9..].find("</Message>").map(|e| (s + 9, s + 9 + e)))
            .map(|(s, e)| unescape(&scope[s..e]));
        results.push(DotnetTestResult {
            name: unescape(name),
            outcome: outcome.to_string(),
            duration_ms: attr(scope, "duration").and_then(duration_ms),
            message,
        });
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list_output_by_indent_after_header() {
        let out = "Determining projects to restore...\n  All projects are up-to-date\nThe following Tests are available:\n    App.Tests.CalcTests.Adds\n    App.Tests.CalcTests.Subtracts\n";
        assert_eq!(
            parse_test_list(out),
            vec!["App.Tests.CalcTests.Adds", "App.Tests.CalcTests.Subtracts"]
        );
        // Nothing before the header leaks in.
        assert!(parse_test_list("    indented but no header\n").is_empty());
    }

    #[test]
    fn parses_trx_outcomes_durations_and_failure_message() {
        let xml = r#"<TestRun><Results>
<UnitTestResult executionId="e1" testName="App.Tests.CalcTests.Adds" duration="00:00:00.0123456" outcome="Passed" />
<UnitTestResult executionId="e2" testName="App.Tests.CalcTests.Fails" duration="00:00:01.5000000" outcome="Failed">
  <Output><ErrorInfo><Message>Assert.Equal() Failure: 1 &lt; 2</Message></ErrorInfo></Output>
</UnitTestResult>
</Results></TestRun>"#;
        let r = parse_trx(xml);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].name, "App.Tests.CalcTests.Adds");
        assert_eq!(r[0].outcome, "Passed");
        assert!((r[0].duration_ms.unwrap() - 12.3456).abs() < 0.01);
        assert_eq!(r[1].outcome, "Failed");
        assert_eq!(r[1].message.as_deref(), Some("Assert.Equal() Failure: 1 < 2"));
        assert!((r[1].duration_ms.unwrap() - 1500.0).abs() < 0.01);
    }

    #[test]
    fn trx_without_results_yields_empty() {
        assert!(parse_trx("<TestRun></TestRun>").is_empty());
    }

    #[test]
    fn build_filter_expr_none_one_and_many() {
        assert_eq!(build_filter_expr(&[]), None);
        assert_eq!(
            build_filter_expr(&["A.B.C".into()]),
            Some("FullyQualifiedName=A.B.C".into())
        );
        assert_eq!(
            build_filter_expr(&["A.B.C".into(), "A.B.D".into()]),
            Some("FullyQualifiedName=A.B.C|FullyQualifiedName=A.B.D".into())
        );
        // Blank entries are dropped.
        assert_eq!(build_filter_expr(&["".into(), "  ".into()]), None);
    }

    #[test]
    fn parses_cobertura_per_file_line_coverage() {
        let xml = r#"<coverage>
<packages><package><classes>
  <class name="T.Calc" filename="src/Calc.cs">
    <lines>
      <line number="2" hits="1" branch="False" />
      <line number="3" hits="0" branch="False" />
    </lines>
  </class>
  <class name="T.Calc+Nested" filename="src/Calc.cs">
    <lines>
      <line number="5" hits="2" branch="False" />
    </lines>
  </class>
</classes></package></packages>
</coverage>"#;
        let cov = parse_cobertura(xml);
        assert_eq!(cov.len(), 1);
        let f = &cov[0];
        assert_eq!(f.path, "src/Calc.cs");
        // lines 2 and 5 covered, line 3 not → 2/3.
        assert_eq!(f.covered_lines, vec![2, 5]);
        assert_eq!(f.uncovered_lines, vec![3]);
        assert!((f.line_rate - 2.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn cobertura_covered_wins_over_uncovered_across_classes() {
        // Same line reported as uncovered in one class and covered in another.
        let xml = r#"<coverage>
<class name="A" filename="f.cs"><line number="1" hits="0" /></class>
<class name="B" filename="f.cs"><line number="1" hits="3" /></class>
</coverage>"#;
        let cov = parse_cobertura(xml);
        assert_eq!(cov[0].covered_lines, vec![1]);
        assert!(cov[0].uncovered_lines.is_empty());
    }

    #[test]
    fn cobertura_empty_report_yields_nothing() {
        assert!(parse_cobertura("<coverage><packages /></coverage>").is_empty());
    }

    #[test]
    fn parses_testhost_pid_from_vstest_line() {
        assert_eq!(
            parse_testhost_pid("Process Id: 21974, Name: dotnet"),
            Some(21974)
        );
        // Real two-line form: the message then the id line.
        assert_eq!(
            parse_testhost_pid("Host debugging is enabled. Please attach debugger to testhost process to continue."),
            None
        );
        assert_eq!(parse_testhost_pid("nada aqui"), None);
    }
}
