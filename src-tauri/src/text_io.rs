//! Text file I/O with encoding + line-ending detection, modelled on VS Code.
//!
//! Opening a file should "just work" regardless of how it was saved: a UTF-16
//! file with a BOM, a Windows-1252 file from a legacy tool, or the
//! decompiled-metadata `.cs` files Roslyn emits (which carry a UTF-8 BOM) must
//! all render as clean text — no stray `?`/`◇` glyphs from mis-decoding.
//!
//! On save we re-apply the file's original encoding, BOM and line ending so an
//! edit never silently rewrites those (the VS Code default).
//!
//! The buffer handed to the editor is always normalised to LF; the detected EOL
//! travels alongside it and is re-applied on write.

use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};

/// Detected line-ending style of a text buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Eol {
    /// `\n` — Unix/macOS.
    Lf,
    /// `\r\n` — Windows.
    Crlf,
}

/// A decoded text file plus the metadata needed to round-trip it on save.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecodedFile {
    /// File contents, normalised to LF line endings.
    pub content: String,
    /// Encoding label (e.g. "UTF-8", "UTF-16LE", "windows-1252").
    pub encoding: String,
    /// Whether the original file began with a byte-order mark.
    pub bom: bool,
    /// The original line-ending style.
    pub eol: Eol,
}

/// Picks the dominant line ending. CRLF wins only if it's the majority of the
/// line breaks (matching VS Code: a stray `\r\n` in an LF file stays LF).
fn detect_eol(text: &str) -> Eol {
    let crlf = text.matches("\r\n").count();
    let lf_total = text.matches('\n').count();
    let lone_lf = lf_total - crlf;
    if crlf > lone_lf {
        Eol::Crlf
    } else {
        Eol::Lf
    }
}

/// Strips a leading BOM and returns the matching encoding, if present.
fn sniff_bom(bytes: &[u8]) -> Option<(&'static Encoding, usize)> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some((encoding_rs::UTF_8, 3))
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        Some((encoding_rs::UTF_16LE, 2))
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        Some((encoding_rs::UTF_16BE, 2))
    } else {
        None
    }
}

/// Decodes raw bytes into text, detecting the encoding the way VS Code does:
/// 1. honour a BOM if present (UTF-8 / UTF-16 LE / BE);
/// 2. otherwise, if the bytes are valid UTF-8, use UTF-8 (no BOM);
/// 3. otherwise, run the chardetng detector (Latin-1 / Windows-1252 / …).
///
/// The returned content is normalised to LF; `eol`/`bom`/`encoding` record the
/// original so `encode_for_save` can reproduce the file faithfully.
pub fn decode(bytes: &[u8]) -> DecodedFile {
    // 1. BOM.
    if let Some((enc, bom_len)) = sniff_bom(bytes) {
        let (text, _, _) = enc.decode(&bytes[bom_len..]);
        let content = text.into_owned();
        let eol = detect_eol(&content);
        return DecodedFile {
            content: normalise_to_lf(content),
            encoding: enc.name().to_string(),
            bom: true,
            eol,
        };
    }

    // 2. Valid UTF-8 without a BOM is the common case — keep it cheap.
    if std::str::from_utf8(bytes).is_ok() {
        let content = String::from_utf8_lossy(bytes).into_owned();
        let eol = detect_eol(&content);
        return DecodedFile {
            content: normalise_to_lf(content),
            encoding: "UTF-8".to_string(),
            bom: false,
            eol,
        };
    }

    // 3. Legacy 8-bit / other: let chardetng guess.
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let enc = detector.guess(None, true);
    let (text, _, _) = enc.decode(bytes);
    let content = text.into_owned();
    let eol = detect_eol(&content);
    DecodedFile {
        content: normalise_to_lf(content),
        encoding: enc.name().to_string(),
        bom: false,
        eol,
    }
}

