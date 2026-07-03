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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotnetTestRun {
    pub results: Vec<DotnetTestResult>,
    /// Tail of the console output — surfaced when something fails structurally
    /// (build error, no tests) so the user sees WHY instead of an empty list.
    pub output_tail: String,
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

/// Runs tests of `csproj` (all, or only `filter` = a FullyQualifiedName) and
/// returns per-test outcomes parsed from the TRX report.
#[tauri::command]
pub async fn dotnet_test_run(
    csproj_path: String,
    filter: Option<String>,
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
        if let Some(f) = filter.as_deref().filter(|f| !f.is_empty()) {
            cmd.arg("--filter");
            cmd.arg(format!("FullyQualifiedName={f}"));
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
        let _ = std::fs::remove_dir_all(&results_dir);

        if results.is_empty() && !out.status.success() {
            return Err(format!("execução falhou: {}", tail(&stdout, 600)));
        }
        Ok(DotnetTestRun {
            results,
            output_tail: tail(&stdout, 400),
        })
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
}
