//! Razor `#line` source map (Option B / projection broker).
//!
//! The Razor compiler emits the projected C# (`.g.cs`) with `#line` directives
//! that map regions of the generated C# back to the original `.cshtml`. This
//! module parses those directives and maps positions BOTH ways
//! (generated C# <-> `.cshtml`), so the broker can forward LSP requests to the
//! projected document and remap the results onto the Razor file.
//!
//! Directive forms emitted by `Microsoft.CodeAnalysis.Razor.Compiler`:
//!   - enhanced:  `#line (sl,sc)-(el,ec) [charOffset] "file"`  (C# 10+)
//!   - classic:   `#line N "file"`  /  `#line N`
//!   - region end: `#line default`  /  `#line hidden`
//!
//! Mapping model: within an enhanced region the generated text is a VERBATIM
//! copy of the source C#, so it maps char-for-char. The first generated line of
//! the region begins at `charOffset` (or column 1) and corresponds to the
//! directive's `(sl,sc)`; subsequent lines align 1:1 in column.
//!
//! Positions are 1-based `(line, col)` — the C#/Razor `#line` convention. The
//! broker converts to/from LSP (0-based) at the edge. Pure logic: no Roslyn,
//! no Monaco, no external crates.

/// 1-based `(line, col)` position (Razor/C# `#line` convention).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pos {
    pub line: u32,
    pub col: u32,
}

impl Pos {
    pub fn new(line: u32, col: u32) -> Self {
        Pos { line, col }
    }
    /// `start <= self` in (line, col) order.
    fn ge(self, start: Pos) -> bool {
        (self.line, self.col) >= (start.line, start.col)
    }
    /// `self <= end` in (line, col) order.
    fn le(self, end: Pos) -> bool {
        (self.line, self.col) <= (end.line, end.col)
    }
}

/// A contiguous mapped region: a verbatim slice of source C# copied into the
/// generated document.
#[derive(Debug, Clone)]
struct Region {
    /// Source `.cshtml` span (1-based), from the directive.
    src_start: Pos,
    src_end: Pos,
    /// First generated line of the region and the column its content starts at.
    gen_start: Pos,
    /// Last generated line of the region (inclusive).
    gen_end_line: u32,
}

#[derive(Debug)]
enum Directive {
    /// `#line (sl,sc)-(el,ec) [offset] "file"`
    Enhanced {
        src_start: Pos,
        src_end: Pos,
        offset: Option<u32>,
        file: String,
    },
    /// `#line N "file"` / `#line N`
    Classic { line: u32, file: Option<String> },
    /// `#line default` / `#line hidden` — ends the current mapped region.
    End,
}

/// Bidirectional `#line` map for one target `.cshtml`, built from the generated
/// C# text.
pub struct RazorSourceMap {
    regions: Vec<Region>,
}

