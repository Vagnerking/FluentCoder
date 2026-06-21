/// Razor/CSHTML parser — incremental, error-tolerant, no-panic (issue #35).
///
/// Architecture:
/// - Operates on the UTF-8 text of a `Snapshot`.
/// - Returns a `ParseTree` (project-owned AST) plus a flat `Vec<Diagnostic>`
///   for parse-level errors.
/// - No Tree-sitter or regex as primary source — hand-written recursive descent.
/// - "Incremental" is achieved by re-parsing the whole document on each edit
///   (cheap for typical view sizes ≤ 500 lines). Full tree-sitter incremental
///   reparsing can be wired later without breaking any consumer.
/// - Never panics on any input, including empty, partial, or Unicode-heavy text.

use crate::cshtml::{
    ast::{Node, NodeKind, ParseTree},
    types::{Diagnostic, DiagnosticCode, Severity, TextPosition, TextRange},
};

// ── Public API ────────────────────────────────────────────────────────────────

/// Parse `text` and return `(tree, diagnostics)`.
/// This is the entry point used by `CshtmlEngine` and the harness.
pub fn parse(text: &str) -> (ParseTree, Vec<Diagnostic>) {
    let mut ctx = ParseCtx::new(text);
    ctx.parse_document();
    (ParseTree { nodes: ctx.nodes }, ctx.diagnostics)
}

// ── Parser context ────────────────────────────────────────────────────────────

struct ParseCtx {
    chars: Vec<char>, // pre-collected so we can index cheaply
    pos: usize,       // current char offset
    nodes: Vec<Node>,
    diagnostics: Vec<Diagnostic>,
}

