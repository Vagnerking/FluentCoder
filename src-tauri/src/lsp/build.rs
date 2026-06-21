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
pub async fn csharp_build_diagnostics(
    root_path: String,
) -> Result<Vec<BuildDiagnostic>, String> {
    let program = if cfg!(windows) { "dotnet.exe" } else { "dotnet" };
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

/// Parses MSBuild lines of the form
/// `<path>(<line>,<col>): error|warning <CODE>: <message> [<project>]`.
fn parse_diagnostics(text: &str) -> Vec<BuildDiagnostic> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in text.lines() {
        let (sev, marker) = if line.contains("): error ") {
            ("error", "): error ")
        } else if line.contains("): warning ") {
            ("warning", "): warning ")
        } else {
            continue;
        };
        let Some(pos) = line.find(marker) else { continue };

        // Head: "<path>(<line>,<col>".
        let head = &line[..pos];
        let Some(paren) = head.rfind('(') else { continue };
        let path = head[..paren].trim();
        if path.is_empty() {
            continue;
        }
        let mut loc = head[paren + 1..].split(',');
        let line_no: u32 = loc.next().and_then(|s| s.trim().parse().ok()).unwrap_or(1);
        let col_no: u32 = loc.next().and_then(|s| s.trim().parse().ok()).unwrap_or(1);

        // Tail after the marker: "<CODE>: <message> [<project>]".
        let rest = &line[pos + marker.len()..];
        let Some(colon) = rest.find(": ") else { continue };
        let code = rest[..colon].trim().to_string();
        let mut msg = rest[colon + 2..].trim().to_string();
        // Strip the trailing " [.../project.csproj]" MSBuild appends.
        if msg.ends_with(']') {
            if let Some(b) = msg.rfind(" [") {
                msg.truncate(b);
                msg = msg.trim_end().to_string();
            }
        }

        let key = format!("{path}|{line_no}|{col_no}|{code}|{msg}");
        if seen.insert(key) {
            out.push(BuildDiagnostic {
                path: path.to_string(),
                line: line_no,
                column: col_no,
                severity: sev.to_string(),
                code,
                message: msg,
            });
        }
    }

    out
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
}