impl RazorSourceMap {
    /// Parse `generated` C# and keep only the regions that map to `target_cshtml`
    /// (path compared case-insensitively, slash-normalized — Windows-friendly).
    pub fn parse(generated: &str, target_cshtml: &str) -> Self {
        let target = norm_path(target_cshtml);
        let mut regions: Vec<Region> = Vec::new();

        // An open region awaiting its end (next directive closes it).
        struct Open {
            src_start: Pos,
            src_end: Pos,
            gen_start: Pos,
            matches_target: bool,
            /// `Some(N)` for classic `#line N`: source end is line-only and spans
            /// until the region closes, so it is computed at close time.
            classic_line: Option<u32>,
        }
        let mut open: Option<Open> = None;
        // The file the compiler currently REPORTS positions against. C# semantics:
        // a bare `#line N` keeps the file of the last named directive; `#line
        // default`/`hidden` resets to the generated file itself. Assuming a bare
        // `#line N` belonged to the target fabricated regions pointing at the
        // `.cshtml` from spans that actually report the `.g.cs`.
        let mut reported_file: Option<String> = None;

        // close the open region at generated line `before_line` (inclusive)
        macro_rules! close_open {
            ($before:expr) => {
                if let Some(o) = open.take() {
                    if o.matches_target && $before >= o.gen_start.line {
                        let src_end = match o.classic_line {
                            // classic spans line-for-line with the generated region
                            Some(n) => Pos::new(n + ($before - o.gen_start.line), u32::MAX),
                            None => o.src_end,
                        };
                        regions.push(Region {
                            src_start: o.src_start,
                            src_end,
                            gen_start: o.gen_start,
                            gen_end_line: $before,
                        });
                    }
                }
            };
        }

        for (idx, raw) in generated.lines().enumerate() {
            let gen_line = (idx as u32) + 1; // 1-based
            let Some(dir) = parse_directive(raw) else {
                continue;
            };
            // any directive terminates the previous region at the prior line
            close_open!(gen_line - 1);
            match dir {
                Directive::Enhanced {
                    src_start,
                    src_end,
                    offset,
                    file,
                } => {
                    let matches_target = norm_path(&file) == target;
                    reported_file = Some(file);
                    open = Some(Open {
                        src_start,
                        src_end,
                        gen_start: Pos::new(gen_line + 1, offset.unwrap_or(1)),
                        matches_target,
                        classic_line: None,
                    });
                }
                Directive::Classic { line, file } => {
                    // classic = line-only mapping; columns pass through. src_end is
                    // computed at close (spans line-for-line with the generated region).
                    // A bare `#line N` keeps the previously reported file (C#
                    // semantics) — it is NOT assumed to be the target.
                    if let Some(f) = file {
                        reported_file = Some(f);
                    }
                    let matches_target = reported_file
                        .as_deref()
                        .map(norm_path)
                        .map(|f| f == target)
                        .unwrap_or(false);
                    open = Some(Open {
                        src_start: Pos::new(line, 1),
                        src_end: Pos::new(line, u32::MAX),
                        gen_start: Pos::new(gen_line + 1, 1),
                        matches_target,
                        classic_line: Some(line),
                    });
                }
                Directive::End => {
                    // `#line default`/`hidden`: positions report the generated
                    // file again — a following bare `#line N` must not claim the target.
                    reported_file = None;
                }
            }
        }
        // Close a trailing region at EOF.
        let last = generated.lines().count() as u32;
        close_open!(last);

        RazorSourceMap { regions }
    }

    fn region_for_generated(&self, p: Pos) -> Option<&Region> {
        self.regions
            .iter()
            .find(|r| p.line >= r.gen_start.line && p.line <= r.gen_end_line)
    }

    fn region_for_source(&self, p: Pos) -> Option<&Region> {
        self.regions
            .iter()
            .find(|r| p.ge(r.src_start) && p.le(r.src_end))
    }

    /// Map a generated-C# position to the `.cshtml`. `None` for synthetic
    /// (unmapped / `#line default`/`hidden`) regions.
    pub fn to_source(&self, p: Pos) -> Option<Pos> {
        let r = self.region_for_generated(p)?;
        let dl = p.line - r.gen_start.line;
        // On the first generated line, columns before the mapped content start
        // are generated indentation (e.g. the directive's char offset), not part
        // of the source span.
        if dl == 0 && p.col < r.gen_start.col {
            return None;
        }
        let line = r.src_start.line.saturating_add(dl);
        let col = if dl == 0 {
            // first line: shift by the start-column delta
            r.src_start.col.saturating_add(p.col - r.gen_start.col)
        } else {
            p.col // subsequent lines are verbatim, columns align 1:1
        };
        let mapped = Pos::new(line, col);
        // Reject positions outside the mapped source span (e.g. trailing generated
        // lines before `#line default`) — keeps the "synthetic is unmapped" contract.
        if !(mapped.ge(r.src_start) && mapped.le(r.src_end)) {
            return None;
        }
        Some(mapped)
    }

    /// Map a `.cshtml` position to the generated C#. `None` if not inside a
    /// mapped region.
    pub fn to_generated(&self, p: Pos) -> Option<Pos> {
        let r = self.region_for_source(p)?;
        let dl = p.line - r.src_start.line;
        let line = r.gen_start.line.saturating_add(dl);
        // Don't map past the generated region's extent.
        if line > r.gen_end_line {
            return None;
        }
        let col = if dl == 0 {
            r.gen_start.col.saturating_add(p.col.saturating_sub(r.src_start.col))
        } else {
            p.col
        };
        Some(Pos::new(line, col))
    }

