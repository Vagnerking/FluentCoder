/// AST types for the CSHTML/Razor parser (issue #35).
///
/// This is a project-owned AST — consumers must NOT depend on any Tree-sitter
/// node kinds. The representation is a flat list of `Node`s (arena-style) with
/// children stored as index ranges, making it cheap to clone or share across threads.

use crate::cshtml::types::{LanguageKind, TextPosition, TextRange};

// ── Node kinds ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeKind {
    // Document root
    Document,

    // HTML
    HtmlText,
    HtmlComment,
    HtmlDoctype,
    HtmlOpenTag { name: String },
    HtmlSelfCloseTag { name: String },
    HtmlCloseTag { name: String },
    HtmlAttribute { name: String },
    HtmlAttributeValue,

    // Razor transitions & comments
    RazorComment,
    RazorEscape,       // `@@`
    RazorTransition,   // standalone `@` before an expression/block

    // Razor directives (first token after `@`)
    RazorDirective { keyword: String },

    // Razor expressions
    RazorImplicitExpression,
    RazorExplicitExpression,  // @(…)

    // Razor code blocks
    RazorCodeBlock,   // @{…}
    RazorControlFlow { keyword: String }, // @if, @foreach, @for, @while, @switch, @try, …

    // C# fragments (inside code blocks / expressions)
    CSharpCode,

    // Error recovery node
    Error { message: String },
}

impl NodeKind {
    /// The `LanguageKind` this node maps to for projection (issue #36).
    pub fn language_kind(&self) -> LanguageKind {
        match self {
            Self::HtmlText
            | Self::HtmlComment
            | Self::HtmlDoctype
            | Self::HtmlOpenTag { .. }
            | Self::HtmlSelfCloseTag { .. }
            | Self::HtmlCloseTag { .. }
            | Self::HtmlAttribute { .. }
            | Self::HtmlAttributeValue => LanguageKind::Html,

            Self::RazorDirective { .. } => LanguageKind::RazorDirective,

            Self::RazorComment => LanguageKind::Comment,

            Self::CSharpCode
            | Self::RazorImplicitExpression
            | Self::RazorExplicitExpression
            | Self::RazorCodeBlock
            | Self::RazorControlFlow { .. } => LanguageKind::CSharp,

            _ => LanguageKind::Html,
        }
    }

    pub fn is_error(&self) -> bool {
        matches!(self, Self::Error { .. })
    }
}

// ── AST Node ──────────────────────────────────────────────────────────────────

/// A single node in the concrete syntax tree.
#[derive(Debug, Clone)]
pub struct Node {
    pub kind: NodeKind,
    pub range: TextRange,
    /// Indices into `ParseTree::nodes` for child nodes.
    pub children: Vec<usize>,
}

// ── ParseTree ─────────────────────────────────────────────────────────────────

/// The full parse result for one document.
#[derive(Debug, Clone)]
pub struct ParseTree {
    /// All nodes; index 0 is always the `Document` root.
    pub nodes: Vec<Node>,
}

impl ParseTree {
    pub fn root(&self) -> &Node {
        &self.nodes[0]
    }

    /// All error nodes in document order.
    pub fn errors(&self) -> Vec<&Node> {
        self.nodes.iter().filter(|n| n.kind.is_error()).collect()
    }

    /// All leaf nodes that cover a specific document position.
    pub fn nodes_at(&self, pos: TextPosition) -> Vec<&Node> {
        self.nodes
            .iter()
            .filter(|n| covers(n.range, pos))
            .collect()
    }

    /// Flat list of all nodes in document (pre-order) order.
    pub fn walk(&self) -> impl Iterator<Item = &Node> {
        self.nodes.iter()
    }
}

fn covers(range: TextRange, pos: TextPosition) -> bool {
    let start = range.start;
    let end = range.end;
    (pos.line > start.line || (pos.line == start.line && pos.character >= start.character))
        && (pos.line < end.line || (pos.line == end.line && pos.character <= end.character))
}
