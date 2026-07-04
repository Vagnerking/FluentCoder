//! Derive the shadow project's inputs (TFM + framework references) from the
//! user's `.csproj` (ADR 0002, brick 5 support).
//!
//! Uses `dotnet build <csproj> --getProperty:TargetFramework
//! --getItem:FrameworkReference`, which evaluates MSBuild and prints JSON. The
//! framework references are needed because they are NOT inherited transitively
//! across the shadow's `ProjectReference` (see `shadow.rs`): e.g. an MVC project
//! reports `Microsoft.AspNetCore.App`, which the shadow must declare to resolve
//! `RazorPage<T>` etc.
//!
//! This module keeps the **JSON parsing pure/unit-tested** and constructs the
//! **command**; running it is the execution layer (brick 5).

use serde_json::Value;

/// The implicit base framework present in every SDK project; the shadow gets it
/// for free, so we don't re-declare it.
const IMPLICIT_BASE: &str = "Microsoft.NETCore.App";

/// What the shadow needs from the user project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedRefs {
    pub tfm: String,
    /// Meaningful framework references to declare in the shadow (base excluded).
    pub framework_references: Vec<String>,
    /// Absolute paths of the project's COMPILE references (the resolved DLLs the
    /// live sidecar's `CSharpCompilation` needs — TagHelper discovery + base types
    /// come from these). Empty when the resolve target wasn't run/available.
    pub reference_paths: Vec<String>,
    /// The project's `RootNamespace` (drives the generated namespace/usings).
    pub root_namespace: Option<String>,
    /// True for `Microsoft.NET.Sdk.Web` projects — selects the MVC/Web Razor
    /// configuration the generator emits (vs Blazor components).
    pub using_microsoft_net_sdk_web: bool,
    /// `RazorLangVersion` (e.g. `8.0`); empty → caller defaults from the TFM.
    pub razor_lang_version: String,
    /// True when `tfm` was picked from `TargetFrameworks` (multi-targeting) rather
    /// than a singular `TargetFramework`. In that case the first eval couldn't
    /// resolve `ReferencePath` (no active TFM), so the runtime re-derives with
    /// `-f <tfm>` to get the real references.
    pub multi_target_selected: bool,
}

/// Build the `dotnet` command that prints, in one MSBuild eval, the user
/// project's TFM + framework refs + resolved compile references + the editorconfig
/// globals the Razor generator reads. `-t:ResolveAssemblyReferences` makes
/// MSBuild populate `ReferencePath` (the actual DLLs) which `--getItem` then dumps.
///
/// This is a DESIGN-TIME query, never a build: `-p:BuildProjectReferences=false`
/// resolves ProjectReference outputs via `GetTargetPath` (their would-be DLL paths)
/// WITHOUT compiling them, and `--no-restore` skips the NuGet walk of the whole
/// graph. Validated on a 24-project monorepo: identical `ReferencePath` output to
/// the building variant (all ProjectReference DLLs included), ~4.6s vs minutes.
/// The DLLs may not exist on disk if the user never built — callers must check
/// existence and degrade loudly, not silently.
pub fn derive_command(csproj_path: &str) -> (String, Vec<String>) {
    derive_command_for_tfm(csproj_path, None)
}

/// [`derive_command`] optionally pinned to one `target_framework` via `-f`. A
/// multi-targeting project leaves `TargetFramework` empty until a TFM is selected,
/// so the resolve target can't populate `ReferencePath`; re-running with `-f <tfm>`
/// evaluates the project AS that single framework and resolves its references.
pub fn derive_command_for_tfm(csproj_path: &str, target_framework: Option<&str>) -> (String, Vec<String>) {
    derive_command_inner(csproj_path, target_framework, true)
}

/// [`derive_command_for_tfm`] WITH the implicit NuGet restore enabled. Only for
/// the one-shot retry when the no-restore eval failed because the project was
/// never restored on this machine (missing `project.assets.json`). O(NuGet graph),
/// so never on the steady-state path.
pub fn derive_command_with_restore(csproj_path: &str, target_framework: Option<&str>) -> (String, Vec<String>) {
    derive_command_inner(csproj_path, target_framework, false)
}

