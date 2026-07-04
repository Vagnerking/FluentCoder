//! LSP <-> Razor source-map glue for the projection broker (ADR 0002).
//!
//! LSP positions are 0-based `(line, character)`; the source map is 1-based
//! (Razor `#line`). These helpers convert between the two and remap whole
//! ranges, returning `None` for anything that lands in synthetic / unmapped
//! generated C# (so the broker never reports a result the user can't see).
//!
//! Ranges are half-open `[start, end)` (LSP). The exclusive `end` can sit one
//! column past the last mapped character (e.g. at a region boundary); we map
//! `end-1` and re-add the column in that case so a fully-mapped span still
//! round-trips.

use super::sourcemap::{Pos, RazorSourceMap};

/// 0-based LSP position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LspPos {
    pub line: u32,
    pub character: u32,
}

/// 0-based LSP range `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LspRange {
    pub start: LspPos,
    pub end: LspPos,
}

impl LspPos {
    pub fn new(line: u32, character: u32) -> Self {
        LspPos { line, character }
    }
}

/// LSP (0-based) -> source-map (1-based). `None` on overflow (malformed input).
fn to_map(p: LspPos) -> Option<Pos> {
    Some(Pos::new(p.line.checked_add(1)?, p.character.checked_add(1)?))
}

/// source-map (1-based) -> LSP (0-based). `None` if a coordinate is 0 (invalid).
fn from_map(p: Pos) -> Option<LspPos> {
    Some(LspPos {
        line: p.line.checked_sub(1)?,
        character: p.col.checked_sub(1)?,
    })
}

/// Map a generated-C# LSP position to the `.cshtml`. `None` if unmapped/synthetic.
pub fn generated_pos_to_source(map: &RazorSourceMap, p: LspPos) -> Option<LspPos> {
    from_map(map.to_source(to_map(p)?)?)
}

/// Map a `.cshtml` LSP position to the generated C#. `None` if outside any region.
pub fn source_pos_to_generated(map: &RazorSourceMap, p: LspPos) -> Option<LspPos> {
    from_map(map.to_generated(to_map(p)?)?)
}

/// Remap a generated-C# range to the `.cshtml`. Returns `None` unless the whole
/// range lies within ONE mapped region (the source map enforces same-region, so
/// a span never bridges synthetic C#). Exclusive `end` is handled by the map.
pub fn generated_range_to_source(map: &RazorSourceMap, r: LspRange) -> Option<LspRange> {
    let (s, e) = map.to_source_range(to_map(r.start)?, to_map(r.end)?)?;
    Some(LspRange {
        start: from_map(s)?,
        end: from_map(e)?,
    })
}

/// Remap a `.cshtml` range to the generated C# (same-region enforced).
pub fn source_range_to_generated(map: &RazorSourceMap, r: LspRange) -> Option<LspRange> {
    let (s, e) = map.to_generated_range(to_map(r.start)?, to_map(r.end)?)?;
    Some(LspRange {
        start: from_map(s)?,
        end: from_map(e)?,
    })
}

/// [`generated_range_to_source`] with cross-region CLAMPING — for DIAGNOSTICS,
/// where a truncated-but-visible squiggle beats a silently dropped one. Never
/// use for `TextEdit`s (those must map exactly; see the source-map contract on
/// synthetic ranges).
pub fn generated_range_to_source_clamped(map: &RazorSourceMap, r: LspRange) -> Option<LspRange> {
    let (s, e) = map.to_source_range_clamped(to_map(r.start)?, to_map(r.end)?)?;
    Some(LspRange {
        start: from_map(s)?,
        end: from_map(e)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Same real-shaped fixture as sourcemap tests: enhanced `#line (8,13)-(8,23)`
    // then `Model.City` (10 chars) on the next generated line (line 5, 1-based).
    const GEN: &str = "\
WriteLiteral(\"...\");
Write(
#nullable restore
#line (8,13)-(8,23) \"C:\\proj\\Views\\Home\\Index.cshtml\"
Model.City

#line default
";

    fn map() -> RazorSourceMap {
        RazorSourceMap::parse(GEN, "C:/proj/Views/Home/Index.cshtml")
    }

    #[test]
    fn pos_roundtrip_0based() {
        let m = map();
        // generated `City` is at 1-based (5,7) => 0-based (4,6); source 1-based
        // (8,19) => 0-based (7,18)
        let gen = LspPos::new(4, 6);
        let src = generated_pos_to_source(&m, gen).unwrap();
        assert_eq!(src, LspPos::new(7, 18));
        assert_eq!(source_pos_to_generated(&m, src), Some(gen));
    }

    #[test]
    fn range_remap_full_span_with_exclusive_end() {
        let m = map();
        // generated `Model.City` 0-based [(4,0), (4,10)) -> source [(7,12),(7,22))
        let gen = LspRange {
            start: LspPos::new(4, 0),
            end: LspPos::new(4, 10), // exclusive, one past the mapped span
        };
        let src = generated_range_to_source(&m, gen).unwrap();
        assert_eq!(src.start, LspPos::new(7, 12));
        assert_eq!(src.end, LspPos::new(7, 22));
    }

    #[test]
    fn unmapped_position_is_none() {
        let m = map();
        // line 0 (WriteLiteral prologue) is synthetic
        assert_eq!(generated_pos_to_source(&m, LspPos::new(0, 0)), None);
    }

    #[test]
    fn range_touching_synthetic_is_rejected() {
        let m = map();
        // a range whose end falls well past the mapped span -> None
        let gen = LspRange {
            start: LspPos::new(4, 0),
            end: LspPos::new(6, 0), // into the `#line default` synthetic zone
        };
        assert_eq!(generated_range_to_source(&m, gen), None);
    }

    #[test]
    fn max_u32_position_does_not_panic() {
        let m = map();
        // checked_add in to_map returns None on overflow — no panic, no wrap
        assert_eq!(
            generated_pos_to_source(&m, LspPos::new(u32::MAX, u32::MAX)),
            None
        );
        let r = LspRange {
            start: LspPos::new(0, 0),
            end: LspPos::new(u32::MAX, u32::MAX),
        };
        assert_eq!(generated_range_to_source(&m, r), None);
    }
}
