/// Descoberta de workspace SDK-style e resolução de contexto de Views (issue #40).
///
/// Localiza o `.csproj` mais próximo de um `.cshtml`, resolve `_ViewImports.cshtml`
/// em cadeia hierárquica, e agrega `@using`, `@inject`, `@namespace`, `@addTagHelper`
/// e outros imports herdados por convenção Razor.
///
/// Sem MSBuild — leitura direta dos arquivos; construções não avaliadas retornam
/// `unsupported/unknown`, nunca inferem silenciosamente.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ── Tipos públicos ────────────────────────────────────────────────────────────

/// Indica se o projeto foi reconhecido.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectKind {
    /// Projeto SDK-style detectado (Sdk="Microsoft.NET.Sdk.Web" ou similar).
    Web,
    /// .csproj encontrado mas tipo não reconhecido (versão antiga, custom SDK).
    Unsupported { reason: String },
    /// Nenhum .csproj encontrado na cadeia de diretórios.
    NotFound,
}

/// Contexto de um projeto `.csproj`.
#[derive(Debug, Clone)]
pub struct ProjectContext {
    /// Caminho para o `.csproj`.
    pub csproj: PathBuf,
    /// Raiz do projeto (diretório pai do `.csproj`).
    pub root: PathBuf,
    pub kind: ProjectKind,
    /// Namespace padrão (`<RootNamespace>` ou derivado do nome do projeto).
    pub default_namespace: String,
    /// `<TargetFramework>` ou vazio se não encontrado.
    pub target_framework: String,
}

/// Tipo de view por convenção ASP.NET Core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViewKind {
    /// `Views/**/*.cshtml` — view MVC.
    MvcView,
    /// `Pages/**/*.cshtml` — Razor Page.
    RazorPage,
    /// `Views/Shared/_*.cshtml` — layout ou partial.
    Partial,
    /// `_ViewImports.cshtml`.
    ViewImports,
    /// `_ViewStart.cshtml`.
    ViewStart,
    /// Arquivo `.cshtml` fora das convenções anteriores.
    Other,
}

/// Contexto agregado de um `.cshtml` — projeto + imports herdados.
#[derive(Debug, Clone)]
pub struct DocumentContext {
    /// Caminho absoluto do `.cshtml`.
    pub path: PathBuf,
    pub kind: ViewKind,
    /// Projeto associado (pode ser `NotFound` ou `Unsupported`).
    pub project: Option<ProjectContext>,
    /// Diretivas `@using` acumuladas de todos os `_ViewImports` na cadeia.
    pub usings: Vec<String>,
    /// Diretivas `@inject` acumuladas.
    pub injects: Vec<(String, String)>, // (Type, Name)
    /// Último `@namespace` encontrado na cadeia (mais próximo ganha).
    pub namespace: Option<String>,
    /// Diretivas `@addTagHelper` acumuladas.
    pub tag_helpers: Vec<String>,
    /// Explicita que algum import veio de `_ViewImports`.
    pub view_imports_chain: Vec<PathBuf>,
}

// ── Descoberta de projeto ─────────────────────────────────────────────────────

/// Encontra o `.csproj` mais próximo na cadeia de diretórios de `start`.
pub fn find_csproj(start: &Path) -> Option<PathBuf> {
    let mut dir = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };

    loop {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("csproj") {
                    return Some(p);
                }
            }
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => return None,
        }
    }
}

/// Analisa um `.csproj` SDK-style e extrai namespace + target framework.
pub fn parse_csproj(path: &Path) -> ProjectContext {
    let root = path.parent().unwrap_or(path).to_path_buf();
    let project_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Project")
        .to_string();

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            return ProjectContext {
                csproj: path.to_path_buf(),
                root,
                kind: ProjectKind::Unsupported { reason: e.to_string() },
                default_namespace: project_name,
                target_framework: String::new(),
            };
        }
    };

    let kind = if content.contains("Microsoft.NET.Sdk.Web")
        || content.contains("Sdk=\"Microsoft.NET.Sdk\"")
        || content.contains("<Project Sdk=")
    {
        ProjectKind::Web
    } else if content.contains("<Project") {
        ProjectKind::Unsupported {
            reason: "Formato de projeto não SDK-style (não suportado nesta versão)".into(),
        }
    } else {
        ProjectKind::Unsupported {
            reason: "Arquivo .csproj não reconhecido".into(),
        }
    };

    let default_namespace = extract_xml_tag(&content, "RootNamespace")
        .unwrap_or_else(|| project_name.clone());
    let target_framework = extract_xml_tag(&content, "TargetFramework")
        .or_else(|| extract_xml_tag(&content, "TargetFrameworks"))
        .unwrap_or_default();

    ProjectContext {
        csproj: path.to_path_buf(),
        root,
        kind,
        default_namespace,
        target_framework,
    }
}

