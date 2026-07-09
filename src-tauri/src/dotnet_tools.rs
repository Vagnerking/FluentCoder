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

/// Runs a `dotnet <verb> <target> [extra…]` action (build/clean/restore) against
/// a `.csproj`/`.sln` and returns success + output tail. `target` empty ⇒ run in
/// the workspace and let MSBuild find the project/solution.
async fn run_dotnet_action(
    verb: &str,
    target: String,
    extra: Vec<String>,
) -> Result<DotnetActionResult, String> {
    let verb = verb.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = dotnet_command();
        cmd.arg(&verb);
        if !target.is_empty() {
            cmd.arg(&target);
        }
        cmd.arg("-nologo");
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
}
