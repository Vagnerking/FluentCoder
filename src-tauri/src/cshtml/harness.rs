//! Conformance harness for the CSHTML corpus (issue #34).
//!
//! Loads `.cshtml` fixtures from `corpus/` at compile time via `include_str!`
//! and runs regression checks against the `CshtmlEngine`. Each check is a
//! standalone `#[test]`, runnable in CI with `cargo test cshtml`.
//!
//! Golden-file format (JSON, `corpus/golden/*.expected.json`):
//! ```json
//! {
//!   "source_file": "invalid/stray_close_tag.cshtml",
//!   "diagnostics": [
//!     { "message_contains": "…", "severity": "Error",
//!       "range": { "start": { "line": 4, "character": 4 },
//!                  "end":   { "line": 4, "character": 11 } } }
//!   ]
//! }
//! ```
//! A `diagnostics: []` means the engine must produce no diagnostics.

#[cfg(test)]
mod tests {
    use crate::cshtml::{
        engine::CshtmlEngine,
        types::{TextEdit, TextPosition, TextRange},
    };

    // ── Corpus fixtures (embedded at compile time) ────────────────────────────

    // valid/
    const VALID_DIRECTIVES: &str = include_str!("corpus/valid/directives.cshtml");
    const VALID_EXPRESSIONS: &str = include_str!("corpus/valid/expressions.cshtml");
    const VALID_CONTROL_FLOW: &str = include_str!("corpus/valid/control_flow.cshtml");
    const VALID_COMMENTS: &str = include_str!("corpus/valid/comments.cshtml");
    const VALID_STRINGS_GENERICS: &str = include_str!("corpus/valid/strings_generics.cshtml");
    const VALID_UNICODE: &str = include_str!("corpus/valid/unicode.cshtml");
    const VALID_SECTION_LAYOUT: &str = include_str!("corpus/valid/section_layout.cshtml");
    const VALID_VIEWIMPORTS: &str = include_str!("corpus/valid/_ViewImports.cshtml");

    // invalid/
    const INVALID_UNCLOSED_BLOCK: &str = include_str!("corpus/invalid/unclosed_block.cshtml");
    const INVALID_STRAY_CLOSE: &str = include_str!("corpus/invalid/stray_close_tag.cshtml");
    const INVALID_UNCLOSED_COMMENT: &str = include_str!("corpus/invalid/unclosed_comment.cshtml");
    const INVALID_BAD_DIRECTIVE: &str = include_str!("corpus/invalid/bad_directive.cshtml");

    // partial/
    const PARTIAL_MID_EXPR: &str = include_str!("corpus/partial/mid_expression.cshtml");
    const PARTIAL_MID_TAG: &str = include_str!("corpus/partial/mid_tag.cshtml");
    const PARTIAL_EMPTY: &str = include_str!("corpus/partial/empty.cshtml");

    // ── Helper: open a document in a fresh engine ─────────────────────────────

    fn engine_with(text: &str) -> CshtmlEngine {
        let engine = CshtmlEngine::new();
        engine
            .open_document("file:///test.cshtml", 1, text)
            .unwrap();
        engine
    }

    // ── No-panic smoke tests for every corpus fixture ─────────────────────────
    //
    // Until the parser (issue #35) is wired in, these just verify that opening
    // any fixture — valid, invalid, or partial — does not panic and the engine
    // returns a snapshot with the correct text length.

    fn smoke(text: &str) {
        let engine = engine_with(text);
        let snap = engine.snapshot("file:///test.cshtml").unwrap();
        assert_eq!(
            snap.text().len(),
            text.len(),
            "snapshot text length must match input"
        );
        assert!(engine.document_count() == 1);
        // Must not panic:
        let _ = engine.diagnostics("file:///test.cshtml");
        let _ = engine.document_symbols("file:///test.cshtml");
    }