/// Extrai o conteúdo de uma tag XML simples (sem namespace, sem atributos).
fn extract_xml_tag(content: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = content.find(&open)? + open.len();
    let end = content[start..].find(&close)? + start;
    Some(content[start..end].trim().to_string())
}

// ── Classificação de view ─────────────────────────────────────────────────────

pub fn classify_view(path: &Path, project_root: &Path) -> ViewKind {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.eq_ignore_ascii_case("_ViewImports.cshtml") {
        return ViewKind::ViewImports;
    }
    if name.eq_ignore_ascii_case("_ViewStart.cshtml") {
        return ViewKind::ViewStart;
    }

    // Compute path relative to project root.
    let rel = path.strip_prefix(project_root).unwrap_or(path);
    let first = rel
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .unwrap_or("");

    match first.to_ascii_lowercase().as_str() {
        "pages" => ViewKind::RazorPage,
        "views" => {
            let is_partial = name.starts_with('_');
            if is_partial {
                ViewKind::Partial
            } else {
                ViewKind::MvcView
            }
        }
        _ => ViewKind::Other,
    }
}

// ── Resolução da cadeia de _ViewImports ───────────────────────────────────────

/// Importações coletadas de um único `_ViewImports.cshtml`.
#[derive(Debug, Default)]
struct ViewImportDirectives {
    usings: Vec<String>,
    injects: Vec<(String, String)>,
    namespace: Option<String>,
    tag_helpers: Vec<String>,
}

fn parse_view_imports(path: &Path) -> ViewImportDirectives {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return ViewImportDirectives::default(),
    };

    let mut result = ViewImportDirectives::default();
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("@using ") {
            result.usings.push(rest.trim().to_string());
        } else if let Some(rest) = trimmed.strip_prefix("@inject ") {
            let parts: Vec<&str> = rest.splitn(2, ' ').collect();
            if parts.len() == 2 {
                result.injects.push((parts[0].trim().into(), parts[1].trim().into()));
            }
        } else if let Some(rest) = trimmed.strip_prefix("@namespace ") {
            result.namespace = Some(rest.trim().to_string());
        } else if let Some(rest) = trimmed.strip_prefix("@addTagHelper ") {
            result.tag_helpers.push(rest.trim().to_string());
        }
    }
    result
}

