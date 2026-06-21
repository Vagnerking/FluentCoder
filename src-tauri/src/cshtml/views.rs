/// Resolução de partials, layouts, sections e Tag Helpers para .cshtml (issue #45).
///
/// `ViewGraph`: grafo de dependências entre views (layouts, partials, sections).
/// `TagHelperIndex`: descobre Tag Helpers por convenção em source/metadata.
/// Resolução por convenção retorna múltiplos candidatos quando ambígua.
/// Mudanças em _ViewImports invalidam somente nós dependentes.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::semantics::SymbolIndex;

// ── Tipos básicos ─────────────────────────────────────────────────────────────

/// Resultado de uma resolução de view (pode ter múltiplos candidatos).
#[derive(Debug, Clone)]
pub enum ViewResolution {
    /// Arquivo encontrado de forma inequívoca.
    Resolved(PathBuf),
    /// Múltiplos candidatos (ambiguidade por convenção).
    Ambiguous(Vec<PathBuf>),
    /// Não encontrado no projeto.
    NotFound,
}

/// Uma section declarada em um layout.
#[derive(Debug, Clone)]
pub struct Section {
    pub name: String,
    pub required: bool,
    /// View que declara a section (pode ser o próprio layout).
    pub declared_in: PathBuf,
}

// ── ViewGraph ─────────────────────────────────────────────────────────────────

/// Nó do grafo de views.
#[derive(Debug, Clone)]
pub struct ViewNode {
    pub path: PathBuf,
    pub layout: Option<PathBuf>,
    pub partials: Vec<PathBuf>,
    pub sections_rendered: Vec<String>,
    pub sections_provided: Vec<String>,
}

/// Grafo de dependências entre views — separado do parser e do índice C#.
#[derive(Debug, Default)]
pub struct ViewGraph {
    nodes: HashMap<PathBuf, ViewNode>,
}

impl ViewGraph {
    pub fn new() -> Self { Self::default() }

    pub fn insert(&mut self, node: ViewNode) {
        self.nodes.insert(node.path.clone(), node);
    }

    pub fn get(&self, path: &Path) -> Option<&ViewNode> {
        self.nodes.get(path)
    }

    /// Remove o nó e todos os nós que dependem dele (por invalidação).
    pub fn invalidate(&mut self, path: &Path) {
        self.nodes.remove(path);
        let dependents: Vec<PathBuf> = self.nodes.values()
            .filter(|n| n.layout.as_deref() == Some(path) || n.partials.iter().any(|p| p == path))
            .map(|n| n.path.clone())
            .collect();
        for dep in dependents { self.nodes.remove(&dep); }
    }

    pub fn len(&self) -> usize { self.nodes.len() }
    pub fn is_empty(&self) -> bool { self.nodes.is_empty() }
}

// ── Resolução de partials ─────────────────────────────────────────────────────

/// Resolve uma referência a partial view.
///
/// Estratégias (em ordem):
/// 1. Caminho relativo ao arquivo corrente (`./Foo`, `../Shared/Foo`)
/// 2. Caminho relativo à raiz das views (`/Views/Shared/Foo`)
/// 3. Convenção ASP.NET Core: `Shared/Foo.cshtml`, mesma pasta
pub fn resolve_partial(
    reference: &str,
    current_view: &Path,
    project_root: &Path,
) -> ViewResolution {
    let reference = reference.trim().trim_matches('"').trim_matches('\'');
    let candidates = collect_partial_candidates(reference, current_view, project_root);

    let existing: Vec<_> = candidates.into_iter().filter(|p| p.exists()).collect();
    match existing.len() {
        0 => ViewResolution::NotFound,
        1 => ViewResolution::Resolved(existing.into_iter().next().unwrap()),
        _ => ViewResolution::Ambiguous(existing),
    }
}

fn collect_partial_candidates(reference: &str, current_view: &Path, project_root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let current_dir = current_view.parent().unwrap_or(current_view);

    // 1. Relative to current view
    if reference.starts_with('.') || reference.starts_with('/') {
        let base = if reference.starts_with('/') { project_root } else { current_dir };
        let clean = reference.trim_start_matches('/');
        let path = base.join(clean);
        candidates.push(try_extensions(path));
    } else {
        // 2. Same folder
        candidates.push(try_extensions(current_dir.join(reference)));
        // 3. Shared folder in Views
        let views_root = find_views_root(project_root);
        candidates.push(try_extensions(views_root.join("Shared").join(reference)));
        // 4. Under project root / Views
        candidates.push(try_extensions(project_root.join("Views").join("Shared").join(reference)));
        // 5. Pages/Shared (Razor Pages)
        candidates.push(try_extensions(project_root.join("Pages").join("Shared").join(reference)));
    }

    candidates
}