    // ── range mapping (same-region enforced, exclusive-end aware) ───────────

    fn gen_region_index(&self, p: Pos) -> Option<usize> {
        self.regions
            .iter()
            .position(|r| p.line >= r.gen_start.line && p.line <= r.gen_end_line)
    }

    fn src_region_index(&self, p: Pos) -> Option<usize> {
        self.regions
            .iter()
            .position(|r| p.ge(r.src_start) && p.le(r.src_end))
    }

    /// Map an exclusive `[.., end)` endpoint within `region`: try `end`, else
    /// `end-1` then re-add a column, else — for the common "through end of line"
    /// form whose exclusive end sits at COLUMN 1 OF THE NEXT LINE — map the end
    /// of the previous line. All attempts must stay in the SAME region.
    fn map_excl_end<RI, MP>(&self, end: Pos, region: usize, region_index: RI, map: MP) -> Option<Pos>
    where
        RI: Fn(Pos) -> Option<usize>,
        MP: Fn(Pos) -> Option<Pos>,
    {
        if region_index(end) == Some(region) {
            if let Some(p) = map(end) {
                return Some(p);
            }
        }
        if end.col > 1 {
            let prev = Pos::new(end.line, end.col - 1);
            if region_index(prev) == Some(region) {
                if let Some(p) = map(prev) {
                    return Some(Pos::new(p.line, p.col.saturating_add(1)));
                }
            }
        } else if end.line > 1 {
            // end == (L, 1): the span covers up to the END of line L-1. Backing
            // one column was impossible (col 1), and dropping the whole range
            // here lost every "to end of line" diagnostic/highlight. Map line
            // L-1 and return the start of the NEXT source line as the exclusive
            // end (same LSP meaning).
            let prev_line = Pos::new(end.line - 1, 1);
            if region_index(prev_line) == Some(region) {
                if let Some(p) = map(prev_line) {
                    return Some(Pos::new(p.line.saturating_add(1), 1));
                }
            }
        }
        None
    }

    /// Map a generated range `[start, end)` to source, requiring both endpoints in
    /// the SAME mapped region so the span never bridges synthetic C#.
    pub fn to_source_range(&self, start: Pos, end: Pos) -> Option<(Pos, Pos)> {
        if (end.line, end.col) < (start.line, start.col) {
            return None; // reversed range
        }
        let region = self.gen_region_index(start)?;
        let s = self.to_source(start)?;
        let e = self.map_excl_end(end, region, |p| self.gen_region_index(p), |p| self.to_source(p))?;
        Some((s, e))
    }

    /// [`to_source_range`] with a CLAMP fallback for spans that cross regions:
    /// when the start maps but the end lands in another region (or synthetic C# —
    /// e.g. a Roslyn diagnostic spanning a `@{ }` block the Razor compiler sliced
    /// into several `#line` regions), the result is truncated at the start
    /// region's source end instead of being dropped entirely. For DIAGNOSTICS:
    /// a truncated-but-visible squiggle beats a silently missing one. Never use
    /// for `TextEdit`s (edits must map exactly).
    pub fn to_source_range_clamped(&self, start: Pos, end: Pos) -> Option<(Pos, Pos)> {
        if let Some(r) = self.to_source_range(start, end) {
            return Some(r);
        }
        if (end.line, end.col) < (start.line, start.col) {
            return None; // reversed
        }
        let idx = self.gen_region_index(start)?;
        let s = self.to_source(start)?;
        let e = self.regions[idx].src_end;
        if (e.line, e.col) <= (s.line, s.col) {
            return None; // clamp collapsed the span to nothing
        }
        Some((s, e))
    }

    /// Source -> generated counterpart of [`to_source_range`].
    pub fn to_generated_range(&self, start: Pos, end: Pos) -> Option<(Pos, Pos)> {
        if (end.line, end.col) < (start.line, start.col) {
            return None; // reversed range
        }
        let region = self.src_region_index(start)?;
        let s = self.to_generated(start)?;
        let e = self.map_excl_end(end, region, |p| self.src_region_index(p), |p| self.to_generated(p))?;
        Some((s, e))
    }

    /// Number of mapped regions for the target (diagnostics/testing).
    pub fn region_count(&self) -> usize {
        self.regions.len()
    }
}

