/// Projeções HTML/C# e source maps bidirecionais (issue #36).
///
/// Camada pura: não conhece Monaco, LSP, Roslyn ou Tauri.
/// Produz segmentos mapeáveis a partir da `ParseTree`, permitindo:
///   - Mapear posição/range da origem (.cshtml) para posição na projeção
///   - Mapear posição/range da projeção de volta para a origem
///   - Consultar a linguagem e tipo de região em qualquer posição
///   - Remapear diagnósticos/edits produzidos sobre projeções de volta ao .cshtml

use crate::cshtml::{
    ast::{NodeKind, ParseTree},
    types::{LanguageKind, TextPosition, TextRange},
};

// ── Segment ───────────────────────────────────────────────────────────────────

/// A contiguous segment that maps a range in the `.cshtml` source to a range in
/// one of the projected documents (HTML or C#). The two ranges have the same
/// number of characters (no content is inserted or removed — only the language
/// classification changes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    /// Range in the original `.cshtml` text.
    pub source_range: TextRange,
    /// Corresponding range in the projected document.
    pub projected_range: TextRange,
    /// Which language owns this segment.
    pub language: LanguageKind,
    /// Whether this segment was synthesised (e.g. placeholder whitespace added
    /// to keep line numbers aligned). Synthetic segments must not be turned into
    /// user-visible edits.
    pub synthetic: bool,
}

// ── ProjectionMap ─────────────────────────────────────────────────────────────

/// Holds the full set of segments for one document snapshot.
/// Created by `ProjectionBuilder::build` and consumed by the engine and lint
/// layers.
#[derive(Debug, Clone)]
pub struct ProjectionMap {
    /// All segments in document order.
    pub segments: Vec<Segment>,
    /// Projected HTML text (Razor/C# regions replaced by whitespace).
    pub html_text: String,
    /// Projected C# text (HTML markup replaced by whitespace / C# stubs).
    pub csharp_text: String,
}

impl ProjectionMap {
    /// Returns the language at `pos` in the source document, defaulting to
    /// `Html` when no specific segment owns that position.
    pub fn language_at(&self, pos: TextPosition) -> LanguageKind {
        self.segments
            .iter()
            .find(|s| range_contains(s.source_range, pos))
            .map(|s| s.language)
            .unwrap_or(LanguageKind::Html)
    }

    /// Maps a source position to the equivalent position in the projected doc
    /// that owns that segment. Returns `None` if no segment covers `pos`.
    pub fn source_to_projected(&self, pos: TextPosition) -> Option<TextPosition> {
        let seg = self.segments.iter().find(|s| range_contains(s.source_range, pos))?;
        Some(translate(pos, seg.source_range.start, seg.projected_range.start))
    }

    /// Maps a projected position back to the source. Returns `None` if not
    /// covered by any segment or if the segment is synthetic.
    pub fn projected_to_source(&self, pos: TextPosition, lang: LanguageKind) -> Option<TextPosition> {
        let seg = self
            .segments
            .iter()
            .find(|s| s.language == lang && range_contains(s.projected_range, pos) && !s.synthetic)?;
        Some(translate(pos, seg.projected_range.start, seg.source_range.start))
    }

    /// All segments whose `language` is `kind`.
    pub fn segments_for(&self, kind: LanguageKind) -> impl Iterator<Item = &Segment> {
        self.segments.iter().filter(move |s| s.language == kind)
    }
}

// ── Invariant helpers ─────────────────────────────────────────────────────────

fn range_contains(range: TextRange, pos: TextPosition) -> bool {
    let after_start = pos.line > range.start.line
        || (pos.line == range.start.line && pos.character >= range.start.character);
    let before_end = pos.line < range.end.line
        || (pos.line == range.end.line && pos.character <= range.end.character);
    after_start && before_end
}

/// Translates `pos` from coordinate space `from_origin` to `to_origin`,
/// assuming all offsets are on the same line for the delta adjustment.
fn translate(pos: TextPosition, from_origin: TextPosition, to_origin: TextPosition) -> TextPosition {
    if from_origin.line == to_origin.line && pos.line == from_origin.line {
        TextPosition {
            line: pos.line,
            character: pos.character
                .saturating_sub(from_origin.character)
                .saturating_add(to_origin.character),
        }
    } else {
        let line_delta = (pos.line as i64) - (from_origin.line as i64);
        let new_line = ((to_origin.line as i64) + line_delta).max(0) as u32;
        // Only adjust character on the first line of the segment.
        let new_char = if pos.line == from_origin.line {
            pos.character
                .saturating_sub(from_origin.character)
                .saturating_add(to_origin.character)
        } else {
            pos.character
        };
        TextPosition { line: new_line, character: new_char }
    }
}

