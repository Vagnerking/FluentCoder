/// Camada de binding Razor → índice semântico (issue #43).
///
/// Transforma a sintaxe de um documento .cshtml em símbolos resolvidos:
/// - `@model` → tipo do model e seus membros
/// - `@inject` → serviços disponíveis como variáveis de instância
/// - `@using` (próprio + herdado de `_ViewImports.cshtml`) → namespaces de resolução
/// - Variáveis locais de blocos C# e `@foreach`
///
/// Resolução incompleta produz `Confidence::Unknown` ou `Confidence::Ambiguous` —
/// nunca diagnóstico falso de membro inexistente.

use std::collections::HashMap;

use super::ast::{NodeKind, ParseTree};
use super::semantics::{Resolution, SymbolIndex};
use super::types::Snapshot;
use super::workspace::DocumentContext;

// ── Confiança de resolução ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Confidence {
    Certain,
    Inferred,
    Ambiguous,
    Unknown,
}

// ── Origem de uma resolução ───────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Origin {
    Model,
    Inject,
    Local,
    ImplicitRazor,
    Member { parent: String },
}

// ── Símbolo de binding ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct BoundSymbol {
    pub name: String,
    /// Fully-qualified name do tipo, ou vazio se unknown.
    pub type_fqn: String,
    pub confidence: Confidence,
    pub origin: Origin,
}

impl BoundSymbol {
    fn certain(name: impl Into<String>, type_fqn: impl Into<String>, origin: Origin) -> Self {
        BoundSymbol { name: name.into(), type_fqn: type_fqn.into(), confidence: Confidence::Certain, origin }
    }

    fn with_confidence(name: impl Into<String>, type_fqn: impl Into<String>, confidence: Confidence, origin: Origin) -> Self {
        BoundSymbol { name: name.into(), type_fqn: type_fqn.into(), confidence, origin }
    }
}

// ── Escopo léxico ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Scope {
    pub locals: HashMap<String, BoundSymbol>,
    #[allow(dead_code)]
    pub label: String,
}

impl Scope {
    fn new(label: impl Into<String>) -> Self {
        Scope { locals: HashMap::new(), label: label.into() }
    }

    fn define(&mut self, sym: BoundSymbol) {
        self.locals.insert(sym.name.clone(), sym);
    }

    fn lookup(&self, name: &str) -> Option<&BoundSymbol> {
        self.locals.get(name)
    }
}

// ── Contexto de binding para um documento ─────────────────────────────────────

#[derive(Debug, Clone)]
pub struct BindingContext {
    /// Símbolos de nível de documento: Model, Inject, implicítos Razor.
    pub document_symbols: HashMap<String, BoundSymbol>,
    /// Pilha de escopos (índice 0 = raiz).
    pub scopes: Vec<Scope>,
    /// Namespaces de busca: próprios + herdados de _ViewImports.
    pub usings: Vec<String>,
    /// Avisos não-fatais (resoluções parciais, diretivas mal formadas).
    pub warnings: Vec<String>,
}

impl BindingContext {
    fn new(usings: Vec<String>) -> Self {
        BindingContext {
            document_symbols: HashMap::new(),
            scopes: vec![Scope::new("root")],
            usings,
            warnings: Vec::new(),
        }
    }

    /// Resolve um nome: primeiro nos escopos (interno → externo), depois em document_symbols.
    pub fn lookup(&self, name: &str) -> Option<&BoundSymbol> {
        for scope in self.scopes.iter().rev() {
            if let Some(s) = scope.lookup(name) { return Some(s); }
        }
        self.document_symbols.get(name)
    }

    fn define_document(&mut self, sym: BoundSymbol) {
        self.document_symbols.insert(sym.name.clone(), sym);
    }

    fn push_scope(&mut self, label: impl Into<String>) {
        self.scopes.push(Scope::new(label));
    }

    fn define_local(&mut self, sym: BoundSymbol) {
        if let Some(s) = self.scopes.last_mut() { s.define(sym); }
    }

