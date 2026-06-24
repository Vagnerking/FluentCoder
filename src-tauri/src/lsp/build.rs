//! Pragmatic build diagnostics (issue #11): run the real compiler.
//!
//! The Razor LSP cohost is fragile to wire up end-to-end, but the .NET SDK the
//! user already has is the ground truth. Running `dotnet build` and parsing its
//! MSBuild error/warning lines gives reliable diagnostics for BOTH C# (.cs) and
//! Razor (.cshtml/.razor) — with file, line and column — independent of the LSP.
//! The frontend triggers this on save and surfaces the results as editor markers
//! (squiggles) + the Problems panel.

/// One diagnostic parsed from MSBuild output.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDiagnostic {
    /// Absolute file path the diagnostic belongs to.
    pub path: String,
    /// 1-based line.
    pub line: u32,
    /// 1-based column.
    pub column: u32,
    /// `"error"` or `"warning"`.
    pub severity: String,
    /// Compiler code, e.g. `CS1061`, `RZ1006`.
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

/// Runs `dotnet build` in `root_path` and returns the parsed diagnostics.
///
/// Async so it runs off the UI thread. Returns an empty list (not an error) when
/// there's nothing to report; only a failure to launch `dotnet` is an error.
#[tauri::command]
pub async fn csharp_build_diagnostics(root_path: String) -> Result<Vec<BuildDiagnostic>, String> {
    let program = if cfg!(windows) {
        "dotnet.exe"
    } else {
        "dotnet"
    };
    let output = tokio::process::Command::new(program)
        .args(["build", "-nologo", "-clp:NoSummary", "-v", "q"])
        .current_dir(&root_path)
        .output()
        .await
        .map_err(|e| {
            format!("Não foi possível executar o dotnet build (o .NET SDK está instalado?): {e}")
        })?;

    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(parse_diagnostics(&text))
}

/// Parses MSBuild diagnostics in two shapes:
///
/// 1. Per-source, with location:
///    `<path>(<line>,<col>): error|warning <CODE>: <message> [<project>]`
///    — compiler diagnostics (CS…, RZ…) tied to a file line/column.
/// 2. Top-level, no location:
///    `<source> : error|warning <CODE>: <message> [<project>]`
///    — MSBuild/NuGet/SDK errors such as `MSB1003` (no project at root),
///    `NU1101` (restore failed), `MSB4236` (SDK missing). These have NO
///    line/column and `<source>` is `MSBUILD`, a `.csproj`/`.sln`, or empty.
///    Without these the UI showed NOTHING when a build couldn't even start —
///    `csharp_build_diagnostics` returns `Ok(empty)` on a non-zero exit, so a
///    restore/SDK failure was silent. We surface them at line/col 1 so they reach
///    the Problems panel (the frontend keeps only ones inside the workspace).
fn parse_diagnostics(text: &str) -> Vec<BuildDiagnostic> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in text.lines() {
        let parsed = parse_located(line).or_else(|| parse_top_level(line));
        let Some(diag) = parsed else { continue };

        let key = format!(
            "{}|{}|{}|{}|{}",
            diag.path, diag.line, diag.column, diag.code, diag.message
        );
        if seen.insert(key) {
            out.push(diag);
        }
    }

    out
}

/// Strips the trailing ` [.../project.csproj]` MSBuild appends to a message.
fn strip_project_suffix(msg: &str) -> String {
    let msg = msg.trim();
    if msg.ends_with(']') {
        if let Some(b) = msg.rfind(" [") {
            return msg[..b].trim_end().to_string();
        }
    }
    msg.to_string()
}

/// Parses shape 1: `<path>(<line>,<col>): error|warning <CODE>: <message>`.
fn parse_located(line: &str) -> Option<BuildDiagnostic> {
    let (sev, marker) = if line.contains("): error ") {
        ("error", "): error ")
    } else if line.contains("): warning ") {
        ("warning", "): warning ")
    } else {
        return None;
    };
    let pos = line.find(marker)?;

    // Head: "<path>(<line>,<col>".
    let head = &line[..pos];
    let paren = head.rfind('(')?;
    let path = head[..paren].trim();
    if path.is_empty() {
        return None;
    }
    let mut loc = head[paren + 1..].split(',');
    let line_no: u32 = loc.next().and_then(|s| s.trim().parse().ok()).unwrap_or(1);
    let col_no: u32 = loc.next().and_then(|s| s.trim().parse().ok()).unwrap_or(1);

    // Tail after the marker: "<CODE>: <message> [<project>]".
    let rest = &line[pos + marker.len()..];
    let colon = rest.find(": ")?;
    let code = rest[..colon].trim().to_string();
    let msg = strip_project_suffix(&rest[colon + 2..]);

    Some(BuildDiagnostic {
        path: path.to_string(),
        line: line_no,
        column: col_no,
        severity: sev.to_string(),
        code,
        message: msg,
    })
}

