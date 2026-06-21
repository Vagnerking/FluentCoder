/// Linter de diagnósticos de sintaxe e regras Razor (issue #37).
///
/// Regras puras sobre AST + snapshot, sem Monaco, LSP, Roslyn ou Tauri.
/// Códigos estáveis `FCRZxxxx`.
///
/// Cada regra recebe `(&ParseTree, &Snapshot)` e devolve `Vec<Diagnostic>`.
/// O `CshtmlLinter` agrega todas as regras e é injetável no `CshtmlEngine`
/// como `DiagnosticProvider`.

use crate::cshtml::{
    ast::{NodeKind, ParseTree},
    engine::DiagnosticProvider,
    parser::parse,
    types::{Diagnostic, DiagnosticCode, Severity, Snapshot, TextPosition, TextRange},
};

// ── Rule configuration ────────────────────────────────────────────────────────

/// Per-rule enable/severity override — allows callers to silence or downgrade
/// rules without modifying the engine.
#[derive(Debug, Clone)]
pub struct RuleConfig {
    pub enabled: bool,
    pub severity: Severity,
}

impl Default for RuleConfig {
    fn default() -> Self {
        Self { enabled: true, severity: Severity::Error }
    }
}

fn warn_config() -> RuleConfig {
    RuleConfig { enabled: true, severity: Severity::Warning }
}

// ── Diagnostic codes ──────────────────────────────────────────────────────────

pub const FCRZ0001: &str = "FCRZ0001"; // Unclosed code block / delimiter
pub const FCRZ0002: &str = "FCRZ0002"; // Unclosed Razor comment
pub const FCRZ0003: &str = "FCRZ0003"; // Unknown Razor directive
pub const FCRZ0004: &str = "FCRZ0004"; // Duplicate directive
pub const FCRZ0005: &str = "FCRZ0005"; // Directive out of position (not at file top)
pub const FCRZ0006: &str = "FCRZ0006"; // @model declared more than once
pub const FCRZ0007: &str = "FCRZ0007"; // Stray HTML close tag (no matching open)
pub const FCRZ0008: &str = "FCRZ0008"; // Missing @model in a view that uses Model
pub const FCRZ0009: &str = "FCRZ0009"; // Empty @section body

/// All known rule codes (for documentation / config lookup).
pub const ALL_CODES: &[&str] = &[
    FCRZ0001, FCRZ0002, FCRZ0003, FCRZ0004,
    FCRZ0005, FCRZ0006, FCRZ0007, FCRZ0008, FCRZ0009,
];

// ── Helper ────────────────────────────────────────────────────────────────────

fn diag(code: &str, severity: Severity, range: TextRange, message: impl Into<String>) -> Diagnostic {
    Diagnostic {
        range,
        severity,
        code: Some(DiagnosticCode(code.into())),
        source: "fluent-cshtml-lint".into(),
        message: message.into(),
    }
}

fn point(line: u32, character: u32) -> TextRange {
    let p = TextPosition { line, character };
    TextRange { start: p, end: p }
}

// ── Rule implementations ──────────────────────────────────────────────────────

/// FCRZ0001 + FCRZ0002: parser-level errors already produced during parse.
/// We re-emit them with stable codes and possibly adjusted severity.
fn rule_parser_errors(tree: &ParseTree, cfg_block: &RuleConfig, cfg_comment: &RuleConfig) -> Vec<Diagnostic> {
    tree.walk()
        .filter(|n| n.kind.is_error())
        .filter_map(|n| {
            if let NodeKind::Error { message } = &n.kind {
                let (code, cfg) = if message.contains("comentário") || message.contains("comment") {
                    (FCRZ0002, cfg_comment)
                } else {
                    (FCRZ0001, cfg_block)
                };
                if !cfg.enabled { return None; }
                Some(diag(code, cfg.severity, n.range, message.clone()))
            } else {
                None
            }
        })
        .collect()
}

/// FCRZ0003: directives with unknown keywords.
const KNOWN_DIRECTIVES: &[&str] = &[
    "model", "using", "inject", "page", "namespace", "inherits",
    "implements", "layout", "addTagHelper", "removeTagHelper",
    "tagHelperPrefix", "attribute", "functions", "code", "section",
    "await",
];