// ── Builder ───────────────────────────────────────────────────────────────────

/// Constructs a `ProjectionMap` from a `ParseTree` and the source text.
///
/// Strategy:
/// - Walk the AST in document order, collecting leaf-level ranges.
/// - For each node, classify as HTML or C# (via `NodeKind::language_kind()`).
/// - Build projected texts by:
///   - `html_text`: copy source verbatim for HTML nodes; replace C#/Razor nodes
///     with spaces (same byte count) so line numbers are preserved.
///   - `csharp_text`: copy source verbatim for C#/Razor nodes; replace HTML
///     nodes with spaces.
/// - Segments are 1-to-1: source range == projected range (identity map) so
///   that position translation is O(n) in segment count but trivial in math.
pub struct ProjectionBuilder<'a> {
    source: &'a str,
    chars: Vec<char>,
}

impl<'a> ProjectionBuilder<'a> {
    pub fn new(source: &'a str) -> Self {
        Self {
            source,
            chars: source.chars().collect(),
        }
    }

    pub fn build(&self, tree: &ParseTree) -> ProjectionMap {
        // Collect leaf node ranges with their language kind, in document order.
        // "Leaf" here means: no children with real content, i.e. the node itself
        // owns the characters. We collect all nodes and skip Document (it spans all).
        let mut leaves: Vec<(TextRange, LanguageKind)> = tree
            .walk()
            .filter(|n| !matches!(n.kind, NodeKind::Document))
            .map(|n| (n.range, n.kind.language_kind()))
            .collect();

        // Sort by start position to ensure document order.
        leaves.sort_by(|a, b| {
            a.0.start.line.cmp(&b.0.start.line)
                .then(a.0.start.character.cmp(&b.0.start.character))
        });

        // Deduplicate / flatten: prefer the most specific (innermost) node.
        // Since children appear later and have narrower ranges, we keep
        // non-overlapping segments by a simple greedy scan.
        let leaves = Self::flatten_segments(leaves);

        // Fill any gaps between segments as HTML (default language).
        let total_chars = self.chars.len();
        let all_segs = Self::fill_gaps(&leaves, total_chars, self);

        // Build projected texts.
        let mut html_text = String::with_capacity(self.source.len());
        let mut csharp_text = String::with_capacity(self.source.len());

        for &(range, lang, _synthetic) in &all_segs {
            let text = self.text_for_range(range);
            match lang {
                LanguageKind::Html => {
                    html_text.push_str(text);
                    csharp_text.push_str(&blank_preserve_newlines(text));
                }
                LanguageKind::CSharp | LanguageKind::RazorDirective => {
                    html_text.push_str(&blank_preserve_newlines(text));
                    csharp_text.push_str(text);
                }
                LanguageKind::Comment => {
                    html_text.push_str(&blank_preserve_newlines(text));
                    csharp_text.push_str(&blank_preserve_newlines(text));
                }
            }
        }

        // Build segments with identity mapping (source == projected range).
        let segments = all_segs
            .into_iter()
            .map(|(range, lang, synthetic)| Segment {
                source_range: range,
                projected_range: range,
                language: lang,
                synthetic,
            })
            .collect();

        ProjectionMap { segments, html_text, csharp_text }
    }

    fn flatten_segments(mut leaves: Vec<(TextRange, LanguageKind)>) -> Vec<(TextRange, LanguageKind)> {
        let mut out: Vec<(TextRange, LanguageKind)> = Vec::new();
        for (range, lang) in leaves.drain(..) {
            if range.start == range.end {
                continue; // skip zero-length
            }
            if let Some(last) = out.last() {
                // If this range starts at or before the last end, skip (child
                // already captured by parent or overlapping).
                if range.start.line < last.0.end.line
                    || (range.start.line == last.0.end.line
                        && range.start.character < last.0.end.character)
                {
                    continue;
                }
            }
            out.push((range, lang));
        }
        out
    }