fn try_extensions(path: PathBuf) -> PathBuf {
    // If already has extension, keep it.
    if path.extension().is_some() { return path; }
    // Try .cshtml
    let with_ext = path.with_extension("cshtml");
    if with_ext.exists() { with_ext } else { path }
}

fn find_views_root(project_root: &Path) -> PathBuf {
    let views = project_root.join("Views");
    if views.exists() { views } else { project_root.to_path_buf() }
}

// ── Resolução de layouts ──────────────────────────────────────────────────────

/// Resolve o layout de uma view dada a string `@{ Layout = "..." }`.
pub fn resolve_layout(
    layout_ref: &str,
    current_view: &Path,
    project_root: &Path,
) -> ViewResolution {
    let layout_ref = layout_ref.trim().trim_matches('"').trim_matches('\'');
    if layout_ref == "null" || layout_ref == "~" { return ViewResolution::NotFound; }
    resolve_partial(layout_ref, current_view, project_root)
}

// ── Tag Helper Index ──────────────────────────────────────────────────────────

/// Um Tag Helper descoberto.
#[derive(Debug, Clone)]
pub struct TagHelperInfo {
    /// Nome do elemento (ex: "input", "form", "my-component").
    pub tag_name: String,
    /// FQN da classe Tag Helper.
    pub type_fqn: String,
    /// Atributos disponíveis (asp-for, asp-route-*, etc.)
    pub attributes: Vec<String>,
    /// Sumário de documentação.
    pub summary: String,
    /// true se for Tag Helper ASP.NET Core embutido.
    pub is_builtin: bool,
}

/// Índice de Tag Helpers — consome símbolos/metadata mas expõe modelo próprio.
#[derive(Debug, Default)]
pub struct TagHelperIndex {
    /// Keyed by tag name (lower-case).
    tag_helpers: HashMap<String, Vec<TagHelperInfo>>,
}

impl TagHelperIndex {
    pub fn new() -> Self { Self::default() }

    /// Registra os Tag Helpers embutidos do ASP.NET Core.
    pub fn register_builtins(&mut self) {
        let builtins: &[(&str, &str, &[&str])] = &[
            ("form",     "Microsoft.AspNetCore.Mvc.TagHelpers.FormTagHelper",
             &["asp-action", "asp-controller", "asp-area", "asp-route", "asp-antiforgery", "method"]),
            ("input",    "Microsoft.AspNetCore.Mvc.TagHelpers.InputTagHelper",
             &["asp-for", "asp-format"]),
            ("label",    "Microsoft.AspNetCore.Mvc.TagHelpers.LabelTagHelper",
             &["asp-for"]),
            ("select",   "Microsoft.AspNetCore.Mvc.TagHelpers.SelectTagHelper",
             &["asp-for", "asp-items"]),
            ("textarea", "Microsoft.AspNetCore.Mvc.TagHelpers.TextAreaTagHelper",
             &["asp-for"]),
            ("a",        "Microsoft.AspNetCore.Mvc.TagHelpers.AnchorTagHelper",
             &["asp-action", "asp-controller", "asp-area", "asp-route", "asp-fragment", "asp-host", "asp-protocol", "asp-page", "asp-page-handler"]),
            ("script",   "Microsoft.AspNetCore.Mvc.TagHelpers.ScriptTagHelper",
             &["asp-src-include", "asp-src-exclude", "asp-append-version", "asp-fallback-src", "asp-fallback-test"]),
            ("link",     "Microsoft.AspNetCore.Mvc.TagHelpers.LinkTagHelper",
             &["asp-href-include", "asp-href-exclude", "asp-append-version", "asp-fallback-href", "asp-fallback-test-class"]),
            ("img",      "Microsoft.AspNetCore.Mvc.TagHelpers.ImageTagHelper",
             &["asp-append-version"]),
            ("environment", "Microsoft.AspNetCore.Mvc.TagHelpers.EnvironmentTagHelper",
             &["include", "exclude", "names"]),
            ("cache",    "Microsoft.AspNetCore.Mvc.TagHelpers.CacheTagHelper",
             &["enabled", "expires-on", "expires-after", "expires-sliding", "vary-by-header", "vary-by-query", "vary-by-route", "vary-by-cookie", "vary-by-user", "vary-by", "priority"]),
            ("partial",  "Microsoft.AspNetCore.Mvc.TagHelpers.PartialTagHelper",
             &["name", "model", "for", "view-data"]),
            ("validation-summary", "Microsoft.AspNetCore.Mvc.TagHelpers.ValidationSummaryTagHelper",
             &["asp-validation-summary"]),
            ("validation-message", "Microsoft.AspNetCore.Mvc.TagHelpers.ValidationMessageTagHelper",
             &["asp-validation-for"]),
        ];

        for (tag, fqn, attrs) in builtins {
            self.tag_helpers.entry(tag.to_string()).or_default().push(TagHelperInfo {
                tag_name: tag.to_string(),
                type_fqn: fqn.to_string(),
                attributes: attrs.iter().map(|a| a.to_string()).collect(),
                summary: format!("ASP.NET Core Tag Helper: {}", fqn.rsplit('.').next().unwrap_or(fqn)),
                is_builtin: true,
            });
        }
    }

