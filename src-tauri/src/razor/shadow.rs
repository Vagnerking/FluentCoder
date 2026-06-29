//! Shadow project generation for the projection broker (Option B / ADR 0002).
//!
//! The "shadow" is a plain-SDK C# project that lets the standard Roslyn C# LSP
//! analyze the Razor-projected `.g.cs` with the user project's types in scope. It:
//!   - `ProjectReference`s the user's `.csproj` (resolves their types from source);
//!   - declares the framework reference(s) the user project uses — these are NOT
//!     inherited transitively across `ProjectReference` for compilation, so the
//!     shadow must declare them itself (empirically: without
//!     `Microsoft.AspNetCore.App` the projection fails with CS0234 on
//!     `Microsoft.AspNetCore`);
//!   - compiles the projected `.g.cs` files (default SDK glob under the shadow dir);
//!   - uses the plain `Microsoft.NET.Sdk` (NOT the Razor SDK) so it does not
//!     re-run the Razor generator and duplicate the generated class.
//!
//! Loaded together with the user project in ONE Roslyn workspace (`solution/open`)
//! — never `dotnet build`, which would block on the user project's own errors.
//! Validated end-to-end by `tools/razor-lsp-probe/spike-b1c.mjs` (hover →
//! `string WeatherModel.City { get; set; }`, definition → `WeatherModel.cs`,
//! diagnostics → the real `CS1061`).

/// Inputs for rendering a shadow `.csproj`.
pub struct ShadowSpec<'a> {
    /// e.g. `"net8.0"` — must match the user project's TFM.
    pub target_framework: &'a str,
    /// Path to the user `.csproj`, relative to the shadow project directory
    /// (e.g. `"..\\App\\App.csproj"`). MSBuild accepts `\\` or `/`.
    pub user_csproj_rel: &'a str,
    /// Framework references the user project relies on (e.g.
    /// `["Microsoft.AspNetCore.App"]`). Not inherited via ProjectReference.
    pub framework_references: &'a [&'a str],
    /// Optional root namespace (match the user project's so projected `using`s line up).
    pub root_namespace: Option<&'a str>,
}

/// Render the shadow `.csproj` XML. Pure string building (no IO).
pub fn render_shadow_csproj(spec: &ShadowSpec) -> String {
    let mut s = String::new();
    s.push_str("<!-- AUTO-GENERATED shadow project for Razor projection (ADR 0002).\n");
    s.push_str("     Loaded in a Roslyn workspace alongside the user project; never dotnet-built. -->\n");
    s.push_str("<Project Sdk=\"Microsoft.NET.Sdk\">\n\n");
    s.push_str("  <PropertyGroup>\n");
    s.push_str(&format!("    <TargetFramework>{}</TargetFramework>\n", esc(spec.target_framework)));
    s.push_str("    <Nullable>enable</Nullable>\n");
    s.push_str("    <ImplicitUsings>enable</ImplicitUsings>\n");
    s.push_str("    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>\n");
    // Defensive: ensure the Razor SDK never activates here even if a Directory.Build
    // import tries to turn it on.
    s.push_str("    <EnableDefaultContentItems>false</EnableDefaultContentItems>\n");
    if let Some(ns) = spec.root_namespace {
        s.push_str(&format!("    <RootNamespace>{}</RootNamespace>\n", esc(ns)));
    }
    s.push_str("  </PropertyGroup>\n\n");
    s.push_str("  <ItemGroup>\n");
    // Reference the user project for its TYPES, but suppress its Razor page
    // generation across the reference. A `Microsoft.NET.Sdk.Web` user project
    // emits its own `Views_*` page classes (`AspNetCoreGeneratedDocument.*`);
    // the shadow ALSO compiles the same class from the projected `.g.cs`, so
    // without this the Roslyn workspace sees the type defined twice and floods
    // with CS0101/CS0111/CS0229/CS0579 — which suppress the real user
    // diagnostic (e.g. the CS1061 never surfaces). The `Properties` metadata
    // sets MSBuild global properties for the referenced project's evaluation,
    // turning its Razor source generation off so only the shadow's projected
    // `.g.cs` defines the page class. (A newer .NET SDK reintroduced the
    // duplication that made `.cshtml` diagnostics vanish.)
    let suppress_razor = [
        "EnableDefaultRazorGenerateItems=false",
        "GenerateRazorAssemblyInfo=false",
        "RazorCompileOnBuild=false",
        "IncludeRazorContentInPack=false",
        "EnableDefaultRazorComponentItems=false",
    ]
    .join("%3B"); // MSBuild-escaped ';' inside the Properties attribute value
    s.push_str(&format!(
        "    <ProjectReference Include=\"{}\" Properties=\"{}\" />\n",
        esc(spec.user_csproj_rel),
        suppress_razor
    ));
    for fr in spec.framework_references {
        s.push_str(&format!("    <FrameworkReference Include=\"{}\" />\n", esc(fr)));
    }
    s.push_str("  </ItemGroup>\n\n");
    s.push_str("</Project>\n");
    s
}