    fn fill_gaps(
        leaves: &[(TextRange, LanguageKind)],
        total_chars: usize,
        builder: &ProjectionBuilder<'_>,
    ) -> Vec<(TextRange, LanguageKind, bool)> {
        let mut out: Vec<(TextRange, LanguageKind, bool)> = Vec::new();
        let doc_start = TextPosition { line: 0, character: 0 };
        let doc_end = builder.char_to_position(total_chars);

        let mut cursor = doc_start;

        for &(range, lang) in leaves {
            if cursor_before(cursor, range.start) {
                // Gap before this segment → HTML.
                out.push((TextRange { start: cursor, end: range.start }, LanguageKind::Html, false));
            }
            out.push((range, lang, false));
            cursor = range.end;
        }

        // Trailing gap.
        if cursor_before(cursor, doc_end) {
            out.push((TextRange { start: cursor, end: doc_end }, LanguageKind::Html, false));
        }

        out
    }

    fn text_for_range(&self, range: TextRange) -> &str {
        let start = self.position_to_byte(range.start).unwrap_or(0);
        let end = self.position_to_byte(range.end).unwrap_or(self.source.len());
        &self.source[start.min(self.source.len())..end.min(self.source.len())]
    }

    fn char_to_position(&self, char_offset: usize) -> TextPosition {
        let limit = char_offset.min(self.chars.len());
        let mut line = 0u32;
        let mut col = 0u32;
        for &ch in &self.chars[..limit] {
            if ch == '\n' { line += 1; col = 0; }
            else { col += ch.len_utf16() as u32; }
        }
        TextPosition { line, character: col }
    }

    fn position_to_byte(&self, pos: TextPosition) -> Option<usize> {
        let mut line = 0u32;
        let mut col = 0u32;
        let mut byte = 0usize;
        for ch in self.source.chars() {
            if line == pos.line && col == pos.character {
                return Some(byte);
            }
            if ch == '\n' { line += 1; col = 0; }
            else { col += ch.len_utf16() as u32; }
            byte += ch.len_utf8();
        }
        if line == pos.line && col == pos.character { Some(byte) } else { None }
    }
}

fn cursor_before(a: TextPosition, b: TextPosition) -> bool {
    a.line < b.line || (a.line == b.line && a.character < b.character)
}

/// Replace every non-newline character with a space, preserving newlines so
/// line numbers in the projected document match the source.
fn blank_preserve_newlines(s: &str) -> String {
    s.chars()
        .map(|c| if c == '\n' || c == '\r' { c } else { ' ' })
        .collect()
}

// ── Public helper: build a projection from source text directly ───────────────