    /// Descobre Tag Helpers no `SymbolIndex` (source do projeto).
    pub fn discover_from_source(&mut self, index: &SymbolIndex) {
        // A Tag Helper class has "TagHelper" suffix or implements ITagHelper.
        for sym in index.all_symbols() {
            if sym.name.ends_with("TagHelper") {
                // Infer tag name by convention: FooBarTagHelper → foo-bar
                let class_name = sym.name.trim_end_matches("TagHelper");
                let tag_name = to_kebab_case(class_name);
                self.tag_helpers.entry(tag_name.clone()).or_default().push(TagHelperInfo {
                    tag_name,
                    type_fqn: sym.id.splitn(2, "::").nth(1).unwrap_or(&sym.name).to_string(),
                    attributes: vec![],
                    summary: format!("Tag Helper: {}", sym.name),
                    is_builtin: false,
                });
            }
        }
    }

    /// Lookup por tag name (case-insensitive).
    pub fn get(&self, tag: &str) -> Vec<&TagHelperInfo> {
        self.tag_helpers.get(&tag.to_lowercase())
            .map(|v| v.iter().collect())
            .unwrap_or_default()
    }

    /// Todos os Tag Helpers conhecidos.
    pub fn all(&self) -> impl Iterator<Item = &TagHelperInfo> {
        self.tag_helpers.values().flatten()
    }

    pub fn len(&self) -> usize { self.tag_helpers.len() }
}

/// Converte PascalCase para kebab-case (ex: "AnchorNew" → "anchor-new").
fn to_kebab_case(s: &str) -> String {
    let mut out = String::new();
    for (i, ch) in s.char_indices() {
        if ch.is_uppercase() && i > 0 { out.push('-'); }
        out.push(ch.to_ascii_lowercase());
    }
    out
}

// ── Processamento de @addTagHelper / @removeTagHelper ─────────────────────────

/// Estado de Tag Helpers depois de aplicar add/remove/prefix de um documento.
#[derive(Debug, Clone)]
pub struct TagHelperDirectiveSet {
    pub added: Vec<(String, String)>,   // (wildcard, assembly)
    pub removed: Vec<(String, String)>,
    pub prefix: Option<String>,
}

impl TagHelperDirectiveSet {
    pub fn new() -> Self {
        TagHelperDirectiveSet { added: vec![], removed: vec![], prefix: None }
    }

    /// Processa uma linha de diretiva.
    pub fn process_directive(&mut self, keyword: &str, arg: &str) {
        let arg = arg.trim().trim_matches('"').trim_matches('\'');
        match keyword {
            "addTagHelper" => {
                if let Some((wildcard, assembly)) = parse_tag_helper_spec(arg) {
                    self.added.push((wildcard, assembly));
                }
            }
            "removeTagHelper" => {
                if let Some((wildcard, assembly)) = parse_tag_helper_spec(arg) {
                    self.removed.push((wildcard, assembly));
                }
            }
            "tagHelperPrefix" => {
                self.prefix = Some(arg.to_string());
            }
            _ => {}
        }
    }