fn derive_command_inner(
    csproj_path: &str,
    target_framework: Option<&str>,
    no_restore: bool,
) -> (String, Vec<String>) {
    let mut args = vec![
        "build".to_string(),
        csproj_path.to_string(),
        "-t:ResolveAssemblyReferences".to_string(),
        "--getProperty:TargetFramework".to_string(),
        "--getProperty:TargetFrameworks".to_string(),
        "--getProperty:RootNamespace".to_string(),
        "--getProperty:UsingMicrosoftNETSdkWeb".to_string(),
        "--getProperty:RazorLangVersion".to_string(),
        "--getItem:FrameworkReference".to_string(),
        "--getItem:ReferencePath".to_string(),
        // Design-time: resolve ProjectReference DLL paths without building them.
        "-p:BuildProjectReferences=false".to_string(),
        "-p:DesignTimeBuild=true".to_string(),
        "-p:SkipCompilerExecution=true".to_string(),
        "-v:quiet".to_string(),
        "-nologo".to_string(),
    ];
    if no_restore {
        args.push("--no-restore".to_string());
    }
    if let Some(tfm) = target_framework {
        // Insert right after the csproj so `-f` applies to the build evaluation.
        args.insert(2, "-f".to_string());
        args.insert(3, tfm.to_string());
    }
    ("dotnet".to_string(), args)
}

/// Pick the TFM the editor should analyze as, from a `TargetFrameworks` list.
/// Prefers the HIGHEST modern `net<major>.<minor>` (e.g. `net8.0` over `net6.0`),
/// because that is what the dev tooling ecosystem targets; classic monikers
/// (`net48`, `netstandard2.0`) only win when no modern TFM exists — picking
/// "the first entry" made `net48;net8.0` analyze as .NET Framework 4.8.
pub fn pick_tfm(list: &str) -> Option<String> {
    let entries: Vec<&str> = list.split(';').map(str::trim).filter(|s| !s.is_empty()).collect();
    let modern_version = |tfm: &str| -> Option<(u32, u32)> {
        // Modern SDK monikers: netN.M optionally with a platform suffix
        // (net8.0-windows). Classic ones (net48) have no dot; netstandard/
        // netcoreapp are not "net<digit>".
        let rest = tfm.strip_prefix("net")?;
        let core = rest.split('-').next().unwrap_or(rest);
        let (maj, min) = core.split_once('.')?;
        Some((maj.parse().ok()?, min.parse().ok()?))
    };
    entries
        .iter()
        .filter_map(|t| modern_version(t).map(|v| (v, *t)))
        .max_by_key(|(v, _)| *v)
        .map(|(_, t)| t.to_string())
        .or_else(|| entries.first().map(|s| s.to_string()))
}