// ── path normalization ──────────────────────────────────────────────────────

fn norm_path(p: &str) -> String {
    p.replace('\\', "/").to_ascii_lowercase()
}

// ── directive parsing (dependency-free) ─────────────────────────────────────

fn parse_directive(raw: &str) -> Option<Directive> {
    let t = raw.trim_start();
    let rest = t.strip_prefix("#line")?;
    // require a separator after `#line` (space or `(`), else it's e.g. `#linexyz`
    let rest = match rest.chars().next() {
        Some(c) if c.is_whitespace() => rest.trim_start(),
        Some('(') => rest,
        _ => return None,
    };
    if rest.starts_with("default") {
        return Some(Directive::End);
    }
    if rest.starts_with("hidden") {
        return Some(Directive::End);
    }
    if rest.starts_with('(') {
        return parse_enhanced(rest);
    }
    parse_classic(rest)
}

/// `(sl,sc)-(el,ec) [offset] "file"`
fn parse_enhanced(s: &str) -> Option<Directive> {
    let (src_start, after1) = parse_paren_pair(s)?;
    let after1 = after1.trim_start();
    let after1 = after1.strip_prefix('-')?.trim_start();
    let (src_end, after2) = parse_paren_pair(after1)?;
    let after2 = after2.trim_start();

    // optional integer char offset before the filename
    let (offset, after3) = take_u32(after2);
    let after3 = after3.trim_start();

    let file = parse_quoted(after3)?;
    Some(Directive::Enhanced {
        src_start,
        src_end,
        offset,
        file,
    })
}

/// `N "file"` or `N`
fn parse_classic(s: &str) -> Option<Directive> {
    let (n, rest) = take_u32(s);
    let n = n?;
    let rest = rest.trim_start();
    let file = if rest.starts_with('"') {
        parse_quoted(rest)
    } else {
        None
    };
    Some(Directive::Classic { line: n, file })
}

/// Parse `(a,b)` at the start of `s`, returning the `Pos` and the remainder.
fn parse_paren_pair(s: &str) -> Option<(Pos, &str)> {
    let s = s.strip_prefix('(')?;
    let close = s.find(')')?;
    let inner = &s[..close];
    let mut parts = inner.split(',');
    let a: u32 = parts.next()?.trim().parse().ok()?;
    let b: u32 = parts.next()?.trim().parse().ok()?;
    Some((Pos::new(a, b), &s[close + 1..]))
}

/// Take a leading optional `u32` (with surrounding spaces already trimmed by
/// caller); returns `(value, remainder)`. If no digits, value is `None`.
fn take_u32(s: &str) -> (Option<u32>, &str) {
    let s = s.trim_start();
    let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    if end == 0 {
        (None, s)
    } else {
        (s[..end].parse().ok(), &s[end..])
    }
}