/// Parse `source` and build its projection in one call.
pub fn project(source: &str) -> ProjectionMap {
    let (tree, _) = crate::cshtml::parser::parse(source);
    ProjectionBuilder::new(source).build(&tree)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cshtml::types::{LanguageKind, TextPosition};

    fn pos(line: u32, ch: u32) -> TextPosition {
        TextPosition { line, character: ch }
    }

    // ── Smoke: no-panic on corpus fixtures ───────────────────────────────────

    const FIXTURES: &[&str] = &[
        "",
        "@model Foo\n<p>Hello</p>",
        "@{\n    var x = 1;\n}\n<p>@x</p>",
        "@if (cond) { <b>yes</b> } else { <i>no</i> }",
        "@foreach (var i in list) { <li>@i</li> }",
        "<!-- comment --><p>text</p>",
        "@* razor comment *@<p>after</p>",
        "@@ email",
        "<div class=\"@Model.Class\">content</div>",
        "😀<p>@Model.Emoji</p>",
        "@model Foo\r\n<p>CRLF</p>",
    ];

    #[test]
    fn no_panic_on_fixtures() {
        for &text in FIXTURES {
            let _ = project(text);
        }
    }

    // ── html_text / csharp_text have same char length as source ──────────────

    #[test]
    fn projected_lengths_match_source() {
        for &text in FIXTURES {
            let pm = project(text);
            // Character counts must match (different byte counts possible for
            // Unicode, but chars are preserved).
            let src_chars = text.chars().count();
            let html_chars = pm.html_text.chars().count();
            let cs_chars = pm.csharp_text.chars().count();
            assert_eq!(html_chars, src_chars,
                "html_text char count mismatch for {:?}", text);
            assert_eq!(cs_chars, src_chars,
                "csharp_text char count mismatch for {:?}", text);
        }
    }

    // ── Newlines are preserved in projected texts ─────────────────────────────

    #[test]
    fn projected_texts_preserve_newlines() {
        let source = "@model Foo\n<p>text</p>\n";
        let pm = project(source);
        let src_newlines = source.chars().filter(|&c| c == '\n').count();
        let html_newlines = pm.html_text.chars().filter(|&c| c == '\n').count();
        let cs_newlines = pm.csharp_text.chars().filter(|&c| c == '\n').count();
        assert_eq!(html_newlines, src_newlines, "html_text must preserve newlines");
        assert_eq!(cs_newlines, src_newlines, "csharp_text must preserve newlines");
    }

    // ── language_at queries ───────────────────────────────────────────────────

    #[test]
    fn directive_region_is_cshtml() {
        // "@model Foo" is on line 0; `language_at(0,0)` should be RazorDirective or CSharp.
        let pm = project("@model Foo\n<p>text</p>");
        let lang = pm.language_at(pos(0, 0));
        assert!(
            matches!(lang, LanguageKind::RazorDirective | LanguageKind::CSharp),
            "directive at (0,0) should be C#/RazorDirective, got {:?}", lang
        );
    }

    #[test]
    fn html_region_is_html() {
        // "<p>text</p>" starts at line 1 in "@model Foo\n<p>text</p>"
        let pm = project("@model Foo\n<p>text</p>");
        let lang = pm.language_at(pos(1, 0));
        assert_eq!(lang, LanguageKind::Html, "HTML tag at line 1 should be Html");
    }

    #[test]
    fn code_block_region_is_csharp() {
        // "@{\n    var x = 1;\n}" — line 1 (inside block) should be CSharp.
        let pm = project("@{\n    var x = 1;\n}\n<p>text</p>");
        let lang = pm.language_at(pos(1, 4));
        assert!(
            matches!(lang, LanguageKind::CSharp | LanguageKind::RazorDirective),
            "inside code block should be CSharp, got {:?}", lang
        );
    }

    #[test]
    fn razor_comment_region_is_comment() {
        // "@* comment *@<p>" — position (0,0) to (0,13) is Comment.
        let pm = project("@* comment *@<p>x</p>");
        let lang = pm.language_at(pos(0, 1));
        assert_eq!(lang, LanguageKind::Comment, "Razor comment should be Comment");
    }

    // ── HTML projection blanks out C# regions ────────────────────────────────

    #[test]
    fn html_projection_blanks_directive() {
        let source = "@model Foo\n<p>x</p>";
        let pm = project(source);
        // The `@model Foo` line should be all spaces in html_text (not `@model Foo`)
        let html_line0: String = pm.html_text.lines().next().unwrap_or("").to_string();
        assert!(
            !html_line0.contains('@'),
            "html_text must not contain '@' in directive region; got: {:?}", html_line0
        );
    }

    #[test]
    fn csharp_projection_blanks_html() {
        let source = "@model Foo\n<p>hello</p>";
        let pm = project(source);
        // Line 1 is "<p>hello</p>" — should be spaces in csharp_text.
        let cs_line1: String = pm.csharp_text.lines().nth(1).unwrap_or("").to_string();
        assert!(
            !cs_line1.contains('<'),
            "csharp_text must not contain '<' in HTML region; got: {:?}", cs_line1
        );
    }

    // ── source_to_projected / projected_to_source round-trip ─────────────────

    #[test]
    fn source_to_projected_returns_some_for_known_segment() {
        let source = "@model Foo\n<p>text</p>";
        let pm = project(source);
        // Line 0 is covered by a directive segment.
        let result = pm.source_to_projected(pos(0, 0));
        assert!(result.is_some(), "source_to_projected must return Some for (0,0)");
    }

    #[test]
    fn projected_to_source_roundtrip_html() {
        let source = "@model Foo\n<p>text</p>";
        let pm = project(source);
        // Pos (1,0) is in the HTML region.
        if let Some(proj) = pm.source_to_projected(pos(1, 0)) {
            if let Some(back) = pm.projected_to_source(proj, LanguageKind::Html) {
                assert_eq!(back, pos(1, 0), "round-trip must restore original position");
            }
        }
    }

    // ── segments_for filters correctly ────────────────────────────────────────

    #[test]
    fn segments_for_html_non_empty() {
        let pm = project("<p>text</p>");
        let html_segs: Vec<_> = pm.segments_for(LanguageKind::Html).collect();
        assert!(!html_segs.is_empty(), "must have at least one HTML segment");
    }

    #[test]
    fn segments_for_csharp_non_empty() {
        let pm = project("@model Foo\n<p>text</p>");
        let cs_segs: Vec<_> = pm
            .segments_for(LanguageKind::CSharp)
            .chain(pm.segments_for(LanguageKind::RazorDirective))
            .collect();
        assert!(!cs_segs.is_empty(), "must have at least one C# segment");
    }

    // ── No range exceeds document bounds ──────────────────────────────────────

    #[test]
    fn no_segment_exceeds_document_bounds() {
        let source = "@model Foo\n<p>hello</p>";
        let pm = project(source);
        let lines: Vec<&str> = source.lines().collect();
        for seg in &pm.segments {
            assert!(
                (seg.source_range.start.line as usize) < lines.len() + 1,
                "segment start line out of bounds"
            );
            assert!(
                seg.source_range.start.line <= seg.source_range.end.line,
                "segment start must be <= end"
            );
        }
    }

    // ── Unicode / surrogate pair handling ────────────────────────────────────

    #[test]
    fn unicode_projection_no_panic() {
        let source = "@model Foo\n<p>こんにちは 😀 𝐀</p>";
        let pm = project(source);
        // char counts must still match.
        assert_eq!(
            pm.html_text.chars().count(),
            source.chars().count(),
            "unicode: html_text char count mismatch"
        );
    }

    #[test]
    fn emoji_in_html_region_stays_in_html_text() {
        let source = "<p>😀</p>";
        let pm = project(source);
        assert!(
            pm.html_text.contains('😀'),
            "emoji in HTML must appear in html_text"
        );
    }

    // ── CRLF: newlines preserved ──────────────────────────────────────────────

    #[test]
    fn crlf_newlines_preserved_in_projection() {
        let source = "@model Foo\r\n<p>text</p>\r\n";
        let pm = project(source);
        let src_crlf = source.chars().filter(|&c| c == '\r').count();
        let html_crlf = pm.html_text.chars().filter(|&c| c == '\r').count();
        assert_eq!(html_crlf, src_crlf, "CRLF must be preserved in html_text");
    }

    // ── Empty document ────────────────────────────────────────────────────────

    #[test]
    fn empty_document_produces_empty_projections() {
        let pm = project("");
        assert_eq!(pm.html_text, "");
        assert_eq!(pm.csharp_text, "");
        assert!(pm.segments.is_empty() || pm.segments.iter().all(|s| s.source_range.start == s.source_range.end));
    }

    // ── Diagnostic remapping helper ───────────────────────────────────────────

    #[test]
    fn remap_diagnostic_range_from_csharp_to_source() {
        use crate::cshtml::types::{Diagnostic, DiagnosticCode, Severity, TextRange};

        let source = "@model Foo\n<p>text</p>";
        let pm = project(source);

        // Find the actual language kind at (0,0) to use for remapping.
        let lang_at_0 = pm.language_at(pos(0, 0));

        // Synthesise a diagnostic at (0,0) in the C#/directive projection.
        let diag_in_projection = Diagnostic {
            range: TextRange { start: pos(0, 0), end: pos(0, 6) },
            severity: Severity::Error,
            code: Some(DiagnosticCode("CS0001".into())),
            source: "fluent-cshtml".into(),
            message: "test".into(),
        };

        // Remap using the correct language kind for that position.
        let remapped = remap_diagnostic(&pm, diag_in_projection, lang_at_0);
        assert!(remapped.is_some(), "remap must return Some for a covered position (lang={:?})", lang_at_0);
    }
}

// ── Diagnostic remapping helper ───────────────────────────────────────────────

/// Remaps a diagnostic produced in a projected document back to source coordinates.
/// Returns `None` if the range is synthetic and should be discarded.
pub fn remap_diagnostic(
    map: &ProjectionMap,
    mut diag: crate::cshtml::types::Diagnostic,
    lang: LanguageKind,
) -> Option<crate::cshtml::types::Diagnostic> {
    let start = map.projected_to_source(diag.range.start, lang)?;
    let end = map.projected_to_source(diag.range.end, lang).unwrap_or(start);
    diag.range = crate::cshtml::types::TextRange { start, end };
    Some(diag)
}