    // -- valid
    #[test]
    fn smoke_valid_directives() {
        smoke(VALID_DIRECTIVES);
    }
    #[test]
    fn smoke_valid_expressions() {
        smoke(VALID_EXPRESSIONS);
    }
    #[test]
    fn smoke_valid_control_flow() {
        smoke(VALID_CONTROL_FLOW);
    }
    #[test]
    fn smoke_valid_comments() {
        smoke(VALID_COMMENTS);
    }
    #[test]
    fn smoke_valid_strings() {
        smoke(VALID_STRINGS_GENERICS);
    }
    #[test]
    fn smoke_valid_unicode() {
        smoke(VALID_UNICODE);
    }
    #[test]
    fn smoke_valid_section_layout() {
        smoke(VALID_SECTION_LAYOUT);
    }
    #[test]
    fn smoke_valid_viewimports() {
        smoke(VALID_VIEWIMPORTS);
    }

    // -- invalid
    #[test]
    fn smoke_invalid_unclosed_block() {
        smoke(INVALID_UNCLOSED_BLOCK);
    }
    #[test]
    fn smoke_invalid_stray_close() {
        smoke(INVALID_STRAY_CLOSE);
    }
    #[test]
    fn smoke_invalid_unclosed_comment() {
        smoke(INVALID_UNCLOSED_COMMENT);
    }
    #[test]
    fn smoke_invalid_bad_directive() {
        smoke(INVALID_BAD_DIRECTIVE);
    }

    // -- partial
    #[test]
    fn smoke_partial_mid_expr() {
        smoke(PARTIAL_MID_EXPR);
    }
    #[test]
    fn smoke_partial_mid_tag() {
        smoke(PARTIAL_MID_TAG);
    }
    #[test]
    fn smoke_partial_empty() {
        smoke(PARTIAL_EMPTY);
    }

    // ── Incremental edit consistency: full == incremental ─────────────────────
    //
    // Edits a document and asserts that the final text matches the result of
    // opening a fresh document with the same final content.

    fn final_text_after_edits(initial: &str, edits: Vec<(TextRange, &str)>) -> String {
        let engine = engine_with(initial);
        let changes: Vec<TextEdit> = edits
            .into_iter()
            .map(|(range, new_text)| TextEdit {
                range,
                new_text: new_text.into(),
            })
            .collect();
        engine
            .apply_changes("file:///test.cshtml", 2, changes)
            .unwrap();
        engine
            .snapshot("file:///test.cshtml")
            .unwrap()
            .text()
            .to_string()
    }

    fn range(sl: u32, sc: u32, el: u32, ec: u32) -> TextRange {
        TextRange {
            start: TextPosition {
                line: sl,
                character: sc,
            },
            end: TextPosition {
                line: el,
                character: ec,
            },
        }
    }

    #[test]
    fn incremental_equals_full_single_line_replace() {
        let initial = "@model Foo\n<p>Hello</p>";
        let expected = "@model Foo\n<p>World</p>";

        let incremental = final_text_after_edits(initial, vec![(range(1, 3, 1, 8), "World")]);

        let engine_full = engine_with(expected);
        let full_snap = engine_full.snapshot("file:///test.cshtml").unwrap();

        assert_eq!(incremental, full_snap.text());
    }

    #[test]
    fn incremental_equals_full_multi_edit() {
        let initial = "@model A\n@using B\n<p>X</p>";
        // Two edits (non-overlapping, applied bottom-to-top by the store)
        let edits = vec![
            (range(2, 3, 2, 4), "Y"),    // Replace X→Y on line 2
            (range(0, 7, 0, 8), "NewA"), // Replace A→NewA on line 0
        ];
        let result = final_text_after_edits(initial, edits);
        assert_eq!(result, "@model NewA\n@using B\n<p>Y</p>");
    }

