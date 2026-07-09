//! .NET project tooling (milestone #11 — Gestão de projeto .NET): explicit
//! build/rebuild/clean/restore actions, plus NuGet package management, driven by
//! the `dotnet` CLI. Output-parsing commands force `--format json` where the SDK
//! supports it, so parsing is structured (never regex over localized text).
//!
//! Diagnostics-on-save stays in `lsp/build.rs`; this module is for the explicit,
//! user-triggered project actions the C# Dev Kit exposes.

use std::path::Path;

/// Builds a `dotnet` Command with the shared hardening: English CLI output (so
/// any text we surface is stable) and no console-window flash on Windows.
fn dotnet_command() -> std::process::Command {
    let mut cmd = std::process::Command::new(if cfg!(windows) { "dotnet.exe" } else { "dotnet" });
    cmd.env("DOTNET_CLI_UI_LANGUAGE", "en");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Result of a build-like action: whether the CLI exited 0 and the tail of its
/// combined output (so the user sees why on failure without a huge dump).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotnetActionResult {
    pub success: bool,
    /// Tail of stdout+stderr (last ~4000 chars).
    pub output: String,
}

fn tail(s: &str, chars: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(chars)).collect()
}

/// Runs a `dotnet <verb> [target] [-nologo] [extra…]` action and returns success
/// + output tail. `target` empty ⇒ let the CLI find the project/solution.
/// `nologo` adds `-nologo` (valid for build/clean/restore; NOT for add/remove).
async fn run_dotnet_action_opts(
    verb: &str,
    target: String,
    extra: Vec<String>,
    nologo: bool,
) -> Result<DotnetActionResult, String> {
    let verb = verb.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = dotnet_command();
        cmd.arg(&verb);
        if !target.is_empty() {
            cmd.arg(&target);
        }
        if nologo {
            cmd.arg("-nologo");
        }
        for e in &extra {
            cmd.arg(e);
        }
        let out = cmd
            .output()
            .map_err(|e| format!("Não foi possível executar o dotnet (o .NET SDK está instalado?): {e}"))?;
        let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
        let err = String::from_utf8_lossy(&out.stderr);
        if !err.trim().is_empty() {
            combined.push_str("\n");
            combined.push_str(&err);
        }
        Ok(DotnetActionResult {
            success: out.status.success(),
            output: tail(&combined, 4000),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Build-like action with `-nologo` (build/clean/restore/rebuild).
async fn run_dotnet_action(
    verb: &str,
    target: String,
    extra: Vec<String>,
) -> Result<DotnetActionResult, String> {
    run_dotnet_action_opts(verb, target, extra, true).await
}

/// `dotnet build <target>`. `target` = a `.csproj`/`.sln` path, or "" for the root.
#[tauri::command]
pub async fn dotnet_build(target: String) -> Result<DotnetActionResult, String> {
    run_dotnet_action("build", target, vec![]).await
}

/// `dotnet clean <target>` — removes build outputs.
#[tauri::command]
pub async fn dotnet_clean(target: String) -> Result<DotnetActionResult, String> {
    run_dotnet_action("clean", target, vec![]).await
}

/// `dotnet restore <target>` — restores NuGet packages.
#[tauri::command]
pub async fn dotnet_restore(target: String) -> Result<DotnetActionResult, String> {
    run_dotnet_action("restore", target, vec![]).await
}

/// Rebuild = clean then build. Runs sequentially; if clean fails the output is
/// returned as-is (build is skipped) so the user sees the failing step.
#[tauri::command]
pub async fn dotnet_rebuild(target: String) -> Result<DotnetActionResult, String> {
    let cleaned = run_dotnet_action("clean", target.clone(), vec![]).await?;
    if !cleaned.success {
        return Ok(cleaned);
    }
    // `--no-incremental` forces a full recompile, matching "Rebuild" semantics.
    run_dotnet_action("build", target, vec!["--no-incremental".to_string()]).await
}

/// Validates that a target path (when non-empty) points at a `.csproj`/`.sln`
/// under `root`. Pure so it can be unit-tested; used to reject stray paths.
pub(crate) fn is_valid_dotnet_target(root: &str, target: &str) -> bool {
    if target.is_empty() {
        return true; // "" = whole workspace, always allowed
    }
    let ok_ext = target.to_lowercase();
    if !(ok_ext.ends_with(".csproj") || ok_ext.ends_with(".sln") || ok_ext.ends_with(".slnx")) {
        return false;
    }
    // Must live inside the workspace root.
    Path::new(target).starts_with(Path::new(root))
        || Path::new(target).is_relative()
}

// ── NuGet package management ────────────────────────────────────────────────
//
// All driven by the `dotnet` CLI with `--format json`, so parsing is structured
// (never regex over localized text). `dotnet list package` gives installed
// versions; `--outdated` adds `latestVersion`; `dotnet package search` queries
// nuget.org; `dotnet add/remove package` mutate the csproj.

/// An installed package, merged from `list` (+`--outdated` for `latest`).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NugetPackage {
    pub id: String,
    pub requested_version: String,
    pub resolved_version: String,
    /// Newest version available, when known (from `--outdated`); None if current.
    pub latest_version: Option<String>,
}

// ---- Deserialization shapes for `dotnet list package --format json` ----
#[derive(serde::Deserialize)]
struct ListJson {
    #[serde(default)]
    projects: Vec<ListProject>,
}
#[derive(serde::Deserialize)]
struct ListProject {
    #[serde(default)]
    frameworks: Vec<ListFramework>,
}
#[derive(serde::Deserialize)]
struct ListFramework {
    #[serde(default, rename = "topLevelPackages")]
    top_level_packages: Vec<ListPackage>,
}
#[derive(serde::Deserialize)]
struct ListPackage {
    id: String,
    #[serde(default, rename = "requestedVersion")]
    requested_version: String,
    #[serde(default, rename = "resolvedVersion")]
    resolved_version: String,
    #[serde(default, rename = "latestVersion")]
    latest_version: Option<String>,
}

/// Parses `dotnet list package --format json` (with or without `--outdated`) into
/// a flat, de-duplicated package list (a package can appear under multiple TFMs;
/// we keep the first occurrence). Pure, so it's unit-tested against captured JSON.
pub(crate) fn parse_nuget_list(json: &str) -> Result<Vec<NugetPackage>, String> {
    let parsed: ListJson = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for proj in parsed.projects {
        for fw in proj.frameworks {
            for p in fw.top_level_packages {
                if !seen.insert(p.id.clone()) {
                    continue;
                }
                out.push(NugetPackage {
                    id: p.id,
                    requested_version: p.requested_version,
                    resolved_version: p.resolved_version,
                    latest_version: p.latest_version,
                });
            }
        }
    }
    Ok(out)
}

// ---- Deserialization shapes for `dotnet package search --format json` ----
#[derive(serde::Deserialize)]
struct SearchJson {
    #[serde(default, rename = "searchResult")]
    search_result: Vec<SearchSource>,
}
#[derive(serde::Deserialize)]
struct SearchSource {
    #[serde(default)]
    packages: Vec<SearchPackage>,
}
#[derive(serde::Deserialize)]
struct SearchPackage {
    id: String,
    #[serde(default, rename = "latestVersion")]
    latest_version: String,
    #[serde(default, rename = "totalDownloads")]
    total_downloads: Option<u64>,
    #[serde(default)]
    owners: Option<String>,
}

/// A nuget.org search hit.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NugetSearchHit {
    pub id: String,
    pub latest_version: String,
    pub total_downloads: Option<u64>,
    pub owners: Option<String>,
}

/// Parses `dotnet package search … --format json` into hits (all sources merged).
pub(crate) fn parse_nuget_search(json: &str) -> Result<Vec<NugetSearchHit>, String> {
    let parsed: SearchJson = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for src in parsed.search_result {
        for p in src.packages {
            out.push(NugetSearchHit {
                id: p.id,
                latest_version: p.latest_version,
                total_downloads: p.total_downloads,
                owners: p.owners,
            });
        }
    }
    Ok(out)
}

/// Runs a `dotnet` command capturing stdout, forcing English + no window. Returns
/// stdout on success, or an error with the output tail on failure.
async fn dotnet_capture(args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = dotnet_command()
            .args(&args)
            .output()
            .map_err(|e| format!("Não foi possível executar o dotnet (o .NET SDK está instalado?): {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let msg = if !stderr.trim().is_empty() { stderr.into_owned() } else { stdout };
            return Err(tail(&msg, 800));
        }
        Ok(stdout)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lists installed NuGet packages of `csproj_path`, including the newest
/// available version (via a second `--outdated` pass merged in).
#[tauri::command]
pub async fn nuget_list(csproj_path: String) -> Result<Vec<NugetPackage>, String> {
    let installed = dotnet_capture(vec![
        "list".into(), csproj_path.clone(), "package".into(), "--format".into(), "json".into(),
    ])
    .await?;
    let mut packages = parse_nuget_list(&installed)?;

    // Best-effort `--outdated` overlay (needs network/restore; failure is fine).
    if let Ok(outdated) = dotnet_capture(vec![
        "list".into(), csproj_path, "package".into(), "--outdated".into(), "--format".into(), "json".into(),
    ])
    .await
    {
        if let Ok(od) = parse_nuget_list(&outdated) {
            for p in &mut packages {
                if let Some(hit) = od.iter().find(|o| o.id == p.id) {
                    p.latest_version = hit.latest_version.clone();
                }
            }
        }
    }
    Ok(packages)
}

/// Searches nuget.org for `query`.
#[tauri::command]
pub async fn nuget_search(query: String) -> Result<Vec<NugetSearchHit>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let json = dotnet_capture(vec![
        "package".into(), "search".into(), query, "--take".into(), "20".into(),
        "--format".into(), "json".into(),
    ])
    .await?;
    parse_nuget_search(&json)
}

/// Adds (or updates, when `version` is set) a package on `csproj_path`.
#[tauri::command]
pub async fn nuget_add(
    csproj_path: String,
    package_id: String,
    version: Option<String>,
) -> Result<DotnetActionResult, String> {
    let mut extra = vec!["package".to_string(), package_id];
    if let Some(v) = version.filter(|v| !v.is_empty()) {
        extra.push("--version".to_string());
        extra.push(v);
    }
    run_dotnet_action_opts("add", csproj_path, extra, false).await
}

/// Removes a package from `csproj_path`.
#[tauri::command]
pub async fn nuget_remove(
    csproj_path: String,
    package_id: String,
) -> Result<DotnetActionResult, String> {
    run_dotnet_action_opts("remove", csproj_path, vec!["package".to_string(), package_id], false).await
}

// ── Templates (`dotnet new`) ────────────────────────────────────────────────
//
// `dotnet new list` has no JSON output, so we parse its fixed-width table using
// the `---` separator row to find column spans (resilient to spaces inside
// values). Creating a project is `dotnet new <shortName> -n <name> -o <dir>`.

/// A `dotnet new` template.
#[derive(serde::Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DotnetTemplate {
    pub name: String,
    /// The short name passed to `dotnet new` (e.g. "mvc"); first when comma-listed.
    pub short_name: String,
    pub tags: String,
}

/// Parses `dotnet new list` output. Uses the `---` separator row to compute each
/// column's character span, then slices every data row by those spans. Columns:
/// Template Name | Short Name | Language | Tags. Returns [] if the table is absent.
pub(crate) fn parse_template_list(stdout: &str) -> Vec<DotnetTemplate> {
    let lines: Vec<&str> = stdout.lines().collect();
    // Find the separator row: starts with '-' and is all '-'/space.
    let sep_idx = lines.iter().position(|l| {
        let t = l.trim();
        !t.is_empty() && t.starts_with('-') && l.chars().all(|c| c == '-' || c == ' ')
    });
    let Some(sep_idx) = sep_idx else { return Vec::new() };
    // Column spans = [start, end) of each run of '-' in the separator.
    let sep = lines[sep_idx];
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let bytes: Vec<char> = sep.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '-' {
            let start = i;
            while i < bytes.len() && bytes[i] == '-' {
                i += 1;
            }
            spans.push((start, i));
        } else {
            i += 1;
        }
    }
    if spans.len() < 4 {
        return Vec::new();
    }
    let slice = |chars: &[char], (s, e): (usize, usize)| -> String {
        // The last column extends to end-of-line; others stop at their span end.
        let end = e.min(chars.len()).max(s.min(chars.len()));
        chars.get(s..end).map(|c| c.iter().collect::<String>()).unwrap_or_default().trim().to_string()
    };
    let mut out = Vec::new();
    for line in &lines[sep_idx + 1..] {
        if line.trim().is_empty() {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let name = slice(&chars, spans[0]);
        let short_full = slice(&chars, spans[1]);
        // Tags column runs to end of line (values can be long).
        let tags = chars.get(spans[3].0..).map(|c| c.iter().collect::<String>()).unwrap_or_default().trim().to_string();
        if name.is_empty() || short_full.is_empty() {
            continue;
        }
        // Short name may be comma-listed ("webapp,razor"); take the first.
        let short_name = short_full.split(',').next().unwrap_or(&short_full).trim().to_string();
        out.push(DotnetTemplate { name, short_name, tags });
    }
    out
}

/// Lists installed `dotnet new` templates.
#[tauri::command]
pub async fn dotnet_new_list() -> Result<Vec<DotnetTemplate>, String> {
    let stdout = dotnet_capture(vec!["new".into(), "list".into()]).await?;
    Ok(parse_template_list(&stdout))
}

/// Creates a project from `template` (short name) named `name` under `output_dir`.
#[tauri::command]
pub async fn dotnet_new_create(
    template: String,
    name: String,
    output_dir: String,
) -> Result<DotnetActionResult, String> {
    // `dotnet new <tpl> -n <name> -o <dir>` — no target/-nologo.
    run_dotnet_action_opts(
        "new",
        String::new(),
        vec![template, "-n".into(), name, "-o".into(), output_dir],
        false,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_target_is_valid() {
        assert!(is_valid_dotnet_target("/repo", ""));
    }

    #[test]
    fn csproj_and_sln_under_root_are_valid() {
        assert!(is_valid_dotnet_target("/repo", "/repo/App/App.csproj"));
        assert!(is_valid_dotnet_target("/repo", "/repo/App.sln"));
        assert!(is_valid_dotnet_target("/repo", "/repo/App.slnx"));
    }

    #[test]
    fn non_project_extension_is_rejected() {
        assert!(!is_valid_dotnet_target("/repo", "/repo/App/Program.cs"));
        assert!(!is_valid_dotnet_target("/repo", "/etc/passwd"));
    }

    #[test]
    fn tail_keeps_the_end() {
        assert_eq!(tail("abcdef", 3), "def");
        assert_eq!(tail("ab", 5), "ab");
    }

    // JSON captured from `dotnet list package --format json` (SDK 10).
    const LIST_JSON: &str = r#"{
      "version": 1, "parameters": "",
      "projects": [{ "path": "/x/App.csproj", "frameworks": [{
        "framework": "net8.0",
        "topLevelPackages": [
          { "id": "Microsoft.CodeAnalysis.CSharp", "requestedVersion": "5.6.0", "resolvedVersion": "5.6.0" },
          { "id": "System.Text.Json", "requestedVersion": "8.0.5", "resolvedVersion": "8.0.5", "latestVersion": "10.0.9" }
        ]
      }] }]
    }"#;

    #[test]
    fn parses_installed_packages() {
        let pkgs = parse_nuget_list(LIST_JSON).unwrap();
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[0].id, "Microsoft.CodeAnalysis.CSharp");
        assert_eq!(pkgs[0].resolved_version, "5.6.0");
        assert_eq!(pkgs[0].latest_version, None);
        assert_eq!(pkgs[1].latest_version.as_deref(), Some("10.0.9"));
    }

    #[test]
    fn dedups_packages_across_frameworks() {
        let multi = r#"{ "projects": [{ "frameworks": [
          { "framework": "net8.0", "topLevelPackages": [{ "id": "A", "resolvedVersion": "1.0" }] },
          { "framework": "net9.0", "topLevelPackages": [{ "id": "A", "resolvedVersion": "1.0" }] }
        ] }] }"#;
        assert_eq!(parse_nuget_list(multi).unwrap().len(), 1);
    }

    #[test]
    fn empty_list_yields_no_packages() {
        let empty = r#"{ "projects": [{ "frameworks": [{ "framework": "net8.0", "topLevelPackages": [] }] }] }"#;
        assert!(parse_nuget_list(empty).unwrap().is_empty());
    }

    #[test]
    fn parses_template_list_by_separator_spans() {
        let out = "These templates matched your input: \n\n\
Template Name                                 Short Name                    Language    Tags                              \n\
--------------------------------------------  ----------------------------  ----------  ----------------------------------\n\
ASP.NET Core Web App (Model-View-Controller)  mvc                           [C#],F#     Web/MVC                           \n\
ASP.NET Core Web App (Razor Pages)            webapp,razor                  [C#]        Web/MVC/Razor Pages               \n\
Class Library                                 classlib                      [C#],F#,VB  Common/Library                    \n";
        let t = parse_template_list(out);
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].name, "ASP.NET Core Web App (Model-View-Controller)");
        assert_eq!(t[0].short_name, "mvc");
        assert_eq!(t[0].tags, "Web/MVC");
        // Comma-listed short name → first token.
        assert_eq!(t[1].short_name, "webapp");
        assert_eq!(t[2].short_name, "classlib");
    }

    #[test]
    fn template_list_without_table_is_empty() {
        assert!(parse_template_list("No templates found.").is_empty());
    }

    #[test]
    fn parses_search_results() {
        let json = r#"{ "version": 2, "problems": [], "searchResult": [
          { "sourceName": "nuget.org", "packages": [
            { "id": "Newtonsoft.Json", "latestVersion": "13.0.4", "totalDownloads": 8649619643, "owners": "jamesnk" },
            { "id": "Newtonsoft.Json.Bson", "latestVersion": "1.0.3", "totalDownloads": 1324398050 }
          ] }
        ] }"#;
        let hits = parse_nuget_search(json).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "Newtonsoft.Json");
        assert_eq!(hits[0].latest_version, "13.0.4");
        assert_eq!(hits[0].owners.as_deref(), Some("jamesnk"));
        assert_eq!(hits[1].owners, None);
    }
}