    /// Retorna true se o Tag Helper `fqn` está habilitado após add/remove.
    pub fn is_enabled(&self, fqn: &str) -> bool {
        let matched_added = self.added.iter().any(|(wc, _)| matches_wildcard(wc, fqn));
        if !matched_added { return false; }
        let matched_removed = self.removed.iter().any(|(wc, _)| matches_wildcard(wc, fqn));
        !matched_removed
    }
}

impl Default for TagHelperDirectiveSet {
    fn default() -> Self { Self::new() }
}

fn parse_tag_helper_spec(spec: &str) -> Option<(String, String)> {
    // "*, Microsoft.AspNetCore.Mvc.TagHelpers" or "MyApp.TagHelpers.*, MyApp"
    let comma = spec.find(',')?;
    let wildcard = spec[..comma].trim().to_string();
    let assembly = spec[comma + 1..].trim().to_string();
    Some((wildcard, assembly))
}

fn matches_wildcard(wildcard: &str, fqn: &str) -> bool {
    if wildcard == "*" { return true; }
    if wildcard.ends_with(".*") {
        let prefix = wildcard.trim_end_matches(".*");
        return fqn.starts_with(prefix);
    }
    wildcard == fqn
}

// ── Validação de sections ─────────────────────────────────────────────────────

/// Erro de section (section ausente/duplicada).
#[derive(Debug, Clone)]
pub struct SectionError {
    pub kind: SectionErrorKind,
    pub section_name: String,
    pub view: PathBuf,
}

#[derive(Debug, Clone)]
pub enum SectionErrorKind {
    /// Section obrigatória não preenchida.
    RequiredSectionMissing,
    /// Section preenchida mais de uma vez.
    DuplicateSection,
    /// Section preenchida mas não declarada no layout.
    UnknownSection,
}

/// Valida sections entre layout e view filha.
pub fn validate_sections(
    layout: &[Section],
    provided: &[String],
    view: &Path,
) -> Vec<SectionError> {
    let mut errors = Vec::new();
    let provided_set: HashSet<_> = provided.iter().collect();

    // Required sections must be provided
    for section in layout.iter().filter(|s| s.required) {
        if !provided_set.contains(&section.name) {
            errors.push(SectionError {
                kind: SectionErrorKind::RequiredSectionMissing,
                section_name: section.name.clone(),
                view: view.to_path_buf(),
            });
        }
    }

    // Detect duplicates in provided
    let mut seen = HashSet::new();
    for name in provided {
        if !seen.insert(name) {
            errors.push(SectionError {
                kind: SectionErrorKind::DuplicateSection,
                section_name: name.clone(),
                view: view.to_path_buf(),
            });
        }
    }

    // Sections not declared in layout
    let layout_names: HashSet<_> = layout.iter().map(|s| &s.name).collect();
    for name in provided {
        if !layout_names.contains(name) {
            errors.push(SectionError {
                kind: SectionErrorKind::UnknownSection,
                section_name: name.clone(),
                view: view.to_path_buf(),
            });
        }
    }

    errors
}