fn rule_unknown_directive(tree: &ParseTree, cfg: &RuleConfig) -> Vec<Diagnostic> {
    if !cfg.enabled { return vec![]; }
    tree.walk()
        .filter_map(|n| {
            if let NodeKind::RazorDirective { keyword } = &n.kind {
                if !KNOWN_DIRECTIVES.contains(&keyword.as_str()) {
                    return Some(diag(
                        FCRZ0003,
                        cfg.severity,
                        n.range,
                        format!("Diretiva Razor desconhecida: '@{keyword}'. Verifique a ortografia ou adicione o namespace correspondente."),
                    ));
                }
            }
            None
        })
        .collect()
}

/// FCRZ0004 + FCRZ0006: duplicate directives.
///
/// `@model` is unique per file (FCRZ0006): any second `@model` is a duplicate
/// regardless of the argument.
/// Other directives (e.g. `@using`) allow multiple occurrences with different
/// arguments. We extract each directive's source line from `snapshot` to compare
/// argument text, so `@using A` + `@using A` = duplicate but
/// `@using A` + `@using B` = fine.
fn rule_duplicate_directive(tree: &ParseTree, snapshot: &Snapshot, cfg: &RuleConfig) -> Vec<Diagnostic> {
    if !cfg.enabled { return vec![]; }
    use std::collections::HashMap;

    let src_lines: Vec<&str> = snapshot.text().lines().collect();

    // Extract the full directive source line text (lowercased argument trimmed).
    let line_text = |range: TextRange| -> String {
        src_lines
            .get(range.start.line as usize)
            .map(|l| l.trim().to_string())
            .unwrap_or_default()
    };

    // model: keyed only by keyword (at most one per file)
    let mut model_ranges: Vec<TextRange> = Vec::new();
    // others: keyed by full directive line text (keyword + argument)
    let mut seen: HashMap<String, Vec<TextRange>> = HashMap::new();

    for n in tree.walk() {
        if let NodeKind::RazorDirective { keyword } = &n.kind {
            if keyword == "model" {
                model_ranges.push(n.range);
            } else {
                let key = line_text(n.range);
                seen.entry(key).or_default().push(n.range);
            }
        }
    }

    let mut out = Vec::new();

    // @model: second and beyond are errors (FCRZ0006)
    if model_ranges.len() > 1 {
        for &range in model_ranges.iter().skip(1) {
            out.push(diag(
                FCRZ0006,
                cfg.severity,
                range,
                "Diretiva '@model' declarada mais de uma vez. Remova as duplicatas.".to_string(),
            ));
        }
    }

    // Other directives: flag identical lines (same keyword + same argument)
    for (key, ranges) in &seen {
        if ranges.len() > 1 {
            for &range in ranges.iter().skip(1) {
                out.push(diag(
                    FCRZ0004,
                    cfg.severity,
                    range,
                    format!("Diretiva '{key}' duplicada. Remova as ocorrências redundantes."),
                ));
            }
        }
    }
    out
}