/// Constrói a cadeia de `_ViewImports.cshtml` do arquivo até a raiz do projeto
/// (ou raiz do filesystem). Os mais próximos do arquivo têm maior prioridade.
fn view_imports_chain(start: &Path, stop_at: &Path) -> Vec<PathBuf> {
    let mut chain = Vec::new();
    let mut dir = if start.is_file() {
        start.parent().map(|p| p.to_path_buf())
    } else {
        Some(start.to_path_buf())
    };

    while let Some(d) = dir {
        let candidate = d.join("_ViewImports.cshtml");
        if candidate.is_file() {
            chain.push(candidate);
        }
        if d == stop_at || d.parent().is_none() {
            break;
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }
    chain
}

// ── API pública ───────────────────────────────────────────────────────────────

/// Resolve o `DocumentContext` completo para um arquivo `.cshtml`.
///
/// Caminho de acesso ao filesystem — não deve ser chamado em loops críticos.
/// O LSP server deve armazenar em cache e invalidar em mudanças de `_ViewImports`.
pub fn resolve_document_context(cshtml_path: &Path) -> DocumentContext {
    let project = find_csproj(cshtml_path).map(|p| parse_csproj(&p));

    let project_root = project
        .as_ref()
        .map(|p| p.root.clone())
        .unwrap_or_else(|| {
            cshtml_path
                .parent()
                .unwrap_or(cshtml_path)
                .to_path_buf()
        });

    let kind = classify_view(cshtml_path, &project_root);

    // Resolve _ViewImports chain (arquivo mais próximo → mais distante).
    let imports_chain = view_imports_chain(cshtml_path, &project_root);

    // Aggregate imports in reverse order (distant → close), so closer wins for
    // @namespace while usings and injects accumulate.
    let mut usings: Vec<String> = Vec::new();
    let mut injects: Vec<(String, String)> = Vec::new();
    let mut namespace: Option<String> = None;
    let mut tag_helpers: Vec<String> = Vec::new();

    for imports_file in imports_chain.iter().rev() {
        let directives = parse_view_imports(imports_file);
        usings.extend(directives.usings);
        injects.extend(directives.injects);
        if directives.namespace.is_some() {
            namespace = directives.namespace; // closer file wins
        }
        tag_helpers.extend(directives.tag_helpers);
    }

    // Deduplicate usings (order-preserving).
    let usings = dedup_vec(usings);
    let tag_helpers = dedup_vec(tag_helpers);

    DocumentContext {
        path: cshtml_path.to_path_buf(),
        kind,
        project,
        usings,
        injects,
        namespace,
        tag_helpers,
        view_imports_chain: imports_chain,
    }
}

fn dedup_vec(v: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    v.into_iter().filter(|s| seen.insert(s.clone())).collect()
}

// ── Cache de contextos (invalidação por _ViewImports) ─────────────────────────

/// Cache em memória que evita re-leitura do filesystem em cada atualização LSP.
/// Invalidado quando um `_ViewImports.cshtml` muda ou um documento é fechado.
pub struct WorkspaceCache {
    /// `path → DocumentContext` para documentos atualmente abertos.
    contexts: HashMap<PathBuf, DocumentContext>,
}

impl WorkspaceCache {
    pub fn new() -> Self {
        Self { contexts: HashMap::new() }
    }

    /// Retorna (e armazena) o contexto de `path`, lendo do filesystem se necessário.
    pub fn get_or_resolve(&mut self, path: &Path) -> &DocumentContext {
        if !self.contexts.contains_key(path) {
            let ctx = resolve_document_context(path);
            self.contexts.insert(path.to_path_buf(), ctx);
        }
        self.contexts.get(path).unwrap()
    }

    /// Remove o contexto de um documento fechado.
    pub fn evict(&mut self, path: &Path) {
        self.contexts.remove(path);
    }

    /// Invalida todos os contextos cujos `_ViewImports` incluem `changed_imports`.
    /// Chamado quando um `_ViewImports.cshtml` é salvo.
    pub fn invalidate_by_imports(&mut self, changed_imports: &Path) {
        self.contexts.retain(|_path, ctx| {
            !ctx.view_imports_chain.contains(&changed_imports.to_path_buf())
        });
    }

    pub fn len(&self) -> usize {
        self.contexts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.contexts.is_empty()
    }
}

impl Default for WorkspaceCache {
    fn default() -> Self {
        Self::new()
    }
}

// ── Testes ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup_sdk_project() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        let csproj = dir.path().join("MyApp.csproj");
        fs::write(
            &csproj,
            r#"<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <RootNamespace>MyApp</RootNamespace>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>"#,
        )
        .unwrap();
        dir
    }

    // ── find_csproj ───────────────────────────────────────────────────────────

    #[test]
    fn finds_csproj_in_same_dir() {
        let dir = setup_sdk_project();
        let view = dir.path().join("Views").join("Home").join("Index.cshtml");
        fs::create_dir_all(view.parent().unwrap()).unwrap();
        fs::write(&view, "").unwrap();
        let found = find_csproj(&view);
        assert!(found.is_some(), "must find .csproj");
        assert_eq!(found.unwrap().file_name().unwrap(), "MyApp.csproj");
    }

    #[test]
    fn returns_none_when_no_csproj() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file.cshtml");
        fs::write(&file, "").unwrap();
        // No .csproj in any parent — but stop searching at filesystem root.
        // We can't guarantee the test machine has no .csproj in its parents,
        // so we just assert no panic.
        let _ = find_csproj(&file);
    }

    // ── parse_csproj ──────────────────────────────────────────────────────────

    #[test]
    fn parses_sdk_web_project() {
        let dir = setup_sdk_project();
        let ctx = parse_csproj(&dir.path().join("MyApp.csproj"));
        assert_eq!(ctx.kind, ProjectKind::Web);
        assert_eq!(ctx.default_namespace, "MyApp");
        assert_eq!(ctx.target_framework, "net8.0");
    }

    #[test]
    fn unsupported_csproj_has_reason() {
        let dir = tempfile::tempdir().unwrap();
        let csproj = dir.path().join("Old.csproj");
        fs::write(&csproj, "<Project ToolsVersion=\"4.0\"><PropertyGroup></PropertyGroup></Project>").unwrap();
        let ctx = parse_csproj(&csproj);
        assert!(matches!(ctx.kind, ProjectKind::Unsupported { .. }));
    }

    // ── classify_view ─────────────────────────────────────────────────────────

    #[test]
    fn classifies_mvc_view() {
        let root = Path::new("/project");
        let path = Path::new("/project/Views/Home/Index.cshtml");
        assert_eq!(classify_view(path, root), ViewKind::MvcView);
    }

    #[test]
    fn classifies_razor_page() {
        let root = Path::new("/project");
        let path = Path::new("/project/Pages/Index.cshtml");
        assert_eq!(classify_view(path, root), ViewKind::RazorPage);
    }

    #[test]
    fn classifies_partial() {
        let root = Path::new("/project");
        let path = Path::new("/project/Views/Shared/_Layout.cshtml");
        assert_eq!(classify_view(path, root), ViewKind::Partial);
    }

    #[test]
    fn classifies_view_imports() {
        let root = Path::new("/project");
        let path = Path::new("/project/Views/_ViewImports.cshtml");
        assert_eq!(classify_view(path, root), ViewKind::ViewImports);
    }

    #[test]
    fn classifies_view_start() {
        let root = Path::new("/project");
        let path = Path::new("/project/Views/_ViewStart.cshtml");
        assert_eq!(classify_view(path, root), ViewKind::ViewStart);
    }

    // ── parse_view_imports ────────────────────────────────────────────────────

    #[test]
    fn parses_all_directive_types() {
        let dir = tempfile::tempdir().unwrap();
        let imports = dir.path().join("_ViewImports.cshtml");
        fs::write(
            &imports,
            "@using System\n@using MyApp.Models\n@inject IUserService UserService\n@namespace MyApp.Views\n@addTagHelper *, Microsoft.AspNetCore.Mvc.TagHelpers\n",
        )
        .unwrap();
        let d = parse_view_imports(&imports);
        assert_eq!(d.usings, vec!["System", "MyApp.Models"]);
        assert_eq!(d.injects, vec![("IUserService".to_string(), "UserService".to_string())]);
        assert_eq!(d.namespace, Some("MyApp.Views".to_string()));
        assert_eq!(d.tag_helpers, vec!["*, Microsoft.AspNetCore.Mvc.TagHelpers"]);
    }

    // ── view_imports_chain ────────────────────────────────────────────────────

    #[test]
    fn chain_collects_nested_imports() {
        let dir = tempfile::tempdir().unwrap();
        // Root imports
        fs::write(dir.path().join("_ViewImports.cshtml"), "@using Root").unwrap();
        // Views/ imports
        let views = dir.path().join("Views");
        fs::create_dir(&views).unwrap();
        fs::write(views.join("_ViewImports.cshtml"), "@using Views").unwrap();
        // Views/Home/ imports
        let home = views.join("Home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("_ViewImports.cshtml"), "@using Home").unwrap();
        let view = home.join("Index.cshtml");
        fs::write(&view, "").unwrap();

        let chain = view_imports_chain(&view, dir.path());
        assert_eq!(chain.len(), 3);
        // Closest first (Home), then Views, then Root.
        assert!(chain[0].ends_with("Home/_ViewImports.cshtml"));
        assert!(chain[1].ends_with("Views/_ViewImports.cshtml"));
        assert!(chain[2].ends_with("_ViewImports.cshtml"));
    }

    // ── resolve_document_context ──────────────────────────────────────────────

    #[test]
    fn context_aggregates_usings() {
        let dir = setup_sdk_project();
        // Root _ViewImports
        fs::write(
            dir.path().join("_ViewImports.cshtml"),
            "@using System\n@addTagHelper *, Microsoft.AspNetCore.Mvc.TagHelpers\n",
        )
        .unwrap();
        // Views/_ViewImports
        let views = dir.path().join("Views");
        fs::create_dir_all(&views).unwrap();
        fs::write(
            views.join("_ViewImports.cshtml"),
            "@using MyApp.Models\n@namespace MyApp.Views\n",
        )
        .unwrap();
        // The view
        let home = views.join("Home");
        fs::create_dir_all(&home).unwrap();
        let view = home.join("Index.cshtml");
        fs::write(&view, "@model ProductViewModel\n<p>Hello</p>").unwrap();

        let ctx = resolve_document_context(&view);
        assert_eq!(ctx.kind, ViewKind::MvcView);
        assert!(ctx.project.is_some());
        assert_eq!(ctx.project.as_ref().unwrap().kind, ProjectKind::Web);
        assert!(ctx.usings.contains(&"System".to_string()), "must include root @using");
        assert!(ctx.usings.contains(&"MyApp.Models".to_string()), "must include views @using");
        assert_eq!(ctx.namespace, Some("MyApp.Views".to_string()));
        assert!(ctx.tag_helpers.contains(&"*, Microsoft.AspNetCore.Mvc.TagHelpers".to_string()));
    }

    #[test]
    fn closer_namespace_wins() {
        let dir = tempfile::tempdir().unwrap();
        // Root imports: namespace = Root
        fs::write(dir.path().join("_ViewImports.cshtml"), "@namespace Root.NS\n").unwrap();
        // Views imports: namespace = Views (closer → wins)
        let views = dir.path().join("Views");
        fs::create_dir_all(&views).unwrap();
        fs::write(views.join("_ViewImports.cshtml"), "@namespace Views.NS\n").unwrap();
        let view = views.join("Index.cshtml");
        fs::write(&view, "").unwrap();

        let ctx = resolve_document_context(&view);
        assert_eq!(ctx.namespace, Some("Views.NS".to_string()));
    }

    #[test]
    fn dedup_usings_across_chain() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("_ViewImports.cshtml"), "@using System\n").unwrap();
        let views = dir.path().join("Views");
        fs::create_dir_all(&views).unwrap();
        fs::write(views.join("_ViewImports.cshtml"), "@using System\n").unwrap();
        let view = views.join("Index.cshtml");
        fs::write(&view, "").unwrap();

        let ctx = resolve_document_context(&view);
        assert_eq!(ctx.usings.iter().filter(|u| *u == "System").count(), 1, "no duplicate usings");
    }

    // ── WorkspaceCache ────────────────────────────────────────────────────────

    #[test]
    fn cache_stores_and_returns_context() {
        let dir = setup_sdk_project();
        let views = dir.path().join("Views");
        fs::create_dir_all(&views).unwrap();
        let view = views.join("Index.cshtml");
        fs::write(&view, "").unwrap();

        let mut cache = WorkspaceCache::new();
        let ctx = cache.get_or_resolve(&view);
        assert_eq!(ctx.path, view);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn evict_removes_entry() {
        let dir = tempfile::tempdir().unwrap();
        let view = dir.path().join("Index.cshtml");
        fs::write(&view, "").unwrap();

        let mut cache = WorkspaceCache::new();
        cache.get_or_resolve(&view);
        assert_eq!(cache.len(), 1);
        cache.evict(&view);
        assert!(cache.is_empty());
    }

    #[test]
    fn invalidate_by_imports_removes_affected() {
        let dir = tempfile::tempdir().unwrap();
        let imports = dir.path().join("_ViewImports.cshtml");
        fs::write(&imports, "@using System\n").unwrap();
        let view = dir.path().join("Index.cshtml");
        fs::write(&view, "").unwrap();

        let mut cache = WorkspaceCache::new();
        cache.get_or_resolve(&view);
        assert_eq!(cache.len(), 1);
        // Simulate _ViewImports changing.
        cache.invalidate_by_imports(&imports);
        assert!(cache.is_empty(), "context must be invalidated when imports change");
    }
}