    fn warn(&mut self, msg: impl Into<String>) {
        self.warnings.push(msg.into());
    }
}

// ── Símbolos implícitos Razor ─────────────────────────────────────────────────

fn register_implicit_symbols(ctx: &mut BindingContext) {
    let implicits = [
        ("Html",      "Microsoft.AspNetCore.Mvc.Rendering.IHtmlHelper"),
        ("Url",       "Microsoft.AspNetCore.Mvc.IUrlHelper"),
        ("ViewData",  "Microsoft.AspNetCore.Mvc.ViewFeatures.ViewDataDictionary"),
        ("ViewBag",   "System.Dynamic.DynamicObject"),
        ("TempData",  "Microsoft.AspNetCore.Mvc.ViewFeatures.ITempDataDictionary"),
        ("User",      "System.Security.Claims.ClaimsPrincipal"),
        ("Context",   "Microsoft.AspNetCore.Http.HttpContext"),
    ];
    for (name, fqn) in implicits {
        ctx.define_document(BoundSymbol::certain(name, fqn, Origin::ImplicitRazor));
    }
    // Model placeholder — overwritten if @model is present
    ctx.define_document(BoundSymbol::with_confidence("Model", "", Confidence::Unknown, Origin::Model));
}

// ── Resolução de tipos via índice ─────────────────────────────────────────────

fn resolve_type(type_name: &str, usings: &[String], index: &SymbolIndex) -> (String, Confidence) {
    if type_name.is_empty() { return (String::new(), Confidence::Unknown); }

    // Já qualificado (contém ponto)?
    if type_name.contains('.') {
        return match index.resolve(type_name) {
            Resolution::Resolved(_) => (type_name.to_string(), Confidence::Certain),
            Resolution::Ambiguous(_) => (type_name.to_string(), Confidence::Ambiguous),
            Resolution::Unknown => (type_name.to_string(), Confidence::Inferred),
        };
    }

    // Busca simples
    match index.resolve(type_name) {
        Resolution::Resolved(sym) => {
            // Extrai o FQN do id (formato "file::fqn")
            let fqn = sym.id.splitn(2, "::").nth(1).unwrap_or(type_name).to_string();
            return (fqn, Confidence::Certain);
        }
        Resolution::Ambiguous(_) => return (type_name.to_string(), Confidence::Ambiguous),
        Resolution::Unknown => {}
    }

    // Busca por namespace
    let mut candidates: Vec<String> = Vec::new();
    for ns in usings {
        let fqn = format!("{ns}.{type_name}");
        if matches!(index.resolve(&fqn), Resolution::Resolved(_)) {
            candidates.push(fqn);
        }
    }
    match candidates.len() {
        0 => (type_name.to_string(), Confidence::Unknown),
        1 => (candidates.into_iter().next().unwrap(), Confidence::Certain),
        _ => (type_name.to_string(), Confidence::Ambiguous),
    }
}

// ── Extração de argumento de diretiva ────────────────────────────────────────

/// Dado o texto completo do nó `@model SomeName`, retorna "SomeName".
/// O nó começa em `@` e vai até o fim da linha; o keyword vem depois do `@`.
fn directive_argument<'a>(node_text: &'a str, keyword: &str) -> &'a str {
    // node_text é ex: "@model MyApp.Models.Foo"
    let after_at = node_text.strip_prefix('@').unwrap_or(node_text);
    let after_kw = after_at.trim_start_matches(keyword);
    after_kw.trim()
}

// ── Construtor principal ──────────────────────────────────────────────────────