/// Minimal XML attribute escaping for the values we emit (paths, identifiers).
fn esc(v: &str) -> String {
    v.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ShadowSpec<'static> {
        ShadowSpec {
            target_framework: "net8.0",
            user_csproj_rel: "..\\SampleMvc\\SampleMvc.csproj",
            framework_references: &["Microsoft.AspNetCore.App"],
            root_namespace: Some("SampleMvc"),
        }
    }

    #[test]
    fn uses_plain_sdk_not_razor() {
        let xml = render_shadow_csproj(&spec());
        assert!(xml.contains("Sdk=\"Microsoft.NET.Sdk\""));
        assert!(!xml.contains("Microsoft.NET.Sdk.Web"));
        assert!(!xml.contains("Microsoft.NET.Sdk.Razor"));
    }

    #[test]
    fn references_user_project_and_framework() {
        let xml = render_shadow_csproj(&spec());
        // The reference now carries Razor-suppression Properties (see below), so
        // assert on the Include plus the opening tag rather than a bare self-close.
        assert!(xml.contains("<ProjectReference Include=\"..\\SampleMvc\\SampleMvc.csproj\""));
        assert!(xml.contains("<FrameworkReference Include=\"Microsoft.AspNetCore.App\" />"));
    }

    #[test]
    fn suppresses_razor_generation_on_user_reference() {
        // Without this, a Web-SDK user project emits its own Views_* page classes
        // AND the shadow compiles the same class from the projected .g.cs → the
        // type is defined twice (CS0101/CS0111/CS0229), which suppresses the real
        // user diagnostic. The reference must turn the user's Razor generation off.
        let xml = render_shadow_csproj(&spec());
        assert!(
            xml.contains("EnableDefaultRazorGenerateItems=false"),
            "ProjectReference must disable the user project's Razor generation"
        );
        assert!(xml.contains("RazorCompileOnBuild=false"));
        // `;` separators must be MSBuild-escaped inside the attribute value.
        assert!(xml.contains("%3B"));
    }

    #[test]
    fn carries_tfm_and_namespace() {
        let xml = render_shadow_csproj(&spec());
        assert!(xml.contains("<TargetFramework>net8.0</TargetFramework>"));
        assert!(xml.contains("<RootNamespace>SampleMvc</RootNamespace>"));
    }

    #[test]
    fn multiple_framework_references() {
        let s = ShadowSpec {
            framework_references: &["Microsoft.AspNetCore.App", "Microsoft.WindowsDesktop.App"],
            ..spec()
        };
        let xml = render_shadow_csproj(&s);
        assert_eq!(xml.matches("<FrameworkReference").count(), 2);
    }

    #[test]
    fn escapes_xml_special_chars_in_paths() {
        let s = ShadowSpec {
            user_csproj_rel: "..\\A & B\\<x>.csproj",
            ..spec()
        };
        let xml = render_shadow_csproj(&s);
        assert!(xml.contains("..\\A &amp; B\\&lt;x&gt;.csproj"));
        assert!(!xml.contains("A & B")); // raw ampersand must not leak
    }

    #[test]
    fn no_root_namespace_when_absent() {
        let s = ShadowSpec { root_namespace: None, ..spec() };
        let xml = render_shadow_csproj(&s);
        assert!(!xml.contains("<RootNamespace>"));
    }
}