// ── Testes ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ViewGraph: insert + get
    #[test]
    fn view_graph_insert_get() {
        let mut graph = ViewGraph::new();
        let path = PathBuf::from("Views/Home/Index.cshtml");
        graph.insert(ViewNode {
            path: path.clone(),
            layout: Some(PathBuf::from("Views/Shared/_Layout.cshtml")),
            partials: vec![],
            sections_rendered: vec!["Scripts".into()],
            sections_provided: vec![],
        });
        assert!(graph.get(&path).is_some());
        assert_eq!(graph.len(), 1);
    }

    // ViewGraph: invalidate remove dependents
    #[test]
    fn view_graph_invalidate_removes_dependent() {
        let mut graph = ViewGraph::new();
        let layout = PathBuf::from("Views/Shared/_Layout.cshtml");
        let child = PathBuf::from("Views/Home/Index.cshtml");

        graph.insert(ViewNode { path: layout.clone(), layout: None, partials: vec![], sections_rendered: vec![], sections_provided: vec![] });
        graph.insert(ViewNode { path: child.clone(), layout: Some(layout.clone()), partials: vec![], sections_rendered: vec![], sections_provided: vec![] });

        graph.invalidate(&layout);
        assert!(graph.get(&layout).is_none(), "layout must be removed");
        assert!(graph.get(&child).is_none(), "child must be removed");
    }

    // to_kebab_case
    #[test]
    fn kebab_case_conversion() {
        assert_eq!(to_kebab_case("Anchor"), "anchor");
        assert_eq!(to_kebab_case("AnchorNew"), "anchor-new");
        assert_eq!(to_kebab_case("MyCustom"), "my-custom");
        assert_eq!(to_kebab_case("A"), "a");
    }

    // TagHelperIndex: builtins registrados
    #[test]
    fn tag_helper_index_builtins() {
        let mut idx = TagHelperIndex::new();
        idx.register_builtins();

        assert!(!idx.get("form").is_empty(), "form must be a Tag Helper");
        assert!(!idx.get("input").is_empty(), "input must be a Tag Helper");
        assert!(!idx.get("a").is_empty(), "a (anchor) must be a Tag Helper");
        assert!(!idx.get("partial").is_empty(), "partial must be a Tag Helper");

        let form_th = &idx.get("form")[0];
        assert!(form_th.attributes.iter().any(|a| a == "asp-action"), "form must have asp-action attr");
        assert!(form_th.is_builtin);
    }

    // TagHelperIndex: discover from source
    #[test]
    fn tag_helper_discover_from_source() {
        let mut sym_idx = crate::cshtml::semantics::SymbolIndex::new();
        sym_idx.index_file(
            &PathBuf::from("MyTagHelpers.cs"),
            "namespace MyApp.TagHelpers { public class ButtonTagHelper {} }",
        );
        let mut th_idx = TagHelperIndex::new();
        th_idx.discover_from_source(&sym_idx);

        let helpers = th_idx.get("button");
        assert!(!helpers.is_empty(), "ButtonTagHelper must produce 'button' tag");
        assert!(!helpers[0].is_builtin);
    }

    // TagHelperDirectiveSet: add/remove
    #[test]
    fn tag_helper_directives_add_remove() {
        let mut ds = TagHelperDirectiveSet::new();
        // Add all from Microsoft assembly → "*, Microsoft.AspNetCore.Mvc.TagHelpers"
        ds.process_directive("addTagHelper", "*, Microsoft.AspNetCore.Mvc.TagHelpers");
        // Remove just ScriptTagHelper
        ds.process_directive("removeTagHelper", "Microsoft.AspNetCore.Mvc.TagHelpers.ScriptTagHelper, Microsoft.AspNetCore.Mvc.TagHelpers");

        // "*, ..." wildcard matches any FQN regardless of assembly (our impl doesn't track assembly)
        assert!(ds.is_enabled("Microsoft.AspNetCore.Mvc.TagHelpers.FormTagHelper"), "form must be enabled");
        assert!(!ds.is_enabled("Microsoft.AspNetCore.Mvc.TagHelpers.ScriptTagHelper"), "removed must not be enabled");
        // With "*" wildcard, all types are matched — this is by design in our simplified model.
        // An unregistered type IS enabled when "*" was added. This tests the actual behavior.
        assert!(ds.is_enabled("AnyOther.Type"), "star wildcard enables all types not removed");
    }

    // TagHelperDirectiveSet: prefix
    #[test]
    fn tag_helper_prefix() {
        let mut ds = TagHelperDirectiveSet::new();
        ds.process_directive("tagHelperPrefix", "th:");
        assert_eq!(ds.prefix, Some("th:".to_string()));
    }

    // matches_wildcard
    #[test]
    fn wildcard_matching() {
        assert!(matches_wildcard("*", "Any.Class"));
        assert!(matches_wildcard("MyApp.*", "MyApp.Something.Foo"));
        assert!(!matches_wildcard("MyApp.*", "OtherApp.Foo"));
        assert!(matches_wildcard("MyApp.Foo", "MyApp.Foo"));
        assert!(!matches_wildcard("MyApp.Foo", "MyApp.Bar"));
    }

    // validate_sections: required missing → error
    #[test]
    fn validate_sections_required_missing() {
        let layout_sections = vec![
            Section { name: "Scripts".into(), required: true, declared_in: PathBuf::from("_Layout.cshtml") },
        ];
        let provided = vec![];
        let errs = validate_sections(&layout_sections, &provided, &PathBuf::from("Index.cshtml"));
        assert_eq!(errs.len(), 1);
        assert!(matches!(errs[0].kind, SectionErrorKind::RequiredSectionMissing));
        assert_eq!(errs[0].section_name, "Scripts");
    }

    // validate_sections: optional not provided → no error
    #[test]
    fn validate_sections_optional_not_provided_ok() {
        let layout_sections = vec![
            Section { name: "Scripts".into(), required: false, declared_in: PathBuf::from("_Layout.cshtml") },
        ];
        let provided = vec![];
        let errs = validate_sections(&layout_sections, &provided, &PathBuf::from("Index.cshtml"));
        assert!(errs.is_empty(), "optional section not provided must not error");
    }

    // validate_sections: duplicate provided → error
    #[test]
    fn validate_sections_duplicate_error() {
        let layout_sections = vec![
            Section { name: "Scripts".into(), required: false, declared_in: PathBuf::from("_Layout.cshtml") },
        ];
        let provided = vec!["Scripts".into(), "Scripts".into()];
        let errs = validate_sections(&layout_sections, &provided, &PathBuf::from("Index.cshtml"));
        let dup = errs.iter().find(|e| matches!(e.kind, SectionErrorKind::DuplicateSection));
        assert!(dup.is_some(), "must detect duplicate section");
    }

    // validate_sections: unknown section → error
    #[test]
    fn validate_sections_unknown_section_error() {
        let layout_sections = vec![
            Section { name: "Scripts".into(), required: false, declared_in: PathBuf::from("_Layout.cshtml") },
        ];
        let provided = vec!["NotDeclared".into()];
        let errs = validate_sections(&layout_sections, &provided, &PathBuf::from("Index.cshtml"));
        let unknown = errs.iter().find(|e| matches!(e.kind, SectionErrorKind::UnknownSection));
        assert!(unknown.is_some(), "must detect unknown section");
    }

    // validate_sections: all ok
    #[test]
    fn validate_sections_all_ok() {
        let layout_sections = vec![
            Section { name: "Scripts".into(), required: true, declared_in: PathBuf::from("_Layout.cshtml") },
            Section { name: "Styles".into(), required: false, declared_in: PathBuf::from("_Layout.cshtml") },
        ];
        let provided = vec!["Scripts".into(), "Styles".into()];
        let errs = validate_sections(&layout_sections, &provided, &PathBuf::from("Index.cshtml"));
        assert!(errs.is_empty(), "all sections correctly provided must produce no errors");
    }

    // resolve_partial: NotFound for non-existent reference
    #[test]
    fn resolve_partial_not_found() {
        let result = resolve_partial(
            "NonExistentPartial",
            &PathBuf::from("Views/Home/Index.cshtml"),
            &PathBuf::from("."),
        );
        assert!(matches!(result, ViewResolution::NotFound), "non-existent partial must be NotFound");
    }

    // resolve_partial: null layout ref → NotFound
    #[test]
    fn resolve_layout_null_ref() {
        let result = resolve_layout("null", &PathBuf::from("Index.cshtml"), &PathBuf::from("."));
        assert!(matches!(result, ViewResolution::NotFound));
    }

    // TagHelperIndex: get case-insensitive
    #[test]
    fn tag_helper_case_insensitive() {
        let mut idx = TagHelperIndex::new();
        idx.register_builtins();
        assert!(!idx.get("FORM").is_empty(), "must be case-insensitive");
        assert!(!idx.get("Form").is_empty());
    }

    // TagHelperIndex: all() iterates all helpers
    #[test]
    fn tag_helper_all_iterates() {
        let mut idx = TagHelperIndex::new();
        idx.register_builtins();
        let count = idx.all().count();
        assert!(count >= 10, "must have at least 10 builtin tag helpers; got {count}");
    }

    // TagHelperDirectiveSet: add wildcard for namespace
    #[test]
    fn tag_helper_directives_namespace_wildcard() {
        let mut ds = TagHelperDirectiveSet::new();
        ds.process_directive("addTagHelper", "MyApp.TagHelpers.*, MyApp");

        assert!(ds.is_enabled("MyApp.TagHelpers.ButtonTagHelper"));
        assert!(!ds.is_enabled("MyApp.Other.Foo"), "other namespace must not be enabled");
    }
}
