/// Domain types for the CSHTML engine (issue #33).
///
/// No dependency on Tauri, Monaco, LSP or Roslyn. All positions use
/// UTF-16 code unit offsets so they map 1-to-1 with Monaco's model
/// coordinate system.

// ── Identifiers ──────────────────────────────────────────────────────────────

/// Stable identifier for an open document.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DocumentId(pub String);

impl DocumentId {
    pub fn new(uri: impl Into<String>) -> Self {
        Self(uri.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for DocumentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

// ── Versioning ────────────────────────────────────────────────────────────────

/// Monotonically-increasing document version (matches LSP versioning semantics).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct DocumentVersion(pub i32);

impl DocumentVersion {
    pub fn initial() -> Self {
        Self(0)
    }
}

// ── Positions and ranges ──────────────────────────────────────────────────────

/// Zero-based (line, character) position. `character` is a UTF-16 code unit
/// offset within the line — matches Monaco/LSP convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextPosition {
    pub line: u32,
    pub character: u32,
}

/// A half-open [start, end) range of `TextPosition`s.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextRange {
    pub start: TextPosition,
    pub end: TextPosition,
}

impl TextRange {
    pub fn point(pos: TextPosition) -> Self {
        Self { start: pos, end: pos }
    }
}

/// A single text replacement (empty `new_text` ⇒ deletion, empty range ⇒ insertion).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEdit {
    pub range: TextRange,
    pub new_text: String,
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Information,
    Hint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticCode(pub String);

#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub range: TextRange,
    pub severity: Severity,
    pub code: Option<DiagnosticCode>,
    pub source: String,
    pub message: String,
}

// ── Projection regions ────────────────────────────────────────────────────────

/// Which sub-language owns a region of the source document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LanguageKind {
    /// Raw HTML/attribute markup.
    Html,
    /// C# code (inside `@{ }`, `@expr`, `@(…)`, etc.).
    CSharp,
    /// Razor directive line (`@model`, `@using`, …).
    RazorDirective,
    /// Razor comment `@* … *@`.
    Comment,
}

/// A typed region produced by the projection layer (issue #36).
#[derive(Debug, Clone)]
pub struct Region {
    pub range: TextRange,
    pub kind: LanguageKind,
}

// ── Symbol / completion stubs ─────────────────────────────────────────────────

/// A document symbol (for the outline / go-to-symbol feature).
#[derive(Debug, Clone)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    pub range: TextRange,
    pub selection_range: TextRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Function,
    Variable,
    Class,
    Field,
    Property,
    Method,
    Namespace,
    Other(u8),
}

/// A single completion item (for future completion provider, issue #44).
#[derive(Debug, Clone)]
pub struct Completion {
    pub label: String,
    pub detail: Option<String>,
    pub insert_text: String,
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

/// An immutable view of a document at a specific version.
/// Produced by `DocumentStore::snapshot()`; safe to hold across async boundaries.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub id: DocumentId,
    pub version: DocumentVersion,
    /// Full document text stored as UTF-8. Positions in this snapshot use
    /// UTF-16 offsets externally but the store converts internally.
    pub(crate) text: String,
}

impl Snapshot {
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Total number of lines (last line may be empty if text ends with '\n').
    pub fn line_count(&self) -> usize {
        self.text.lines().count().max(1)
    }
}