/// Parse the JSON printed by [`derive_command`]. For a multi-targeting project
/// (`TargetFramework` empty, `TargetFrameworks` set) it picks the FIRST listed TFM
/// and flags `multi_target_selected` so the runtime can re-derive with `-f <tfm>`
/// to resolve that framework's references. Returns `None` only when neither
/// property yields a usable TFM.
pub fn parse_derived(json: &str) -> Option<DerivedRefs> {
    let v: Value = serde_json::from_str(json).ok()?;
    let props = v.get("Properties")?;
    let read_prop = |name: &str| -> String {
        props
            .get(name)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let single_tfm = read_prop("TargetFramework");
    let (tfm, multi_target_selected) = if !single_tfm.is_empty() {
        (single_tfm, false)
    } else {
        // Multi-targeting: `TargetFrameworks` is a `;`-separated list. Pick the
        // best analysis TFM (highest modern `netN.M`; see [`pick_tfm`]).
        match pick_tfm(&read_prop("TargetFrameworks")) {
            Some(t) => (t, true),
            None => return None,
        }
    };
    let mut framework_references = Vec::new();
    if let Some(arr) = v
        .get("Items")
        .and_then(|i| i.get("FrameworkReference"))
        .and_then(|f| f.as_array())
    {
        for item in arr {
            if let Some(id) = item.get("Identity").and_then(|i| i.as_str()) {
                if id != IMPLICIT_BASE && !framework_references.iter().any(|x| x == id) {
                    framework_references.push(id.to_string());
                }
            }
        }
    }

    // Resolved compile references (absolute DLL paths) for the live sidecar's
    // Compilation. Prefer `FullPath`; fall back to `Identity` (already absolute
    // for ReferencePath). Dedup, keep absolute-looking paths only.
    let mut reference_paths = Vec::new();
    if let Some(arr) = v
        .get("Items")
        .and_then(|i| i.get("ReferencePath"))
        .and_then(|f| f.as_array())
    {
        for item in arr {
            let p = item
                .get("FullPath")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| item.get("Identity").and_then(|x| x.as_str()))
                .unwrap_or("");
            if !p.is_empty() && !reference_paths.iter().any(|x| x == p) {
                reference_paths.push(p.to_string());
            }
        }
    }

    let prop = |name: &str| -> Option<String> {
        v.get("Properties")
            .and_then(|p| p.get(name))
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let root_namespace = prop("RootNamespace");
    let using_microsoft_net_sdk_web = prop("UsingMicrosoftNETSdkWeb")
        .map(|s| s.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let razor_lang_version = prop("RazorLangVersion").unwrap_or_default();

    Some(DerivedRefs {
        tfm,
        framework_references,
        reference_paths,
        root_namespace,
        using_microsoft_net_sdk_web,
        razor_lang_version,
        multi_target_selected,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed from the REAL `dotnet build -t:ResolveAssemblyReferences
    // --getProperty/--getItem` output for the SampleMvc fixture (Web SDK, net8.0).
    const REAL: &str = r#"{
      "Properties": {
        "TargetFramework": "net8.0",
        "RootNamespace": "SampleMvc",
        "UsingMicrosoftNETSdkWeb": "true",
        "RazorLangVersion": "8.0"
      },
      "Items": {
        "FrameworkReference": [
          { "Identity": "Microsoft.NETCore.App", "IsImplicitlyDefined": "true" },
          { "Identity": "Microsoft.AspNetCore.App", "IsImplicitlyDefined": "true" }
        ],
        "ReferencePath": [
          { "Identity": "C:/refs/Microsoft.AspNetCore.Mvc.dll", "FullPath": "C:/refs/Microsoft.AspNetCore.Mvc.dll" },
          { "Identity": "C:/refs/Microsoft.AspNetCore.Mvc.TagHelpers.dll", "FullPath": "C:/refs/Microsoft.AspNetCore.Mvc.TagHelpers.dll" },
          { "Identity": "dup", "FullPath": "C:/refs/Microsoft.AspNetCore.Mvc.dll" }
        ]
      }
    }"#;

    #[test]
    fn derives_tfm_and_aspnetcore_excluding_base() {
        let d = parse_derived(REAL).unwrap();
        assert_eq!(d.tfm, "net8.0");
        // base excluded; the meaningful web framework kept
        assert_eq!(d.framework_references, vec!["Microsoft.AspNetCore.App"]);
    }

    #[test]
    fn derives_reference_paths_and_globals() {
        let d = parse_derived(REAL).unwrap();
        assert_eq!(d.root_namespace.as_deref(), Some("SampleMvc"));
        assert!(d.using_microsoft_net_sdk_web);
        assert_eq!(d.razor_lang_version, "8.0");
        // FullPath used, dedup'd (the "dup" entry collapses into the first).
        assert_eq!(
            d.reference_paths,
            vec![
                "C:/refs/Microsoft.AspNetCore.Mvc.dll",
                "C:/refs/Microsoft.AspNetCore.Mvc.TagHelpers.dll",
            ]
        );
    }

    #[test]
    fn multi_target_picks_best_tfm_and_flags_it() {
        // Multi-targeting: empty singular, `;`-separated plural → pick the highest
        // MODERN TFM (not merely the first entry).
        let json = r#"{ "Properties": { "TargetFramework": "", "TargetFrameworks": "net8.0;net9.0" },
          "Items": {} }"#;
        let d = parse_derived(json).expect("should select a TFM");
        assert_eq!(d.tfm, "net9.0");
        assert!(d.multi_target_selected, "must flag the multi-target selection");
    }

    #[test]
    fn pick_tfm_prefers_modern_over_classic_and_highest() {
        // The real-world trap: `net48;net8.0` must analyze as net8.0, not net48.
        assert_eq!(pick_tfm("net48;net8.0").as_deref(), Some("net8.0"));
        assert_eq!(pick_tfm("net8.0;net48").as_deref(), Some("net8.0"));
        assert_eq!(pick_tfm("net6.0;net8.0;net7.0").as_deref(), Some("net8.0"));
        // Platform suffix still parses as modern.
        assert_eq!(pick_tfm("net48;net8.0-windows").as_deref(), Some("net8.0-windows"));
        // No modern TFM → first entry.
        assert_eq!(pick_tfm("net48;netstandard2.0").as_deref(), Some("net48"));
        assert_eq!(pick_tfm(" ; "), None);
    }

    #[test]
    fn derive_command_is_design_time_no_restore() {
        let (_, args) = derive_command("C:/p/App.csproj");
        assert!(args.iter().any(|a| a == "--no-restore"));
        assert!(args.iter().any(|a| a == "-p:BuildProjectReferences=false"));
        assert!(args.iter().any(|a| a == "-p:DesignTimeBuild=true"));
        // The restore-retry variant drops ONLY --no-restore (still design-time).
        let (_, retry) = derive_command_with_restore("C:/p/App.csproj", None);
        assert!(!retry.iter().any(|a| a == "--no-restore"));
        assert!(retry.iter().any(|a| a == "-p:BuildProjectReferences=false"));
    }

    #[test]
    fn single_target_is_not_flagged_multi() {
        let d = parse_derived(REAL).unwrap();
        assert!(!d.multi_target_selected);
    }

    #[test]
    fn no_tfm_at_all_is_none() {
        // Neither property usable → genuinely cannot derive.
        let json = r#"{ "Properties": { "TargetFramework": "", "TargetFrameworks": "" }, "Items": {} }"#;
        assert_eq!(parse_derived(json), None);
        let json2 = r#"{ "Properties": { "TargetFramework": "" }, "Items": {} }"#;
        assert_eq!(parse_derived(json2), None);
    }

    #[test]
    fn derive_command_for_tfm_injects_f_flag() {
        let (_, args) = derive_command_for_tfm("C:/p/App.csproj", Some("net9.0"));
        let fi = args.iter().position(|a| a == "-f").expect("-f present");
        assert_eq!(args[fi + 1], "net9.0");
        // Plain command has no `-f`.
        let (_, plain) = derive_command("C:/p/App.csproj");
        assert!(!plain.iter().any(|a| a == "-f"));
        // Both query TargetFrameworks now.
        assert!(plain.iter().any(|a| a == "--getProperty:TargetFrameworks"));
    }

    #[test]
    fn plain_lib_has_no_extra_framework_refs() {
        let json = r#"{ "Properties": { "TargetFramework": "net8.0" },
          "Items": { "FrameworkReference": [ { "Identity": "Microsoft.NETCore.App" } ] } }"#;
        let d = parse_derived(json).unwrap();
        assert_eq!(d.tfm, "net8.0");
        assert!(d.framework_references.is_empty());
        assert!(d.reference_paths.is_empty());
        assert!(!d.using_microsoft_net_sdk_web);
        assert_eq!(d.root_namespace, None);
    }

    #[test]
    fn dedupes_and_keeps_non_base() {
        let json = r#"{ "Properties": { "TargetFramework": "net9.0" },
          "Items": { "FrameworkReference": [
            { "Identity": "Microsoft.AspNetCore.App" },
            { "Identity": "Microsoft.AspNetCore.App" },
            { "Identity": "Microsoft.WindowsDesktop.App" }
          ] } }"#;
        let d = parse_derived(json).unwrap();
        assert_eq!(d.framework_references, vec!["Microsoft.AspNetCore.App", "Microsoft.WindowsDesktop.App"]);
    }

    #[test]
    fn command_shape() {
        let (prog, args) = derive_command("C:/p/App.csproj");
        assert_eq!(prog, "dotnet");
        assert!(args.iter().any(|a| a == "--getItem:FrameworkReference"));
        assert!(args.iter().any(|a| a == "--getItem:ReferencePath"));
        assert!(args.iter().any(|a| a == "--getProperty:TargetFramework"));
        assert!(args.iter().any(|a| a == "--getProperty:RootNamespace"));
        assert!(args.iter().any(|a| a == "-t:ResolveAssemblyReferences"));
    }
}