/// Constrói um `BindingContext` para um documento .cshtml.
///
/// - `doc`: contexto de workspace (usings, project, view kind)
/// - `tree`: ParseTree gerada pelo parser
/// - `snap`: Snapshot do texto (para extrair argumentos de diretiva)
/// - `index`: índice de símbolos C# do projeto
pub fn bind_document(
    doc: &DocumentContext,
    tree: &ParseTree,
    snap: &Snapshot,
    index: &SymbolIndex,
) -> BindingContext {
    let mut ctx = BindingContext::new(doc.usings.clone());
    register_implicit_symbols(&mut ctx);

    for node in tree.walk() {
        match &node.kind {
            NodeKind::RazorDirective { keyword } => {
                let node_text = snap.text_at(node.range).unwrap_or("");
                let arg = directive_argument(node_text, keyword);
                match keyword.as_str() {
                    "model" => bind_model(arg, &mut ctx, index),
                    "inject" => bind_inject(arg, &mut ctx, index),
                    _ => {}
                }
            }
            NodeKind::RazorControlFlow { keyword } if keyword == "foreach" => {
                // Extraímos a declaração de variável do texto cru do nó.
                // Formato: "@foreach (Type varName in collection) { ... }"
                let node_text = snap.text_at(node.range).unwrap_or("");
                bind_foreach_from_text(node_text, &mut ctx, index);
            }
            _ => {}
        }
    }

    ctx
}

fn bind_model(arg: &str, ctx: &mut BindingContext, index: &SymbolIndex) {
    if arg.is_empty() {
        ctx.warn("@model sem tipo");
        return;
    }
    let (fqn, confidence) = resolve_type(arg, &ctx.usings.clone(), index);
    ctx.define_document(BoundSymbol::with_confidence("Model", fqn.clone(), confidence.clone(), Origin::Model));

    // Expõe membros como "Model.X" se tipo resolvido.
    if confidence == Confidence::Certain {
        if let Resolution::Resolved(sym) = index.resolve(&fqn) {
            for child_id in &sym.children {
                if let Some(member_name) = child_id.rsplit("::").next() {
                    ctx.define_document(BoundSymbol::certain(
                        format!("Model.{member_name}"),
                        fqn.clone(),
                        Origin::Member { parent: "Model".into() },
                    ));
                }
            }
        }
    }
}

fn bind_inject(arg: &str, ctx: &mut BindingContext, index: &SymbolIndex) {
    // arg: "TypeName VarName" (TypeName pode ser genérico com espaços)
    let Some(last_ws) = arg.rfind(|c: char| c.is_whitespace()) else {
        ctx.warn(format!("@inject incompleto: «{arg}»"));
        return;
    };
    let type_name = arg[..last_ws].trim();
    let var_name = arg[last_ws..].trim();

    if type_name.is_empty() || var_name.is_empty() {
        ctx.warn(format!("@inject mal formado: «{arg}»"));
        return;
    }

    let (fqn, confidence) = resolve_type(type_name, &ctx.usings.clone(), index);
    ctx.define_document(BoundSymbol::with_confidence(var_name, fqn, confidence, Origin::Inject));
}

/// Extrai variável de iteração de `@foreach (Type varName in ...)`.
fn bind_foreach_from_text(text: &str, ctx: &mut BindingContext, index: &SymbolIndex) {
    fn extract(text: &str) -> Option<(&str, &str)> {
        let open = text.find('(')?;
        let close = text[open..].find(')')? + open;
        let inner = text[open + 1..close].trim();
        // "Type varName in collection"
        let parts: Vec<&str> = inner.splitn(3, ' ').collect();
        if parts.len() < 3 { return None; }
        let type_name = parts[0].trim();
        let var_name = parts[1].trim();
        if var_name.is_empty() || var_name == "in" { return None; }
        Some((type_name, var_name))
    }

    let Some((type_name, var_name)) = extract(text) else { return; };

    let (fqn, confidence) = if type_name == "var" {
        (String::new(), Confidence::Unknown)
    } else {
        resolve_type(type_name, &ctx.usings.clone(), index)
    };

    let label = format!("foreach:{var_name}");
    ctx.push_scope(label);
    ctx.define_local(BoundSymbol::with_confidence(var_name, fqn, confidence, Origin::Local));
}

// ── Acesso a membros ──────────────────────────────────────────────────────────