    #[test]
    fn incremental_insert_line() {
        let initial = "line1\nline3";
        let edits = vec![(range(1, 0, 1, 0), "line2\n")];
        let result = final_text_after_edits(initial, edits);
        assert_eq!(result, "line1\nline2\nline3");
    }

    #[test]
    fn incremental_delete_line() {
        let initial = "line1\nline2\nline3";
        let edits = vec![(range(1, 0, 2, 0), "")];
        let result = final_text_after_edits(initial, edits);
        assert_eq!(result, "line1\nline3");
    }

    // ── Unicode fixture: emoji (2 UTF-16 code units) ──────────────────────────

    #[test]
    fn unicode_edit_after_emoji() {
        // "😀" = U+1F600 = 2 UTF-16 code units.
        // "abc" starts at character 2.
        let initial = "😀abc";
        let edits = vec![(range(0, 2, 0, 5), "XY")];
        let result = final_text_after_edits(initial, edits);
        assert_eq!(result, "😀XY");
    }

    #[test]
    fn unicode_edit_before_supplementary() {
        // Insert before emoji: must not split the surrogate pair.
        let initial = "prefix😀suffix";
        // "prefix" = 6 UTF-16 units; emoji at 6..8; "suffix" at 8..14.
        let edits = vec![(range(0, 6, 0, 8), "🎉")];
        let result = final_text_after_edits(initial, edits);
        assert_eq!(result, "prefix🎉suffix");
    }

    // ── No-panic property: random positions must not panic ────────────────────

    #[test]
    fn apply_oob_edit_returns_error_not_panic() {
        let engine = engine_with("hello");
        // Character position 999 is way beyond "hello" (5 chars).
        let result = engine.apply_changes(
            "file:///test.cshtml",
            2,
            vec![TextEdit {
                range: range(0, 999, 0, 1000),
                new_text: "x".into(),
            }],
        );
        assert!(
            result.is_err(),
            "out-of-range edit must return Err, not panic"
        );
    }

    #[test]
    fn apply_to_unknown_uri_returns_error() {
        let engine = CshtmlEngine::new();
        let result = engine.apply_changes("file:///never-opened.cshtml", 1, vec![]);
        assert!(result.is_err());
    }

    // ── Stale-version guard ───────────────────────────────────────────────────

    #[test]
    fn stale_version_is_error() {
        let engine = engine_with("hello");
        // version 0 < 1 (current)
        let result = engine.apply_changes("file:///test.cshtml", 0, vec![]);
        assert!(result.is_err());
    }

    // ── Close + reopen semantics ──────────────────────────────────────────────

    #[test]
    fn close_then_reopen_same_uri() {
        let engine = engine_with("first");
        engine.close_document("file:///test.cshtml");
        // Re-open with new content.
        engine
            .open_document("file:///test.cshtml", 1, "second")
            .unwrap();
        assert_eq!(
            engine.snapshot("file:///test.cshtml").unwrap().text(),
            "second"
        );
    }

    #[test]
    fn diagnostics_after_close_is_empty() {
        let engine = engine_with("content");
        engine.close_document("file:///test.cshtml");
        assert!(engine.diagnostics("file:///test.cshtml").is_empty());
    }

    // ── Coverage tracking (structural, not counted) ───────────────────────────
    //
    // These tests verify that the corpus covers the constructs listed in the
    // issue. They pass as long as the fixture text contains the construct — the
    // parser (issue #35) will later use them as regression baselines.

    macro_rules! assert_contains {
        ($text:expr, $needle:expr) => {
            assert!(
                $text.contains($needle),
                "corpus fixture must contain {:?}",
                $needle
            );
        };
    }