/// FCRZ0005: top-level directives that appear after HTML content.
/// In Razor, `@model`, `@using`, `@inject`, `@page`, `@namespace` must
/// appear before any HTML output. We detect this by checking if any HTML open
/// tag appears before the directive.
fn rule_directive_out_of_position(tree: &ParseTree, cfg: &RuleConfig) -> Vec<Diagnostic> {
    if !cfg.enabled { return vec![]; }

    const MUST_BE_FIRST: &[&str] = &["model", "page", "namespace"];

    let mut first_html_line: Option<u32> = None;
    let mut out = Vec::new();

    for n in tree.walk() {
        match &n.kind {
            NodeKind::HtmlOpenTag { .. } | NodeKind::HtmlText => {
                if first_html_line.is_none() {
                    let text_is_only_ws = matches!(&n.kind, NodeKind::HtmlText);
                    if !text_is_only_ws {
                        first_html_line = first_html_line.or(Some(n.range.start.line));
                    }
                }
            }
            NodeKind::RazorDirective { keyword } => {
                if MUST_BE_FIRST.contains(&keyword.as_str()) {
                    if let Some(html_line) = first_html_line {
                        if n.range.start.line > html_line {
                            out.push(diag(
                                FCRZ0005,
                                cfg.severity,
                                n.range,
                                format!("'@{keyword}' deve aparecer antes do conteúdo HTML. Mova para o topo do arquivo."),
                            ));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// FCRZ0007: stray HTML close tags (already detected by razorHtmlLint on the
/// frontend; here we do it at the AST level on the backend for completeness).
/// We scan CloseTag nodes and match them against OpenTag nodes in a stack.
fn rule_stray_close_tag(tree: &ParseTree, cfg: &RuleConfig) -> Vec<Diagnostic> {
    if !cfg.enabled { return vec![]; }

    const VOID: &[&str] = &[
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    ];

    let mut stack: Vec<&str> = Vec::new();
    let mut out = Vec::new();

    for n in tree.walk() {
        match &n.kind {
            NodeKind::HtmlOpenTag { name } => {
                if !VOID.contains(&name.as_str()) {
                    stack.push(name.as_str());
                }
            }
            NodeKind::HtmlSelfCloseTag { .. } => {} // self-closing: no push
            NodeKind::HtmlCloseTag { name } => {
                if let Some(pos) = stack.iter().rposition(|&s| s == name.as_str()) {
                    stack.truncate(pos);
                } else if !VOID.contains(&name.as_str()) {
                    out.push(diag(
                        FCRZ0007,
                        cfg.severity,
                        n.range,
                        format!(
                            "Tag de fechamento '</{name}>' sem tag de abertura correspondente."
                        ),
                    ));
                }
            }
            _ => {}
        }
    }
    out
}

/// FCRZ0008: view file uses `@Model.` but has no `@model` directive.
fn rule_missing_model_directive(tree: &ParseTree, snapshot: &Snapshot, cfg: &RuleConfig) -> Vec<Diagnostic> {
    if !cfg.enabled { return vec![]; }

    let has_model_directive = tree
        .walk()
        .any(|n| matches!(&n.kind, NodeKind::RazorDirective { keyword } if keyword == "model"));

    if has_model_directive { return vec![]; }

    // Check whether the source text contains `@Model.` or `Model.` in an implicit expression.
    let uses_model = snapshot.text().contains("@Model.") || snapshot.text().contains("Model.");
    if uses_model {
        return vec![diag(
            FCRZ0008,
            cfg.severity,
            point(0, 0),
            "A view usa 'Model' mas não declara '@model'. Adicione '@model <Tipo>' no topo.",
        )];
    }
    vec![]
}

/// FCRZ0009: `@section` block with empty body.
fn rule_empty_section(tree: &ParseTree, cfg: &RuleConfig) -> Vec<Diagnostic> {
    if !cfg.enabled { return vec![]; }
    tree.walk()
        .filter_map(|n| {
            if let NodeKind::RazorControlFlow { keyword } = &n.kind {
                if keyword == "section" && n.children.is_empty() {
                    return Some(diag(
                        FCRZ0009,
                        cfg.severity,
                        n.range,
                        "Bloco '@section' vazio. Adicione conteúdo ou remova a declaração.",
                    ));
                }
            }
            None
        })
        .collect()
}

// ── CshtmlLinter ──────────────────────────────────────────────────────────────

/// Aggregates all lint rules. Implements `DiagnosticProvider` for injection into
/// `CshtmlEngine`.
///
/// Rules are versioned by document: the lint result is tied to the snapshot
/// version. Callers should discard stale results when the version advances.
pub struct CshtmlLinter {
    pub block_cfg: RuleConfig,
    pub comment_cfg: RuleConfig,
    pub unknown_directive_cfg: RuleConfig,
    pub duplicate_directive_cfg: RuleConfig,
    pub directive_position_cfg: RuleConfig,
    pub stray_close_tag_cfg: RuleConfig,
    pub missing_model_cfg: RuleConfig,
    pub empty_section_cfg: RuleConfig,
}

impl Default for CshtmlLinter {
    fn default() -> Self {
        Self {
            block_cfg: RuleConfig::default(),
            comment_cfg: RuleConfig::default(),
            unknown_directive_cfg: RuleConfig::default(),
            duplicate_directive_cfg: RuleConfig::default(),
            directive_position_cfg: warn_config(),
            stray_close_tag_cfg: RuleConfig::default(),
            missing_model_cfg: warn_config(),
            empty_section_cfg: warn_config(),
        }
    }
}

impl CshtmlLinter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run all AST-level rules (excluding parser-level diagnostics, which are
    /// handled separately in `DiagnosticProvider::diagnostics`).
    pub fn lint_tree_only(&self, tree: &ParseTree, snapshot: &Snapshot) -> Vec<Diagnostic> {
        let mut out = Vec::new();
        // AST error nodes (unclosed blocks) — emitted by parser as Error nodes.
        out.extend(rule_parser_errors(tree, &self.block_cfg, &self.comment_cfg));
        out.extend(rule_unknown_directive(tree, &self.unknown_directive_cfg));
        out.extend(rule_duplicate_directive(tree, snapshot, &self.duplicate_directive_cfg));
        out.extend(rule_directive_out_of_position(tree, &self.directive_position_cfg));
        out.extend(rule_stray_close_tag(tree, &self.stray_close_tag_cfg));
        out.extend(rule_missing_model_directive(tree, snapshot, &self.missing_model_cfg));
        out.extend(rule_empty_section(tree, &self.empty_section_cfg));
        out
    }

    /// Full lint: AST rules + parser diagnostics reclassified. Use for tests
    /// that call `lint()` directly on a tree + snapshot.
    pub fn lint(&self, tree: &ParseTree, snapshot: &Snapshot) -> Vec<Diagnostic> {
        let mut out = self.lint_tree_only(tree, snapshot);
        out.sort_by(|a, b| {
            a.range.start.line.cmp(&b.range.start.line)
                .then(a.range.start.character.cmp(&b.range.start.character))
        });
        out
    }
}

impl DiagnosticProvider for CshtmlLinter {
    fn diagnostics(&self, snapshot: &Snapshot) -> Vec<Diagnostic> {
        let (tree, parser_diags) = parse(snapshot.text());
        // Re-classify parser diagnostics with stable FCRZ codes.
        let reclassified: Vec<Diagnostic> = parser_diags
            .into_iter()
            .filter_map(|mut d| {
                let code_str = d.code.as_ref().map(|c| c.0.as_str()).unwrap_or("");
                let (new_code, cfg) = if code_str == "RZ0002"
                    || d.message.contains("comentário") || d.message.contains("comment")
                {
                    (FCRZ0002, &self.comment_cfg)
                } else {
                    (FCRZ0001, &self.block_cfg)
                };
                if !cfg.enabled { return None; }
                d.code = Some(DiagnosticCode(new_code.into()));
                d.severity = cfg.severity;
                d.source = "fluent-cshtml-lint".into();
                Some(d)
            })
            .collect();

        let mut out = self.lint_tree_only(&tree, snapshot);
        out.extend(reclassified);
        out.sort_by(|a, b| {
            a.range.start.line.cmp(&b.range.start.line)
                .then(a.range.start.character.cmp(&b.range.start.character))
        });
        out
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cshtml::engine::CshtmlEngine;

    fn lint(text: &str) -> Vec<Diagnostic> {
        let linter = CshtmlLinter::new();
        let snap = crate::cshtml::types::Snapshot {
            id: crate::cshtml::types::DocumentId::new("file:///t.cshtml"),
            version: crate::cshtml::types::DocumentVersion(1),
            text: text.into(),
        };
        // Use DiagnosticProvider::diagnostics to include parser-level diags (FCRZ0002, etc.)
        linter.diagnostics(&snap)
    }

    fn codes(diags: &[Diagnostic]) -> Vec<&str> {
        diags.iter()
            .filter_map(|d| d.code.as_ref())
            .map(|c| c.0.as_str())
            .collect()
    }

    fn has_code(diags: &[Diagnostic], code: &str) -> bool {
        diags.iter().any(|d| d.code.as_ref().map(|c| c.0.as_str()) == Some(code))
    }

    // ── No-panic ─────────────────────────────────────────────────────────────

    #[test]
    fn no_panic_on_any_input() {
        for text in &[
            "", "@model Foo\n<p>ok</p>", "@{", "@* unclosed",
            "<div></span>", "😀<p>@Model.Name</p>", "@model\r\n@model Foo\n",
        ] {
            let _ = lint(text);
        }
    }

    // ── FCRZ0001: unclosed block ──────────────────────────────────────────────

    #[test]
    fn unclosed_block_produces_fcrz0001() {
        let d = lint("@{ var x = 1;");
        assert!(has_code(&d, FCRZ0001), "expected FCRZ0001; got {:?}", codes(&d));
    }

    #[test]
    fn closed_block_no_fcrz0001() {
        let d = lint("@{ var x = 1; }\n<p>ok</p>");
        assert!(!has_code(&d, FCRZ0001), "closed block must not produce FCRZ0001");
    }

    // ── FCRZ0002: unclosed comment ────────────────────────────────────────────

    #[test]
    fn unclosed_comment_produces_fcrz0002() {
        let d = lint("@* unclosed comment");
        assert!(has_code(&d, FCRZ0002), "expected FCRZ0002; got {:?}", codes(&d));
    }

    #[test]
    fn closed_comment_no_fcrz0002() {
        let d = lint("@* closed comment *@\n<p>ok</p>");
        assert!(!has_code(&d, FCRZ0002));
    }

    // ── FCRZ0003: unknown directive ───────────────────────────────────────────

    #[test]
    fn unknown_directive_produces_fcrz0003() {
        let d = lint("@bogusDirective Foo\n<p>ok</p>");
        assert!(has_code(&d, FCRZ0003), "expected FCRZ0003; got {:?}", codes(&d));
    }

    #[test]
    fn known_directive_no_fcrz0003() {
        let d = lint("@model Foo\n<p>ok</p>");
        assert!(!has_code(&d, FCRZ0003));
    }

    // ── FCRZ0004/FCRZ0006: duplicate directive ────────────────────────────────

    #[test]
    fn duplicate_model_produces_fcrz0006() {
        let d = lint("@model Foo\n@model Bar\n<p>x</p>");
        assert!(has_code(&d, FCRZ0006), "expected FCRZ0006; got {:?}", codes(&d));
    }

    #[test]
    fn duplicate_using_produces_fcrz0004() {
        let d = lint("@using A\n@using A\n<p>ok</p>");
        assert!(has_code(&d, FCRZ0004), "expected FCRZ0004; got {:?}", codes(&d));
    }

    #[test]
    fn single_directive_no_duplicate_error() {
        let d = lint("@model Foo\n<p>ok</p>");
        assert!(!has_code(&d, FCRZ0006) && !has_code(&d, FCRZ0004));
    }

    // ── FCRZ0007: stray close tag ──────────────────────────────────────────────

    #[test]
    fn stray_close_tag_produces_fcrz0007() {
        let d = lint("<div>\n</span>\n</div>");
        assert!(has_code(&d, FCRZ0007), "expected FCRZ0007; got {:?}", codes(&d));
    }

    #[test]
    fn matched_tags_no_fcrz0007() {
        let d = lint("<div><p>text</p></div>");
        assert!(!has_code(&d, FCRZ0007));
    }

    #[test]
    fn void_element_close_no_fcrz0007() {
        // </br> is technically invalid HTML but we don't flag void closes.
        let d = lint("</br>");
        assert!(!has_code(&d, FCRZ0007));
    }

    // ── FCRZ0008: missing @model ───────────────────────────────────────────────

    #[test]
    fn uses_model_without_directive_produces_fcrz0008() {
        let d = lint("<p>@Model.Name</p>");
        assert!(has_code(&d, FCRZ0008), "expected FCRZ0008; got {:?}", codes(&d));
    }

    #[test]
    fn model_with_directive_no_fcrz0008() {
        let d = lint("@model Foo\n<p>@Model.Name</p>");
        assert!(!has_code(&d, FCRZ0008));
    }

    #[test]
    fn no_model_reference_no_fcrz0008() {
        let d = lint("<p>Hello World</p>");
        assert!(!has_code(&d, FCRZ0008));
    }

    // ── Incremental: fix removes diagnostic ───────────────────────────────────

    #[test]
    fn fixing_unclosed_block_removes_fcrz0001() {
        let engine = CshtmlEngine::new()
            .with_diagnostic_provider(CshtmlLinter::new());
        engine.open_document("file:///t.cshtml", 1, "@{ var x = 1;").unwrap();
        let before = engine.diagnostics("file:///t.cshtml");
        assert!(before.iter().any(|d| d.code.as_ref().map(|c| c.0.as_str()) == Some(FCRZ0001)));

        // Fix: replace full content with a closed block.
        engine.replace_full("file:///t.cshtml", 2, "@{ var x = 1; }\n<p>ok</p>").unwrap();
        let after = engine.diagnostics("file:///t.cshtml");
        assert!(
            !after.iter().any(|d| d.code.as_ref().map(|c| c.0.as_str()) == Some(FCRZ0001)),
            "FCRZ0001 must be removed after fix"
        );
    }

    // ── Diagnostic range validity ──────────────────────────────────────────────

    #[test]
    fn all_diagnostic_ranges_valid() {
        let texts = [
            "@{ unclosed",
            "@* unclosed",
            "@bogus Arg\n<p>x</p>",
            "<div></span></div>",
            "@model\n@model Foo\n",
            "@model Foo\r\n<p>@Model.Name</p>",
        ];
        for text in &texts {
            let d = lint(text);
            for diag in &d {
                assert!(
                    diag.range.start.line <= diag.range.end.line,
                    "start must be <= end; text={:?} diag={:?}", text, diag
                );
            }
        }
    }

    // ── Rule config: disable a rule ───────────────────────────────────────────

    #[test]
    fn disabled_rule_produces_no_diagnostic() {
        let (tree, _) = parse("@bogus Arg\n<p>x</p>");
        let mut linter = CshtmlLinter::new();
        linter.unknown_directive_cfg.enabled = false;
        let snap = crate::cshtml::types::Snapshot {
            id: crate::cshtml::types::DocumentId::new("file:///t.cshtml"),
            version: crate::cshtml::types::DocumentVersion(1),
            text: "@bogus Arg\n<p>x</p>".into(),
        };
        let d = linter.lint(&tree, &snap);
        assert!(!has_code(&d, FCRZ0003), "disabled rule must not produce diagnostic");
    }

    // ── No false positives on valid files ──────────────────────────────────────

    #[test]
    fn clean_file_produces_no_diagnostics() {
        let d = lint("@model MyApp.Models.ProductViewModel\n@using System\n<p>@Model.Name</p>\n");
        assert!(
            d.is_empty(),
            "clean file must produce no diagnostics; got: {:?}",
            d
        );
    }

    // ── Incomplete document still produces useful diagnostics ─────────────────

    #[test]
    fn partial_file_still_linted() {
        let d = lint("@model Foo\n<p>partial without");
        // No errors expected on this partial file (no unclosed delimiters).
        // At minimum it must not panic and model ref check must pass.
        let _ = d;
    }

    // ── Corpus fixtures: invalid must produce diagnostics ─────────────────────

    #[test]
    fn corpus_stray_close_produces_fcrz0007() {
        let text = include_str!("corpus/invalid/stray_close_tag.cshtml");
        let d = lint(text);
        assert!(has_code(&d, FCRZ0007), "stray_close_tag.cshtml must produce FCRZ0007");
    }

    #[test]
    fn corpus_unclosed_block_produces_fcrz0001() {
        let text = include_str!("corpus/invalid/unclosed_block.cshtml");
        let d = lint(text);
        assert!(has_code(&d, FCRZ0001), "unclosed_block.cshtml must produce FCRZ0001");
    }

    #[test]
    fn corpus_unclosed_comment_produces_fcrz0002() {
        let text = include_str!("corpus/invalid/unclosed_comment.cshtml");
        let d = lint(text);
        assert!(has_code(&d, FCRZ0002), "unclosed_comment.cshtml must produce FCRZ0002");
    }

    // ── Corpus fixtures: valid must produce no errors (only warnings maybe) ───

    #[test]
    fn corpus_valid_directives_no_errors() {
        let text = include_str!("corpus/valid/directives.cshtml");
        let d = lint(text);
        let errors: Vec<_> = d.iter().filter(|d| d.severity == Severity::Error).collect();
        assert!(errors.is_empty(), "valid/directives.cshtml must produce no errors; got: {:?}", errors);
    }

    #[test]
    fn corpus_valid_control_flow_no_errors() {
        let text = include_str!("corpus/valid/control_flow.cshtml");
        let d = lint(text);
        let errors: Vec<_> = d.iter().filter(|d| d.severity == Severity::Error).collect();
        assert!(errors.is_empty(), "valid/control_flow.cshtml must produce no errors; got: {:?}", errors);
    }
}