/// Decodes bytes forcing a specific encoding label ("Reopen with Encoding").
/// A BOM matching the forced encoding is still stripped; the EOL is detected
/// from the decoded text. Errors if the label isn't a known encoding.
pub fn decode_with(bytes: &[u8], encoding: &str) -> Result<DecodedFile, String> {
    let enc = Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("Encoding desconhecido: {encoding}"))?;
    // Honour a BOM only when it belongs to the chosen encoding.
    let (bom, start) = match sniff_bom(bytes) {
        Some((bom_enc, len)) if bom_enc == enc => (true, len),
        _ => (false, 0),
    };
    let (text, _, _) = enc.decode(&bytes[start..]);
    let content = text.into_owned();
    let eol = detect_eol(&content);
    Ok(DecodedFile {
        content: normalise_to_lf(content),
        encoding: enc.name().to_string(),
        bom,
        eol,
    })
}

/// Collapses CRLF to LF without allocating when the text is already LF-only.
fn normalise_to_lf(content: String) -> String {
    if content.contains('\r') {
        content.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        content
    }
}

/// Re-encodes an LF buffer back to bytes using the given encoding/EOL/BOM,
/// reproducing the original file format (VS Code's "preserve" default).
///
/// `content` is expected to be LF-normalised (as produced by [`decode`]); we
/// apply the requested EOL, then encode and prepend a BOM if requested.
pub fn encode_for_save(
    content: &str,
    encoding: &str,
    eol: Eol,
    bom: bool,
) -> Result<Vec<u8>, String> {
    let enc = Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("Encoding desconhecido: {encoding}"))?;

    // Apply the requested line ending. The buffer is LF, so only CRLF needs work.
    let with_eol = if eol == Eol::Crlf {
        content.replace('\n', "\r\n")
    } else {
        content.to_string()
    };

    // encoding_rs has NO encoder for UTF-16LE/BE — `Encoding::encode` silently
    // falls back to UTF-8 for them (output_encoding() == UTF-8). Encoding a
    // UTF-16 file through it would write UTF-8 bytes under a UTF-16 BOM, i.e.
    // corrupt the file. So we hand-encode UTF-16 here; all other encodings
    // (UTF-8, Windows-125x, ISO-8859-x, Shift_JIS, GBK, …) go through the crate.
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        let big_endian = enc == encoding_rs::UTF_16BE;
        let mut out = Vec::with_capacity(with_eol.len() * 2 + 2);
        if bom {
            out.extend_from_slice(if big_endian {
                &[0xFE, 0xFF]
            } else {
                &[0xFF, 0xFE]
            });
        }
        for unit in with_eol.encode_utf16() {
            out.extend_from_slice(&if big_endian {
                unit.to_be_bytes()
            } else {
                unit.to_le_bytes()
            });
        }
        return Ok(out);
    }

    let (encoded, _, had_unmappable) = enc.encode(&with_eol);
    if had_unmappable {
        // A char can't be represented in the target encoding — refuse rather
        // than silently writing `?` placeholders and corrupting the file.
        return Err(format!(
            "O conteúdo tem caracteres que não cabem em {}. Salve como UTF-8 para preservá-los.",
            enc.name()
        ));
    }

    let mut out = Vec::with_capacity(encoded.len() + 3);
    // Only UTF-8 carries a BOM among the crate-encodable encodings here.
    if bom && enc == encoding_rs::UTF_8 {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(&encoded);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_no_bom_roundtrips() {
        let d = decode(b"hello\nworld");
        assert_eq!(d.content, "hello\nworld");
        assert_eq!(d.encoding, "UTF-8");
        assert!(!d.bom);
        assert_eq!(d.eol, Eol::Lf);
        let bytes = encode_for_save(&d.content, &d.encoding, d.eol, d.bom).unwrap();
        assert_eq!(bytes, b"hello\nworld");
    }

    #[test]
    fn utf8_bom_is_stripped_and_restored() {
        let raw = [0xEF, 0xBB, 0xBF, b'a', b'b', b'c'];
        let d = decode(&raw);
        assert_eq!(d.content, "abc"); // no stray glyph at the start
        assert!(d.bom);
        assert_eq!(d.encoding, "UTF-8");
        let bytes = encode_for_save(&d.content, &d.encoding, d.eol, d.bom).unwrap();
        assert_eq!(bytes, raw);
    }

    #[test]
    fn crlf_detected_and_preserved() {
        let d = decode(b"a\r\nb\r\nc");
        assert_eq!(d.content, "a\nb\nc"); // editor always sees LF
        assert_eq!(d.eol, Eol::Crlf);
        let bytes = encode_for_save(&d.content, &d.encoding, d.eol, d.bom).unwrap();
        assert_eq!(bytes, b"a\r\nb\r\nc");
    }

    #[test]
    fn utf16le_bom_decodes() {
        // "Hi" in UTF-16LE with BOM.
        let raw = [0xFF, 0xFE, b'H', 0x00, b'i', 0x00];
        let d = decode(&raw);
        assert_eq!(d.content, "Hi");
        assert!(d.bom);
        assert_eq!(d.encoding, "UTF-16LE");
    }

    #[test]
    fn utf16le_roundtrips_as_real_utf16_not_utf8() {
        // Regression: encoding_rs has no UTF-16 encoder, so naive `enc.encode`
        // would emit UTF-8 bytes under a UTF-16 BOM and corrupt the file. The
        // bytes must come back byte-for-byte as UTF-16LE.
        let raw = [0xFF, 0xFE, b'H', 0x00, b'i', 0x00];
        let d = decode(&raw);
        let bytes = encode_for_save(&d.content, &d.encoding, d.eol, d.bom).unwrap();
        assert_eq!(bytes, raw);
    }

    #[test]
    fn utf16be_roundtrips() {
        // "Hi" in UTF-16BE with BOM.
        let raw = [0xFE, 0xFF, 0x00, b'H', 0x00, b'i'];
        let d = decode(&raw);
        assert_eq!(d.content, "Hi");
        assert_eq!(d.encoding, "UTF-16BE");
        let bytes = encode_for_save(&d.content, &d.encoding, d.eol, d.bom).unwrap();
        assert_eq!(bytes, raw);
    }

    #[test]
    fn utf16_applies_crlf_in_code_units() {
        // CRLF must be two UTF-16 code units, not raw bytes spliced in.
        let d = DecodedFile {
            content: "a\nb".to_string(),
            encoding: "UTF-16LE".to_string(),
            bom: false,
            eol: Eol::Crlf,
        };
        let bytes = encode_for_save(&d.content, &d.encoding, d.eol, d.bom).unwrap();
        // a \r \n b  →  61 00 0D 00 0A 00 62 00
        assert_eq!(bytes, [0x61, 0x00, 0x0D, 0x00, 0x0A, 0x00, 0x62, 0x00]);
    }

    #[test]
    fn windows1252_detected_without_bom() {
        // 0xE9 is 'é' in Windows-1252 / Latin-1, invalid as standalone UTF-8.
        let raw = [b'c', b'a', b'f', b'\xE9'];
        let d = decode(&raw);
        assert!(!d.bom);
        assert!(d.content.ends_with('é'), "got {:?}", d.content);
        assert_ne!(d.encoding, "UTF-8");
    }

    #[test]
    fn lone_crlf_in_lf_file_stays_lf() {
        let d = decode(b"a\nb\r\nc\nd\n");
        assert_eq!(d.eol, Eol::Lf); // majority is LF
    }

    #[test]
    fn unmappable_char_is_refused() {
        // An emoji can't be encoded in Windows-1252.
        let err = encode_for_save("hi 😀", "windows-1252", Eol::Lf, false);
        assert!(err.is_err());
    }
}