    #[test]
    fn coverage_page_directive() {
        assert_contains!(VALID_DIRECTIVES, "@page");
    }
    #[test]
    fn coverage_model_directive() {
        assert_contains!(VALID_DIRECTIVES, "@model");
    }
    #[test]
    fn coverage_using_directive() {
        assert_contains!(VALID_DIRECTIVES, "@using");
    }
    #[test]
    fn coverage_inject_directive() {
        assert_contains!(VALID_DIRECTIVES, "@inject");
    }
    #[test]
    fn coverage_namespace() {
        assert_contains!(VALID_DIRECTIVES, "@namespace");
    }
    #[test]
    fn coverage_addtaghelper() {
        assert_contains!(VALID_DIRECTIVES, "@addTagHelper");
    }
    #[test]
    fn coverage_code_block() {
        assert_contains!(VALID_DIRECTIVES, "@{");
    }
    #[test]
    fn coverage_implicit_expr() {
        assert_contains!(VALID_EXPRESSIONS, "@Model.");
    }
    #[test]
    fn coverage_explicit_expr() {
        assert_contains!(VALID_EXPRESSIONS, "@(");
    }
    #[test]
    fn coverage_escaped_at() {
        assert_contains!(VALID_EXPRESSIONS, "@@");
    }
    #[test]
    fn coverage_if_block() {
        assert_contains!(VALID_CONTROL_FLOW, "@if");
    }
    #[test]
    fn coverage_foreach() {
        assert_contains!(VALID_CONTROL_FLOW, "@foreach");
    }
    #[test]
    fn coverage_switch() {
        assert_contains!(VALID_CONTROL_FLOW, "@switch");
    }
    #[test]
    fn coverage_for_loop() {
        assert_contains!(VALID_CONTROL_FLOW, "@for");
    }
    #[test]
    fn coverage_while_loop() {
        assert_contains!(VALID_CONTROL_FLOW, "@while");
    }
    #[test]
    fn coverage_try_catch() {
        assert_contains!(VALID_CONTROL_FLOW, "@try");
    }
    #[test]
    fn coverage_html_in_csharp() {
        assert_contains!(VALID_CONTROL_FLOW, "<span>");
    }
    #[test]
    fn coverage_razor_comment() {
        assert_contains!(VALID_COMMENTS, "@*");
    }
    #[test]
    fn coverage_html_comment() {
        assert_contains!(VALID_COMMENTS, "<!--");
    }
    #[test]
    fn coverage_csharp_comment() {
        assert_contains!(VALID_COMMENTS, "//");
    }
    #[test]
    fn coverage_interpolated_str() {
        assert_contains!(VALID_STRINGS_GENERICS, "$\"");
    }
    #[test]
    fn coverage_verbatim_str() {
        assert_contains!(VALID_STRINGS_GENERICS, "@\"");
    }
    #[test]
    fn coverage_generics() {
        assert_contains!(VALID_STRINGS_GENERICS, "List<string>");
    }
    #[test]
    fn coverage_lambda() {
        assert_contains!(VALID_STRINGS_GENERICS, "=>");
    }
    #[test]
    fn coverage_emoji() {
        assert_contains!(VALID_UNICODE, "😀");
    }
    #[test]
    fn coverage_supplementary() {
        assert_contains!(VALID_UNICODE, "𝐀");
    }
    #[test]
    fn coverage_rtl() {
        assert_contains!(VALID_UNICODE, "مرحبا");
    }
    #[test]
    fn coverage_section() {
        assert_contains!(VALID_SECTION_LAYOUT, "@section");
    }
    #[test]
    fn coverage_layout() {
        assert_contains!(VALID_SECTION_LAYOUT, "Layout");
    }
    #[test]
    fn coverage_viewimports() {
        assert_contains!(VALID_VIEWIMPORTS, "@addTagHelper");
    }
    #[test]
    fn coverage_stray_close() {
        assert_contains!(INVALID_STRAY_CLOSE, "</span>");
    }
    #[test]
    fn coverage_unclosed_block() {
        assert_contains!(INVALID_UNCLOSED_BLOCK, "@{");
    }
    #[test]
    fn coverage_partial_empty() {
        assert_eq!(PARTIAL_EMPTY.trim(), "");
    }
}