/// Parses shape 2: `<source> : error|warning <CODE>: <message>` (no line/col).
/// `<source>` is the project/solution path when MSBuild reports one (so the
/// diagnostic attaches to that file), or a bare token like `MSBUILD` otherwise.
fn parse_top_level(line: &str) -> Option<BuildDiagnostic> {
    let (sev, marker) = if line.contains(" : error ") {
        ("error", " : error ")
    } else if line.contains(" : warning ") {
        ("warning", " : warning ")
    } else {
        return None;
    };
    let pos = line.find(marker)?;

    let source = line[..pos].trim();

    // Tail after the marker: "<CODE>: <message> [<project>]".
    let rest = &line[pos + marker.len()..];
    let colon = rest.find(": ")?;
    let code = rest[..colon].trim().to_string();
    if code.is_empty() {
        return None;
    }
    let msg = strip_project_suffix(&rest[colon + 2..]);

    // Prefer a real project/solution path as the attach point; otherwise fall
    // back to the trailing ` [<project>]` MSBuild appends, so the diagnostic
    // still lands on a file the workspace filter can match. Bare `MSBUILD` with
    // no project would be filtered out by the frontend (not inside the root),
    // which is acceptable — those are environment errors, not code errors.
    let path = if looks_like_project_path(source) {
        source.to_string()
    } else {
        project_from_suffix(&rest[colon + 2..]).unwrap_or_else(|| source.to_string())
    };

    Some(BuildDiagnostic {
        path,
        line: 1,
        column: 1,
        severity: sev.to_string(),
        code,
        message: msg,
    })
}

/// Whether `s` looks like a file path to a project/solution (has a separator and
/// a known extension), as opposed to a bare token like `MSBUILD`.
fn looks_like_project_path(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    (lower.ends_with(".csproj") || lower.ends_with(".sln") || lower.ends_with(".fsproj"))
        && (s.contains('/') || s.contains('\\'))
}

/// Extracts the ` [<project>]` path MSBuild appends to a message, if present and
/// it points at a project/solution file.
fn project_from_suffix(msg: &str) -> Option<String> {
    let msg = msg.trim();
    if !msg.ends_with(']') {
        return None;
    }
    let open = msg.rfind(" [")?;
    let inner = msg[open + 2..msg.len() - 1].trim();
    if looks_like_project_path(inner) {
        Some(inner.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_csharp_error_in_cshtml() {
        let text = "C:\\proj\\Pages\\Index.cshtml(12,11): error CS1061: 'IndexModel' não contém 'X' [C:\\proj\\proj.csproj]";
        let d = parse_diagnostics(text);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].path, "C:\\proj\\Pages\\Index.cshtml");
        assert_eq!(d[0].line, 12);
        assert_eq!(d[0].column, 11);
        assert_eq!(d[0].severity, "error");
        assert_eq!(d[0].code, "CS1061");
        assert!(d[0].message.starts_with("'IndexModel'"));
        assert!(!d[0].message.contains("proj.csproj"));
    }

    #[test]
    fn dedups_and_parses_warnings() {
        let text = "a.cs(1,1): warning CS0168: unused [p.csproj]\na.cs(1,1): warning CS0168: unused [p.csproj]";
        let d = parse_diagnostics(text);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].severity, "warning");
    }

    #[test]
    fn parses_nuget_restore_error_attached_to_project() {
        // A NuGet restore failure: top-level, no line/col, project as the source.
        let text =
            "C:\\proj\\App.csproj : error NU1101: Unable to find package Foo [C:\\proj\\App.sln]";
        let d = parse_diagnostics(text);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].path, "C:\\proj\\App.csproj");
        assert_eq!(d[0].line, 1);
        assert_eq!(d[0].column, 1);
        assert_eq!(d[0].severity, "error");
        assert_eq!(d[0].code, "NU1101");
        assert_eq!(d[0].message, "Unable to find package Foo");
    }

    #[test]
    fn parses_top_level_msbuild_error_attaches_to_project_suffix() {
        // `MSBUILD` source with a project in the trailing suffix: attach to the
        // project so the workspace filter can keep it.
        let text = "MSBUILD : error MSB4236: The SDK 'X' was not found. [C:\\proj\\App.csproj]";
        let d = parse_diagnostics(text);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].path, "C:\\proj\\App.csproj");
        assert_eq!(d[0].code, "MSB4236");
        assert_eq!(d[0].severity, "error");
        assert!(d[0].message.starts_with("The SDK 'X'"));
    }

    #[test]
    fn parses_bare_msbuild_error_without_project() {
        // No project anywhere (e.g. MSB1003 at a root with no solution). Still
        // parsed; path is the bare source. The frontend's in-root filter drops
        // it (not a real workspace file), which is acceptable for env errors.
        let text = "MSBUILD : error MSB1003: Specify a project or solution file.";
        let d = parse_diagnostics(text);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].code, "MSB1003");
        assert_eq!(d[0].path, "MSBUILD");
    }

    #[test]
    fn located_form_is_not_double_counted_as_top_level() {
        // A located line also contains "): error " but NOT " : error " — ensure
        // it parses once, via the located path, with its line/column intact.
        let text =
            "C:\\proj\\a.cs(7,3): error CS0103: The name 'y' does not exist [C:\\proj\\a.csproj]";
        let d = parse_diagnostics(text);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].line, 7);
        assert_eq!(d[0].column, 3);
        assert_eq!(d[0].code, "CS0103");
    }

    #[test]
    fn ignores_non_diagnostic_lines() {
        let text = "Build succeeded.\n    2 Warning(s)\n    0 Error(s)\nTime Elapsed 00:00:10.45";
        assert!(parse_diagnostics(text).is_empty());
    }
}