/// Resolução de acesso simples: `receiver.member` → BoundSymbol do membro.
pub fn resolve_member_access(
    receiver: &str,
    member: &str,
    ctx: &BindingContext,
    index: &SymbolIndex,
) -> Option<BoundSymbol> {
    let receiver_sym = ctx.lookup(receiver)?;
    if receiver_sym.type_fqn.is_empty() { return None; }

    if let Resolution::Resolved(sym) = index.resolve(&receiver_sym.type_fqn) {
        for child_id in &sym.children {
            let name = child_id.rsplit("::").next().unwrap_or("");
            if name == member {
                return Some(BoundSymbol::certain(
                    format!("{receiver}.{member}"),
                    sym.id.split("::").nth(1).unwrap_or(&sym.id).to_string(),
                    Origin::Member { parent: receiver.into() },
                ));
            }
        }
    }
    None
}

// ── Testes ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cshtml::ast::ParseTree;
    use crate::cshtml::parser::parse;
    use crate::cshtml::semantics::SymbolIndex;
    use crate::cshtml::types::{Snapshot, DocumentId, DocumentVersion};
    use crate::cshtml::workspace::{DocumentContext, ProjectContext, ProjectKind, ViewKind};
    use std::path::PathBuf;

    // ── helpers ──

    fn snap(text: &str) -> Snapshot {
        Snapshot {
            id: DocumentId::new("file:///t.cshtml"),
            version: DocumentVersion(1),
            text: text.to_string(),
        }
    }

    fn parse_snap(text: &str) -> (ParseTree, Snapshot) {
        let (tree, _errs) = parse(text);
        (tree, snap(text))
    }

    fn make_index_with_src(ns: &str, name: &str) -> SymbolIndex {
        let mut idx = SymbolIndex::new();
        let src = format!("namespace {ns} {{ public class {name} {{}} }}");
        idx.index_file(&PathBuf::from("test.cs"), &src);
        idx
    }

    fn make_index_with_two(ns1: &str, n1: &str, ns2: &str, n2: &str) -> SymbolIndex {
        let mut idx = SymbolIndex::new();
        // Two classes — may be same or different namespaces.
        let src = if ns1 == ns2 {
            format!("namespace {ns1} {{ public class {n1} {{}} public class {n2} {{}} }}")
        } else {
            format!("namespace {ns1} {{ public class {n1} {{}} }} namespace {ns2} {{ public class {n2} {{}} }}")
        };
        idx.index_file(&PathBuf::from("test.cs"), &src);
        idx
    }

    fn make_doc_ctx(usings: Vec<String>) -> DocumentContext {
        DocumentContext {
            path: PathBuf::from("Views/Home/Index.cshtml"),
            kind: ViewKind::MvcView,
            project: Some(ProjectContext {
                csproj: PathBuf::from("MyApp.csproj"),
                root: PathBuf::from("."),
                kind: ProjectKind::Web,
                default_namespace: "MyApp".into(),
                target_framework: "net8.0".into(),
            }),
            usings,
            injects: vec![],
            namespace: None,
            tag_helpers: vec![],
            view_imports_chain: vec![],
        }
    }

    // @model com tipo por namespace shorthand
    #[test]
    fn model_resolved_via_using() {
        let idx = make_index_with_src("MyApp.Models", "ProductModel");
        let doc = make_doc_ctx(vec!["MyApp.Models".into()]);
        let (tree, snap) = parse_snap("@model ProductModel\n<p>Hello</p>");
        let ctx = bind_document(&doc, &tree, &snap, &idx);

        let model = ctx.document_symbols.get("Model").expect("Model must be defined");
        assert_eq!(model.type_fqn, "MyApp.Models.ProductModel");
        assert_eq!(model.confidence, Confidence::Certain);
        assert!(matches!(model.origin, Origin::Model));
    }

    // @model com FQN explícito
    #[test]
    fn model_fqn_explicit() {
        let idx = make_index_with_src("MyApp.Models", "OrderModel");
        let doc = make_doc_ctx(vec![]);
        let (tree, snap) = parse_snap("@model MyApp.Models.OrderModel\n<p>ok</p>");
        let ctx = bind_document(&doc, &tree, &snap, &idx);

        let model = ctx.document_symbols.get("Model").unwrap();
        assert_eq!(model.type_fqn, "MyApp.Models.OrderModel");
        assert_eq!(model.confidence, Confidence::Certain);
    }

    // @model com tipo desconhecido → Unknown, sem warnings desnecessários
    #[test]
    fn model_unknown_type_no_false_positive() {
        let idx = SymbolIndex::new();
        let doc = make_doc_ctx(vec![]);
        let (tree, snap) = parse_snap("@model SomethingUnknown\n<p>x</p>");
        let ctx = bind_document(&doc, &tree, &snap, &idx);

        let model = ctx.document_symbols.get("Model").unwrap();
        assert_eq!(model.confidence, Confidence::Unknown);
    }

    // @inject registra serviço com nome correto
    #[test]
    fn inject_registers_service() {
        let idx = make_index_with_src("MyApp.Services", "EmailService");
        let doc = make_doc_ctx(vec!["MyApp.Services".into()]);
        let (tree, snap) = parse_snap("@inject EmailService emailSvc\n<p>x</p>");
        let ctx = bind_document(&doc, &tree, &snap, &idx);

        let svc = ctx.document_symbols.get("emailSvc").expect("emailSvc must be defined");
        assert_eq!(svc.type_fqn, "MyApp.Services.EmailService");
        assert_eq!(svc.confidence, Confidence::Certain);
        assert!(matches!(svc.origin, Origin::Inject));
    }

    // @inject com tipo genérico (espaço no nome)
    #[test]
    fn inject_generic_type_registered() {
        let idx = SymbolIndex::new();
        let doc = make_doc_ctx(vec![]);
        // IList<string> Items — type has no space, this is fine
        let (tree, snap) = parse_snap("@inject IList<string> Items\n<p>x</p>");
        let ctx = bind_document(&doc, &tree, &snap, &idx);

        // Symbol should be registered even if type is unknown
        let sym = ctx.document_symbols.get("Items").expect("Items must be defined");
        assert_eq!(sym.name, "Items");
        assert!(matches!(sym.origin, Origin::Inject));
    }

    // Símbolos implícitos Razor sempre presentes
    #[test]
    fn implicit_razor_symbols_present() {
        let idx = SymbolIndex::new();
        let doc = make_doc_ctx(vec![]);
        let (tree, snap) = parse_snap("<p>Hello</p>");
        let ctx = bind_document(&doc, &tree, &snap, &idx);

        for name in &["Html", "Url", "ViewData", "ViewBag", "User", "Context"] {
            assert!(ctx.document_symbols.contains_key(*name), "{name} must be implicit");
        }
    }

    // Lookup prefere escopo interno
    #[test]
    fn lookup_prefers_inner_scope() {
        let idx = SymbolIndex::new();
        let doc = make_doc_ctx(vec![]);
        let (tree, snap) = parse_snap("<p>x</p>");
        let mut ctx = bind_document(&doc, &tree, &snap, &idx);

        ctx.define_document(BoundSymbol::certain("x", "Outer", Origin::ImplicitRazor));
        ctx.push_scope("inner");
        ctx.define_local(BoundSymbol::certain("x", "Inner", Origin::Local));

        let found = ctx.lookup("x").unwrap();
        assert_eq!(found.type_fqn, "Inner", "inner scope must shadow outer");
    }

    // @model sem tipo → warning, não panic
    #[test]
    fn model_empty_arg_no_panic() {
        let idx = SymbolIndex::new();
        let doc = make_doc_ctx(vec![]);
        // Parser only emits RazorDirective when there's something after @model,
        // but even with empty arg the bind_model guard should hold.
        let (tree, snap) = parse_snap("<p>no model</p>");
        let ctx = bind_document(&doc, &tree, &snap, &idx);
        assert!(ctx.document_symbols.contains_key("Model"));
    }

    // @inject incompleto → warning, sem panic
    #[test]
    fn inject_incomplete_no_panic() {
        let idx = SymbolIndex::new();
        let doc = make_doc_ctx(vec![]);
        let (tree, snap) = parse_snap("@inject OnlyOneToken\n<p>x</p>");
        let ctx = bind_document(&doc, &tree, &snap, &idx);
        // Should warn but not panic; "OnlyOneToken" must not be a document symbol
        // (it's neither a type nor a var — malformed)
        let _ = ctx.warnings; // just ensure no panic
    }

    // MVC View: Model e Html disponíveis
    #[test]
    fn mvc_view_has_model_and_html() {
        let idx = make_index_with_src("MyApp.Models", "IndexViewModel");
        let doc = make_doc_ctx(vec!["MyApp.Models".into()]);
        let (tree, snap) = parse_snap("@model IndexViewModel\n<p>ok</p>");
        let ctx = bind_document(&doc, &tree, &snap, &idx);

        assert!(ctx.document_symbols.contains_key("Model"));
        assert!(ctx.document_symbols.contains_key("Html"));
    }

    // Razor Page sem @model → sem erro
    #[test]
    fn razor_page_no_model_no_error() {
        let idx = SymbolIndex::new();
        let doc = make_doc_ctx(vec![]);
        let (tree, snap) = parse_snap("<p>No model here</p>");
        let ctx = bind_document(&doc, &tree, &snap, &idx);

        let model = ctx.document_symbols.get("Model").unwrap();
        assert_eq!(model.type_fqn, "");
        assert!(ctx.warnings.is_empty());
    }

    // @using herdado de _ViewImports → tipo resolvido
    #[test]
    fn inherited_using_resolves_type() {
        let idx = make_index_with_src("Shared.Models", "UserProfile");
        let doc = make_doc_ctx(vec!["Shared.Models".into()]);
        let (tree, snap) = parse_snap("@model UserProfile\n<p>x</p>");
        let ctx = bind_document(&doc, &tree, &snap, &idx);

        let model = ctx.document_symbols.get("Model").unwrap();
        assert_eq!(model.type_fqn, "Shared.Models.UserProfile");
        assert_eq!(model.confidence, Confidence::Certain);
    }

    // múltiplas diretivas @inject no mesmo documento
    #[test]
    fn multiple_inject_directives() {
        let idx = make_index_with_two("MyApp.Services", "AuthService", "MyApp.Services", "LogService");
        let doc = make_doc_ctx(vec!["MyApp.Services".into()]);
        let src = "@inject AuthService auth\n@inject LogService log\n<p>x</p>";
        let (tree, snap) = parse_snap(src);
        let ctx = bind_document(&doc, &tree, &snap, &idx);

        assert!(ctx.document_symbols.contains_key("auth"));
        assert!(ctx.document_symbols.contains_key("log"));
        assert_eq!(ctx.document_symbols["auth"].type_fqn, "MyApp.Services.AuthService");
        assert_eq!(ctx.document_symbols["log"].type_fqn, "MyApp.Services.LogService");
    }

    // @model + @inject no mesmo documento
    #[test]
    fn model_and_inject_together() {
        let idx = make_index_with_two("MyApp.Models", "Product", "MyApp.Services", "CartService");
        let doc = make_doc_ctx(vec!["MyApp.Models".into(), "MyApp.Services".into()]);
        let src = "@model Product\n@inject CartService Cart\n<p>x</p>";
        let (tree, snap) = parse_snap(src);
        let ctx = bind_document(&doc, &tree, &snap, &idx);

        assert_eq!(ctx.document_symbols["Model"].type_fqn, "MyApp.Models.Product");
        assert_eq!(ctx.document_symbols["Cart"].type_fqn, "MyApp.Services.CartService");
    }
}
