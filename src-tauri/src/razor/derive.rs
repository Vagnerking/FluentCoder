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
}

/// Build the `dotnet` command that prints, in one MSBuild eval, the user
/// project's TFM + framework refs + resolved compile references + the editorconfig
/// globals the Razor generator reads. `-t:ResolveAssemblyReferences` makes
/// MSBuild populate `ReferencePath` (the actual DLLs) which `--getItem` then dumps.
pub fn derive_command(csproj_path: &str) -> (String, Vec<String>) {
    (
        "dotnet".to_string(),
        vec![
            "build".to_string(),
            csproj_path.to_string(),
            "-t:ResolveAssemblyReferences".to_string(),
            "--getProperty:TargetFramework".to_string(),
            "--getProperty:RootNamespace".to_string(),
            "--getProperty:UsingMicrosoftNETSdkWeb".to_string(),
            "--getProperty:RazorLangVersion".to_string(),
            "--getItem:FrameworkReference".to_string(),
            "--getItem:ReferencePath".to_string(),
            "-v:quiet".to_string(),
            "-nologo".to_string(),
        ],
    )
}

/// Parse the JSON printed by [`derive_command`]. Returns `None` if the TFM is
/// absent/empty (e.g. a multi-targeting project where `TargetFramework` is empty
/// and `TargetFrameworks` is set — the caller must pick one and pass `-f`).
pub fn parse_derived(json: &str) -> Option<DerivedRefs> {
    let v: Value = serde_json::from_str(json).ok()?;
    let tfm = v
        .get("Properties")?
        .get("TargetFramework")?
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if tfm.is_empty() {
        return None;
    }
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
    fn multi_target_empty_tfm_is_none() {
        let json = r#"{ "Properties": { "TargetFramework": "" }, "Items": {} }"#;
        assert_eq!(parse_derived(json), None);
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