/// Parse a `"..."` quoted string at the start of `s`.
fn parse_quoted(s: &str) -> Option<String> {
    let s = s.strip_prefix('"')?;
    let end = s.find('"')?;
    Some(s[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors the real generated layout (see tools/razor-lsp-probe spike):
    //   `#line (8,13)-(8,23) "..Index.cshtml"` then `Model.City` on the next line.
    const GEN: &str = "\
WriteLiteral(\"...\");
Write(
#nullable restore
#line (8,13)-(8,23) \"C:\\proj\\Views\\Home\\Index.cshtml\"
Model.City

#line default
#line hidden
#nullable disable
#line (2,3)-(4,1) \"C:\\proj\\Views\\Home\\Index.cshtml\"
    var greeting = \"Ola\";
    Other();
#line default
";

    fn map() -> RazorSourceMap {
        RazorSourceMap::parse(GEN, "C:/proj/Views/Home/Index.cshtml")
    }

    #[test]
    fn parses_both_regions_for_target() {
        assert_eq!(map().region_count(), 2);
    }

    #[test]
    fn gen_to_source_single_line_expression() {
        let m = map();
        // `Model.City` is generated line 5, col 1 -> source (8,13)
        assert_eq!(m.to_source(Pos::new(5, 1)), Some(Pos::new(8, 13)));
        // `City` starts at generated line 5 col 7 -> source (8, 19)
        assert_eq!(m.to_source(Pos::new(5, 7)), Some(Pos::new(8, 19)));
    }

    #[test]
    fn source_to_gen_single_line_expression() {
        let m = map();
        assert_eq!(m.to_generated(Pos::new(8, 13)), Some(Pos::new(5, 1)));
        assert_eq!(m.to_generated(Pos::new(8, 19)), Some(Pos::new(5, 7)));
    }

    #[test]
    fn multiline_region_maps_line_delta_and_verbatim_columns() {
        let m = map();
        // region 2: directive line 10 -> gen content lines 11-12, src (2,3)-(4,1)
        // first gen line (11) col 1 -> src (2,3)
        assert_eq!(m.to_source(Pos::new(11, 1)), Some(Pos::new(2, 3)));
        // second gen line (12) col 5 -> src line 3, col 5 (verbatim)
        assert_eq!(m.to_source(Pos::new(12, 5)), Some(Pos::new(3, 5)));
    }

    #[test]
    fn synthetic_zones_are_unmapped() {
        let m = map();
        assert_eq!(m.to_source(Pos::new(1, 1)), None); // WriteLiteral (prologue)
        assert_eq!(m.to_source(Pos::new(7, 1)), None); // `#line default` zone
        assert_eq!(m.to_source(Pos::new(9, 1)), None); // `#nullable disable` gap
    }

    #[test]
    fn regions_for_other_files_are_ignored() {
        let gen = "#line (1,1)-(1,5) \"C:\\proj\\Other.cshtml\"\nFoo()\n#line default\n";
        let m = RazorSourceMap::parse(gen, "C:/proj/Views/Home/Index.cshtml");
        assert_eq!(m.region_count(), 0);
        assert_eq!(m.to_source(Pos::new(2, 1)), None);
    }

    #[test]
    fn parses_offset_form() {
        // enhanced with explicit char offset before the filename
        let gen = "#line (5,10)-(5,20) 9 \"C:\\proj\\Views\\Home\\Index.cshtml\"\n        Model.X\n#line default\n";
        let m = RazorSourceMap::parse(gen, "C:/proj/Views/Home/Index.cshtml");
        // gen content line 2, start col 9 -> src (5,10)
        assert_eq!(m.to_source(Pos::new(2, 9)), Some(Pos::new(5, 10)));
    }

    #[test]
    fn offset_indentation_before_span_is_unmapped() {
        let gen = "#line (5,10)-(5,20) 9 \"C:\\proj\\Views\\Home\\Index.cshtml\"\n        Model.X\n#line default\n";
        let m = RazorSourceMap::parse(gen, "C:/proj/Views/Home/Index.cshtml");
        // cols 1..8 on the first generated line are indentation before offset 9
        assert_eq!(m.to_source(Pos::new(2, 1)), None);
        assert_eq!(m.to_source(Pos::new(2, 9)), Some(Pos::new(5, 10)));
    }

    #[test]
    fn generated_position_past_source_span_is_unmapped() {
        // region 1 spans gen lines 5-6, but source is single-line (8,13)-(8,23);
        // the trailing blank gen line 6 must NOT map to a phantom source line 9.
        let m = map();
        assert_eq!(m.to_source(Pos::new(6, 1)), None);
    }

    #[test]
    fn classic_line_multiline_roundtrip() {
        let gen = "#line 10 \"C:\\proj\\Views\\Home\\Index.cshtml\"\nfirst();\nsecond();\n#line default\n";
        let m = RazorSourceMap::parse(gen, "C:/proj/Views/Home/Index.cshtml");
        assert_eq!(m.to_source(Pos::new(2, 1)), Some(Pos::new(10, 1)));
        assert_eq!(m.to_source(Pos::new(3, 5)), Some(Pos::new(11, 5)));
        // reverse for line N+1 (was broken before: classic src_end was line N only)
        assert_eq!(m.to_generated(Pos::new(11, 5)), Some(Pos::new(3, 5)));
    }

    #[test]
    fn to_source_range_same_region_full_span() {
        let m = map();
        // generated `Model.City` [(5,1),(5,11)) -> source [(8,13),(8,23))
        let (s, e) = m.to_source_range(Pos::new(5, 1), Pos::new(5, 11)).unwrap();
        assert_eq!(s, Pos::new(8, 13));
        assert_eq!(e, Pos::new(8, 23));
    }

    #[test]
    fn to_source_range_cross_region_is_none() {
        let m = map();
        // start in region 1 (gen line 5), end in region 2 (gen line 11) -> reject
        assert_eq!(m.to_source_range(Pos::new(5, 1), Pos::new(11, 2)), None);
    }

    #[test]
    fn to_source_range_reversed_is_none() {
        let m = map();
        // end before start (within one region) must be rejected, not silently swapped
        assert_eq!(m.to_source_range(Pos::new(5, 7), Pos::new(5, 1)), None);
    }

    #[test]
    fn excl_end_at_next_line_col1_maps_to_end_of_prev_line() {
        let m = map();
        // region 2: gen lines 11-12 <- src (2,3)-(4,1). A "to end of line" span
        // over gen line 11 has exclusive end (12,1) — col 1, so the old one-column
        // backup couldn't apply and the whole range was dropped.
        let (s, e) = m.to_source_range(Pos::new(11, 1), Pos::new(12, 1)).unwrap();
        assert_eq!(s, Pos::new(2, 3));
        // exclusive end = start of the NEXT source line (same LSP meaning).
        assert_eq!(e, Pos::new(3, 1));
    }

    #[test]
    fn cross_region_range_is_clamped_for_diagnostics() {
        let m = map();
        // start in region 1 (gen line 5), end in region 2 (gen line 11): the
        // strict mapper rejects, the clamped one truncates at region 1's src end.
        assert_eq!(m.to_source_range(Pos::new(5, 1), Pos::new(11, 2)), None);
        let (s, e) = m.to_source_range_clamped(Pos::new(5, 1), Pos::new(11, 2)).unwrap();
        assert_eq!(s, Pos::new(8, 13));
        assert_eq!(e, Pos::new(8, 23)); // region 1 source end
        // Reversed input still rejected; fully synthetic start still None.
        assert_eq!(m.to_source_range_clamped(Pos::new(5, 7), Pos::new(5, 1)), None);
        assert_eq!(m.to_source_range_clamped(Pos::new(1, 1), Pos::new(5, 2)), None);
    }

    #[test]
    fn bare_line_directive_keeps_reported_file_semantics() {
        // C# semantics: `#line N` (no file) keeps the last named file; after
        // `#line default` positions report the .g.cs again, so a bare directive
        // must NOT fabricate a region pointing at the target.
        let target = "C:/proj/Views/Home/Index.cshtml";
        // Named classic for the target, then default, then a BARE #line.
        let gen = "#line 10 \"C:\\proj\\Views\\Home\\Index.cshtml\"\nreal();\n#line default\nsynthetic();\n#line 99\nghost();\n#line default\n";
        let m = RazorSourceMap::parse(gen, target);
        assert_eq!(m.region_count(), 1, "bare #line after default must not map to target");
        assert_eq!(m.to_source(Pos::new(2, 1)), Some(Pos::new(10, 1)));
        assert_eq!(m.to_source(Pos::new(6, 1)), None, "ghost() reports the .g.cs, not the target");

        // A bare #line while the target IS the reported file keeps mapping to it.
        let gen2 = "#line 10 \"C:\\proj\\Views\\Home\\Index.cshtml\"\nreal();\n#line 20\nmore();\n#line default\n";
        let m2 = RazorSourceMap::parse(gen2, target);
        assert_eq!(m2.region_count(), 2);
        assert_eq!(m2.to_source(Pos::new(4, 1)), Some(Pos::new(20, 1)));

        // A bare #line with NO prior named file (start of file) reports the .g.cs.
        let gen3 = "#line 5\norphan();\n#line default\n";
        let m3 = RazorSourceMap::parse(gen3, target);
        assert_eq!(m3.region_count(), 0);
    }

    #[test]
    fn crlf_generated_text() {
        let gen = "#line (8,13)-(8,23) \"C:\\proj\\Views\\Home\\Index.cshtml\"\r\nModel.City\r\n#line default\r\n";
        let m = RazorSourceMap::parse(gen, "C:/proj/Views/Home/Index.cshtml");
        assert_eq!(m.to_source(Pos::new(2, 7)), Some(Pos::new(8, 19)));
    }
}