impl ParseCtx {
    fn new(text: &str) -> Self {
        Self {
            chars: text.chars().collect(),
            pos: 0,
            nodes: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    // ── Primitives ────────────────────────────────────────────────────────────

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek2(&self) -> Option<char> {
        self.chars.get(self.pos + 1).copied()
    }

    fn advance(&mut self) -> Option<char> {
        let ch = self.chars.get(self.pos).copied();
        if ch.is_some() {
            self.pos += 1;
        }
        ch
    }

    fn at_end(&self) -> bool {
        self.pos >= self.chars.len()
    }

    fn match_str(&self, s: &str) -> bool {
        let chs: Vec<char> = s.chars().collect();
        self.chars[self.pos..].starts_with(&chs)
    }

    fn consume_str(&mut self, s: &str) -> bool {
        if self.match_str(s) {
            let n = s.chars().count();
            self.pos += n;
            true
        } else {
            false
        }
    }

    // ── Position tracking (char-offset → line/char in UTF-16) ────────────────

    /// Converts `char_offset` (index into `self.chars`) to a `TextPosition`
    /// using UTF-16 code unit offsets per line.
    fn char_to_position(&self, char_offset: usize) -> TextPosition {
        let limit = char_offset.min(self.chars.len());
        let mut line = 0u32;
        let mut col_utf16 = 0u32;
        for &ch in &self.chars[..limit] {
            if ch == '\n' {
                line += 1;
                col_utf16 = 0;
            } else {
                col_utf16 += ch.len_utf16() as u32;
            }
        }
        TextPosition { line, character: col_utf16 }
    }

    fn current_position(&self) -> TextPosition {
        self.char_to_position(self.pos)
    }

    fn range_from(&self, start_char: usize) -> TextRange {
        TextRange {
            start: self.char_to_position(start_char),
            end: self.current_position(),
        }
    }

    fn push_node(&mut self, kind: NodeKind, start: usize, children: Vec<usize>) -> usize {
        let range = self.range_from(start);
        let idx = self.nodes.len();
        self.nodes.push(Node { kind, range, children });
        idx
    }

    fn error_at(&mut self, start: usize, msg: impl Into<String>) -> usize {
        let range = self.range_from(start);
        let msg = msg.into();
        self.diagnostics.push(Diagnostic {
            range,
            severity: Severity::Error,
            code: Some(DiagnosticCode("RZ0001".into())),
            source: "fluent-cshtml-parser".into(),
            message: msg.clone(),
        });
        let idx = self.nodes.len();
        self.nodes.push(Node {
            kind: NodeKind::Error { message: msg },
            range,
            children: vec![],
        });
        idx
    }

    // ── Document root ─────────────────────────────────────────────────────────

    fn parse_document(&mut self) {
        let start = self.pos;
        let mut children = Vec::new();

        while !self.at_end() {
            if let Some(child) = self.parse_node() {
                children.push(child);
            }
        }

        let range = self.range_from(start);
        // Always insert Document at index 0.
        self.nodes.insert(
            0,
            Node { kind: NodeKind::Document, range, children },
        );
        // Shift all child indices by 1 (Document was prepended).
        // The nodes pushed during parsing are 0-based; Document root is at 0.
        // Re-index: the document root already holds the correct indices into
        // the sub-vec; we just prepend it. But because we inserted at 0,
        // existing node indices shift. Fix by post-processing:
        self.fix_indices_after_prepend();
    }

    /// After inserting Document at index 0, all previously-assigned node
    /// indices (which were 0-based) need to be bumped by 1.
    fn fix_indices_after_prepend(&mut self) {
        for i in 1..self.nodes.len() {
            for child in &mut self.nodes[i].children {
                *child += 1;
            }
        }
        // Fix Document root's children too.
        for child in &mut self.nodes[0].children.clone() {
            self.nodes[0].children = self.nodes[0]
                .children
                .iter()
                .map(|&c| c + 1)
                .collect();
            let _ = child; // suppress unused warning
            break; // only need to do this once
        }
    }

    // ── Top-level node dispatch ───────────────────────────────────────────────

    fn parse_node(&mut self) -> Option<usize> {
        let ch = self.peek()?;
        match ch {
            '@' => Some(self.parse_razor()),
            '<' => Some(self.parse_html_node()),
            _ => Some(self.parse_text()),
        }
    }

    // ── Text / whitespace ─────────────────────────────────────────────────────

    fn parse_text(&mut self) -> usize {
        let start = self.pos;
        while let Some(ch) = self.peek() {
            if ch == '@' || ch == '<' {
                break;
            }
            self.advance();
        }
        self.push_node(NodeKind::HtmlText, start, vec![])
    }

    // ── Razor ─────────────────────────────────────────────────────────────────

    fn parse_razor(&mut self) -> usize {
        let start = self.pos;
        self.advance(); // consume '@'

        match self.peek() {
            // @@ escape
            Some('@') => {
                self.advance();
                self.push_node(NodeKind::RazorEscape, start, vec![])
            }
            // @* comment *@
            Some('*') => self.parse_razor_comment(start),
            // @{ code block }
            Some('{') => self.parse_razor_code_block(start),
            // @( explicit expression )
            Some('(') => self.parse_razor_explicit_expr(start),
            // keyword or identifier → directive or control flow or implicit expr
            Some(ch) if ch.is_alphabetic() || ch == '_' => {
                self.parse_razor_keyword_or_expr(start)
            }
            // Lone '@' with no recognized follow — emit text node
            _ => self.push_node(NodeKind::HtmlText, start, vec![]),
        }
    }

    // @* … *@
    fn parse_razor_comment(&mut self, start: usize) -> usize {
        self.advance(); // '*'
        loop {
            if self.at_end() {
                let range = self.range_from(start);
                self.diagnostics.push(Diagnostic {
                    range,
                    severity: Severity::Error,
                    code: Some(DiagnosticCode("RZ0002".into())),
                    source: "fluent-cshtml-parser".into(),
                    message: "Comentário Razor não fechado — falta '*@'.".into(),
                });
                break;
            }
            if self.match_str("*@") {
                self.pos += 2; // consume '*@'
                break;
            }
            self.advance();
        }
        self.push_node(NodeKind::RazorComment, start, vec![])
    }

    // @{ … }
    fn parse_razor_code_block(&mut self, start: usize) -> usize {
        self.advance(); // '{'
        let children = self.parse_csharp_block('{', '}');
        match children {
            Ok(ch) => self.push_node(NodeKind::RazorCodeBlock, start, ch),
            Err(_) => self.error_at(
                start,
                "Bloco de código Razor não fechado — falta '}'.".to_string(),
            ),
        }
    }

    // @( … )
    fn parse_razor_explicit_expr(&mut self, start: usize) -> usize {
        self.advance(); // '('
        let _ = self.parse_balanced('(', ')');
        self.push_node(NodeKind::RazorExplicitExpression, start, vec![])
    }

    // @keyword or @identifier
    fn parse_razor_keyword_or_expr(&mut self, start: usize) -> usize {
        let kw = self.read_identifier();

        // Control flow keywords that take a block
        const CONTROL_FLOW: &[&str] = &[
            "if", "else", "for", "foreach", "while", "do", "switch", "try", "lock",
            "catch", "finally",
        ];
        // Directive keywords (single-line)
        const DIRECTIVES: &[&str] = &[
            "model", "using", "inject", "page", "namespace", "inherits",
            "implements", "layout", "addTagHelper", "removeTagHelper",
            "tagHelperPrefix", "attribute", "functions", "code", "section",
            "await",
        ];

        if CONTROL_FLOW.contains(&kw.as_str()) {
            return self.parse_control_flow(start, kw);
        }
        if DIRECTIVES.contains(&kw.as_str()) {
            return self.parse_directive(start, kw);
        }

        // Implicit expression: @identifier(.…)*
        self.parse_implicit_expr_tail(start)
    }

    fn read_identifier(&mut self) -> String {
        let mut id = String::new();
        while let Some(ch) = self.peek() {
            if ch.is_alphanumeric() || ch == '_' {
                id.push(ch);
                self.advance();
            } else {
                break;
            }
        }
        id
    }

    // @model Foo / @using Bar / etc.
    fn parse_directive(&mut self, start: usize, keyword: String) -> usize {
        // Consume the rest of the line as the directive argument.
        while let Some(ch) = self.peek() {
            if ch == '\n' {
                break;
            }
            self.advance();
        }
        self.push_node(NodeKind::RazorDirective { keyword }, start, vec![])
    }

    // @if (…) { … } else { … }
    fn parse_control_flow(&mut self, start: usize, keyword: String) -> usize {
        // Skip optional whitespace
        self.skip_whitespace();

        // Optional condition: @if (…)
        if self.peek() == Some('(') {
            self.advance(); // '('
            let _ = self.parse_balanced('(', ')');
        }

        self.skip_whitespace();

        // Body block: { … }
        if self.peek() == Some('{') {
            self.advance();
            let _ = self.parse_csharp_block('{', '}');
        }

        // Special: @else / @else if
        if keyword == "if" {
            self.parse_else_chain();
        }
        // Special: @try → catch / finally
        if keyword == "try" {
            self.parse_catch_finally();
        }

        self.push_node(NodeKind::RazorControlFlow { keyword }, start, vec![])
    }

    fn parse_else_chain(&mut self) {
        // Optionally consume `else` / `else if` after the if block.
        let saved = self.pos;
        self.skip_whitespace();
        if self.consume_str("else") {
            self.skip_whitespace();
            if self.consume_str("if") {
                self.skip_whitespace();
                if self.peek() == Some('(') {
                    self.advance();
                    let _ = self.parse_balanced('(', ')');
                }
            }
            self.skip_whitespace();
            if self.peek() == Some('{') {
                self.advance();
                let _ = self.parse_csharp_block('{', '}');
                // Recurse for else-if chain.
                self.parse_else_chain();
            }
        } else {
            self.pos = saved;
        }
    }

    fn parse_catch_finally(&mut self) {
        // catch (…) { … }
        let saved = self.pos;
        self.skip_whitespace();
        if self.consume_str("catch") {
            self.skip_whitespace();
            if self.peek() == Some('(') {
                self.advance();
                let _ = self.parse_balanced('(', ')');
            }
            self.skip_whitespace();
            if self.peek() == Some('{') {
                self.advance();
                let _ = self.parse_csharp_block('{', '}');
            }
            self.parse_catch_finally();
        } else {
            self.pos = saved;
        }
        let saved2 = self.pos;
        self.skip_whitespace();
        if self.consume_str("finally") {
            self.skip_whitespace();
            if self.peek() == Some('{') {
                self.advance();
                let _ = self.parse_csharp_block('{', '}');
            }
        } else {
            self.pos = saved2;
        }
    }

    // @identifier.member( … ) — tail after keyword
    fn parse_implicit_expr_tail(&mut self, start: usize) -> usize {
        loop {
            match self.peek() {
                Some('.') => {
                    self.advance();
                    self.read_identifier();
                }
                Some('(') => {
                    self.advance();
                    let _ = self.parse_balanced('(', ')');
                }
                Some('[') => {
                    self.advance();
                    let _ = self.parse_balanced('[', ']');
                }
                _ => break,
            }
        }
        self.push_node(NodeKind::RazorImplicitExpression, start, vec![])
    }

    // ── Balanced delimiter parser (C# content) ────────────────────────────────

    /// Consumes everything up to (and including) the matching `close` delimiter,
    /// tracking nesting and skipping strings and comments. Returns children.
    fn parse_csharp_block(
        &mut self,
        open: char,
        close: char,
    ) -> Result<Vec<usize>, ()> {
        let start = self.pos;
        let mut depth = 1usize;
        let mut children = Vec::new();

        while !self.at_end() && depth > 0 {
            let ch = self.peek().unwrap();

            if ch == open {
                depth += 1;
                self.advance();
            } else if ch == close {
                depth -= 1;
                if depth == 0 {
                    self.advance(); // consume closing delimiter
                    break;
                }
                self.advance();
            } else if ch == '"' {
                self.skip_csharp_string('"');
            } else if ch == '\'' {
                self.skip_csharp_string('\'');
            } else if ch == '/' {
                if self.peek2() == Some('/') {
                    while let Some(c) = self.advance() {
                        if c == '\n' { break; }
                    }
                } else if self.peek2() == Some('*') {
                    self.pos += 2;
                    loop {
                        if self.at_end() { break; }
                        if self.match_str("*/") { self.pos += 2; break; }
                        self.advance();
                    }
                } else {
                    self.advance();
                }
            } else if ch == '<' && open == '{' {
                // HTML inside a C# block — parse as a sub-node.
                if let Some(child) = self.try_parse_html_in_csharp() {
                    children.push(child);
                } else {
                    self.advance();
                }
            } else if ch == '@' && open == '{' {
                // Nested Razor inside a code block.
                if let Some(child) = self.parse_node() {
                    children.push(child);
                }
            } else {
                self.advance();
            }
        }

        if depth > 0 {
            let range = self.range_from(start);
            self.diagnostics.push(Diagnostic {
                range,
                severity: Severity::Error,
                code: Some(DiagnosticCode("RZ0003".into())),
                source: "fluent-cshtml-parser".into(),
                message: format!("Delimitador '{close}' não fechado."),
            });
            return Err(());
        }
        Ok(children)
    }

    fn parse_balanced(&mut self, open: char, close: char) -> Result<(), ()> {
        self.parse_csharp_block(open, close).map(|_| ())
    }

    fn skip_csharp_string(&mut self, quote: char) {
        self.advance(); // opening quote
        loop {
            match self.advance() {
                None => break,
                Some('\\') => { self.advance(); } // escape
                Some(ch) if ch == quote => break,
                _ => {}
            }
        }
    }

    /// Try to parse an HTML tag when encountered inside a C# block.
    /// Returns Some(node_index) on success, None if it's not actually a tag.
    fn try_parse_html_in_csharp(&mut self) -> Option<usize> {
        // Peek ahead: is this '<' followed by a letter or '/'?
        let next = self.peek2()?;
        if next.is_alphabetic() || next == '/' {
            Some(self.parse_html_node())
        } else {
            None
        }
    }

    // ── HTML ──────────────────────────────────────────────────────────────────

    fn parse_html_node(&mut self) -> usize {
        let start = self.pos;
        if self.match_str("<!--") {
            return self.parse_html_comment(start);
        }
        if self.match_str("<!") {
            return self.parse_doctype(start);
        }
        if self.peek2() == Some('/') {
            return self.parse_close_tag(start);
        }
        self.parse_open_tag(start)
    }

    fn parse_html_comment(&mut self, start: usize) -> usize {
        self.pos += 4; // '<!--'
        loop {
            if self.at_end() {
                break;
            }
            if self.match_str("-->") {
                self.pos += 3;
                break;
            }
            self.advance();
        }
        self.push_node(NodeKind::HtmlComment, start, vec![])
    }

    fn parse_doctype(&mut self, start: usize) -> usize {
        while let Some(ch) = self.advance() {
            if ch == '>' { break; }
        }
        self.push_node(NodeKind::HtmlDoctype, start, vec![])
    }

    fn parse_open_tag(&mut self, start: usize) -> usize {
        self.advance(); // '<'
        let name = self.read_tag_name();
        let mut children = Vec::new();

        // Attributes
        loop {
            self.skip_whitespace();
            match self.peek() {
                None | Some('>') => { self.advance(); break; }
                Some('/') => {
                    // Self-closing tag
                    self.advance();
                    if self.peek() == Some('>') { self.advance(); }
                    return self.push_node(NodeKind::HtmlSelfCloseTag { name }, start, children);
                }
                _ => {
                    if let Some(attr) = self.parse_html_attribute() {
                        children.push(attr);
                    }
                }
            }
        }

        self.push_node(NodeKind::HtmlOpenTag { name }, start, children)
    }

    fn parse_close_tag(&mut self, start: usize) -> usize {
        self.advance(); // '<'
        self.advance(); // '/'
        let name = self.read_tag_name();
        // Consume to '>'
        while let Some(ch) = self.peek() {
            if ch == '>' { self.advance(); break; }
            self.advance();
        }
        self.push_node(NodeKind::HtmlCloseTag { name }, start, vec![])
    }

    fn read_tag_name(&mut self) -> String {
        let mut name = String::new();
        while let Some(ch) = self.peek() {
            if ch.is_alphanumeric() || ch == '-' || ch == ':' || ch == '_' || ch == '.' {
                name.push(ch);
                self.advance();
            } else {
                break;
            }
        }
        name.to_ascii_lowercase()
    }

    fn parse_html_attribute(&mut self) -> Option<usize> {
        let start = self.pos;
        let ch = self.peek()?;
        // Guard: stop on '>', '/', or end of input
        if ch == '>' || ch == '/' { return None; }

        // Razor expression in attribute position (@bind, @onclick, etc.)
        if ch == '@' {
            let node = self.parse_razor();
            return Some(node);
        }

        // Name
        let mut name = String::new();
        while let Some(c) = self.peek() {
            if c.is_whitespace() || c == '=' || c == '>' || c == '/' { break; }
            name.push(c);
            self.advance();
        }
        if name.is_empty() {
            self.advance(); // skip unknown char
            return None;
        }

        // Optional '=' value
        self.skip_whitespace();
        if self.peek() == Some('=') {
            self.advance(); // '='
            self.skip_whitespace();
            self.parse_attr_value();
        }

        Some(self.push_node(NodeKind::HtmlAttribute { name }, start, vec![]))
    }

    fn parse_attr_value(&mut self) {
        match self.peek() {
            Some('"') => {
                self.advance();
                loop {
                    match self.peek() {
                        None | Some('"') => { self.advance(); break; }
                        Some('@') => { self.parse_razor(); }
                        _ => { self.advance(); }
                    }
                }
            }
            Some('\'') => {
                self.advance();
                loop {
                    match self.peek() {
                        None | Some('\'') => { self.advance(); break; }
                        Some('@') => { self.parse_razor(); }
                        _ => { self.advance(); }
                    }
                }
            }
            _ => {
                // Unquoted value — consume to whitespace or '>'
                while let Some(ch) = self.peek() {
                    if ch.is_whitespace() || ch == '>' { break; }
                    self.advance();
                }
            }
        }
    }

    fn skip_whitespace(&mut self) {
        while let Some(ch) = self.peek() {
            if ch.is_whitespace() { self.advance(); } else { break; }
        }
    }
}

// ── impl CshtmlEngine integration ─────────────────────────────────────────────

use crate::cshtml::{
    engine::DiagnosticProvider,
    types::Snapshot,
};

/// A `DiagnosticProvider` that runs the parser on every request.
pub struct ParserDiagnosticProvider;

impl DiagnosticProvider for ParserDiagnosticProvider {
    fn diagnostics(&self, snapshot: &Snapshot) -> Vec<Diagnostic> {
        let (_, diags) = parse(snapshot.text());
        diags
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn diag_messages(text: &str) -> Vec<String> {
        let (_, diags) = parse(text);
        diags.iter().map(|d| d.message.clone()).collect()
    }

    fn tree(text: &str) -> ParseTree {
        let (t, _) = parse(text);
        t
    }

    // ── No-panic on any corpus fixture ────────────────────────────────────────

    const FIXTURES: &[&str] = &[
        "",                          // empty
        "@model Foo\n<p>Hello</p>",
        "@{",                        // unclosed block
        "@* unterminated",           // unclosed comment
        "😀🎉𝐀 text",              // Unicode / supplementary
        "<div><p>text</p></span>",   // stray close
        "@if (x > 0) { <b>yes</b> } else { <i>no</i> }",
        "@foreach (var x in xs) { <li>@x</li> }",
        "@try { } catch (Exception e) { } finally { }",
        "<!DOCTYPE html><html><head></head><body></body></html>",
        "<!-- comment -->",
        "@@ email@@example.com",
        "@(Model.Name.ToUpper())",
        "@model MyModel\r\n<p>CRLF</p>",
    ];

    #[test]
    fn no_panic_on_any_fixture() {
        for &text in FIXTURES {
            let _ = parse(text); // must not panic
        }
    }

    // ── Document root is always at index 0 ───────────────────────────────────

    #[test]
    fn root_is_document() {
        for &text in FIXTURES {
            let t = tree(text);
            assert!(
                matches!(t.root().kind, NodeKind::Document),
                "root must be Document for: {:?}",
                text
            );
        }
    }

    // ── Directive parsing ────────────────────────────────────────────────────

    #[test]
    fn parses_model_directive() {
        let t = tree("@model MyApp.Models.Foo\n");
        let dirs: Vec<_> = t.walk()
            .filter(|n| matches!(&n.kind, NodeKind::RazorDirective { keyword } if keyword == "model"))
            .collect();
        assert!(!dirs.is_empty(), "must parse @model directive");
    }

    #[test]
    fn parses_using_directive() {
        let t = tree("@using System.Collections.Generic\n");
        let dirs: Vec<_> = t.walk()
            .filter(|n| matches!(&n.kind, NodeKind::RazorDirective { keyword } if keyword == "using"))
            .collect();
        assert!(!dirs.is_empty());
    }

    // ── Expressions ──────────────────────────────────────────────────────────

    #[test]
    fn parses_implicit_expression() {
        let t = tree("<p>@Model.Name</p>");
        let exprs: Vec<_> = t.walk()
            .filter(|n| matches!(n.kind, NodeKind::RazorImplicitExpression))
            .collect();
        assert!(!exprs.is_empty(), "must parse implicit expression");
    }

    #[test]
    fn parses_explicit_expression() {
        let t = tree("<p>@(Model.Count * 2)</p>");
        let exprs: Vec<_> = t.walk()
            .filter(|n| matches!(n.kind, NodeKind::RazorExplicitExpression))
            .collect();
        assert!(!exprs.is_empty());
    }

    #[test]
    fn parses_at_at_escape() {
        let t = tree("<p>user@@example.com</p>");
        let escapes: Vec<_> = t.walk()
            .filter(|n| matches!(n.kind, NodeKind::RazorEscape))
            .collect();
        assert!(!escapes.is_empty(), "must parse @@ escape");
    }

    // ── Code block ───────────────────────────────────────────────────────────

    #[test]
    fn parses_code_block() {
        let t = tree("@{ var x = 1; }\n");
        let blocks: Vec<_> = t.walk()
            .filter(|n| matches!(n.kind, NodeKind::RazorCodeBlock))
            .collect();
        assert!(!blocks.is_empty(), "must parse @{{}} code block");
    }

    // ── Control flow ─────────────────────────────────────────────────────────

    #[test]
    fn parses_if_block() {
        let t = tree("@if (x > 0) { <p>yes</p> }\n");
        let nodes: Vec<_> = t.walk()
            .filter(|n| matches!(&n.kind, NodeKind::RazorControlFlow { keyword } if keyword == "if"))
            .collect();
        assert!(!nodes.is_empty());
    }

    #[test]
    fn parses_foreach_block() {
        let t = tree("@foreach (var i in list) { <li>@i</li> }\n");
        let nodes: Vec<_> = t.walk()
            .filter(|n| matches!(&n.kind, NodeKind::RazorControlFlow { keyword } if keyword == "foreach"))
            .collect();
        assert!(!nodes.is_empty());
    }

    // ── HTML ──────────────────────────────────────────────────────────────────

    #[test]
    fn parses_open_tag() {
        let t = tree("<div class=\"x\">content</div>");
        let tags: Vec<_> = t.walk()
            .filter(|n| matches!(&n.kind, NodeKind::HtmlOpenTag { name } if name == "div"))
            .collect();
        assert!(!tags.is_empty());
    }

    #[test]
    fn parses_self_close_tag() {
        let t = tree("<img src=\"x.png\" />");
        let tags: Vec<_> = t.walk()
            .filter(|n| matches!(&n.kind, NodeKind::HtmlSelfCloseTag { name } if name == "img"))
            .collect();
        assert!(!tags.is_empty());
    }

    #[test]
    fn parses_html_comment() {
        let t = tree("<!-- this is a comment -->");
        let comments: Vec<_> = t.walk()
            .filter(|n| matches!(n.kind, NodeKind::HtmlComment))
            .collect();
        assert!(!comments.is_empty());
    }

    // ── Error recovery ────────────────────────────────────────────────────────

    #[test]
    fn unclosed_block_produces_diagnostic() {
        let msgs = diag_messages("@{ var x = 1;");
        assert!(
            msgs.iter().any(|m| m.contains("não fechado")),
            "must produce 'não fechado' diagnostic; got: {:?}",
            msgs
        );
    }

    #[test]
    fn unclosed_comment_produces_diagnostic() {
        let msgs = diag_messages("@* comment without end");
        assert!(msgs.iter().any(|m| m.contains("não fechado")));
    }

    #[test]
    fn error_nodes_have_useful_ranges() {
        let (_t, diags) = parse("@{ unclosed");
        assert!(!diags.is_empty(), "must have diagnostics");
        for d in &diags {
            // Range must be within the document.
            assert!(d.range.start.line <= d.range.end.line);
        }
    }

    #[test]
    fn partial_file_still_has_root_node() {
        let t = tree("@model Foo\n<p>partial without ");
        assert!(matches!(t.root().kind, NodeKind::Document));
    }

    // ── Unicode ───────────────────────────────────────────────────────────────

    #[test]
    fn unicode_no_panic() {
        let _ = parse("@model Foo\n<p>こんにちは 😀 𝐀</p>");
    }

    #[test]
    fn emoji_in_text_node() {
        let t = tree("<p>😀</p>");
        let texts: Vec<_> = t.walk()
            .filter(|n| matches!(n.kind, NodeKind::HtmlText))
            .collect();
        assert!(!texts.is_empty());
    }

    // ── Position accuracy ─────────────────────────────────────────────────────

    #[test]
    fn model_directive_starts_at_line_zero() {
        let t = tree("@model Foo\n<p>x</p>");
        let dir = t.walk()
            .find(|n| matches!(&n.kind, NodeKind::RazorDirective { .. }))
            .expect("must have a directive");
        assert_eq!(dir.range.start.line, 0, "directive must start at line 0");
        assert_eq!(dir.range.start.character, 0, "directive must start at char 0");
    }

    #[test]
    fn close_tag_on_line_one() {
        let t = tree("<p>\n</p>");
        let close = t.walk()
            .find(|n| matches!(&n.kind, NodeKind::HtmlCloseTag { name } if name == "p"))
            .expect("must have </p>");
        assert_eq!(close.range.start.line, 1, "</p> must be on line 1");
    }

    // ── ParserDiagnosticProvider wired into engine ────────────────────────────

    #[test]
    fn provider_wired_into_engine() {
        use crate::cshtml::engine::CshtmlEngine;
        let engine = CshtmlEngine::new()
            .with_diagnostic_provider(ParserDiagnosticProvider);
        engine.open_document("file:///t.cshtml", 1, "@{ unclosed").unwrap();
        let diags = engine.diagnostics("file:///t.cshtml");
        assert!(!diags.is_empty(), "engine must surface parse diagnostics");
    }

    #[test]
    fn provider_no_diags_on_valid_file() {
        use crate::cshtml::engine::CshtmlEngine;
        let engine = CshtmlEngine::new()
            .with_diagnostic_provider(ParserDiagnosticProvider);
        engine
            .open_document("file:///t.cshtml", 1, "@model Foo\n<p>Hello</p>")
            .unwrap();
        let diags = engine.diagnostics("file:///t.cshtml");
        assert!(diags.is_empty(), "valid file must produce no diagnostics; got: {:?}", diags);
    }
}
