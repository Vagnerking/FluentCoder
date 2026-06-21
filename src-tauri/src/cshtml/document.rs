/// Incremental document store for the CSHTML engine (issue #33).
///
/// Tracks open documents as versioned snapshots. All mutations are
/// validated against the current version to reject stale updates.

use std::collections::HashMap;
use crate::cshtml::types::{
    DocumentId, DocumentVersion, Snapshot, TextEdit, TextPosition, TextRange,
};

// ── UTF-16 / byte conversion ──────────────────────────────────────────────────

/// Converts a (line, UTF-16-char) position to a byte offset in `text`.
/// Returns `None` if the position is out of bounds.
pub fn utf16_pos_to_byte_offset(text: &str, pos: TextPosition) -> Option<usize> {
    let mut current_line = 0u32;
    let mut byte_offset = 0usize;

    for line_str in text.split('\n') {
        if current_line == pos.line {
            // Walk UTF-16 code units within this line.
            let mut utf16_count = 0u32;
            for ch in line_str.chars() {
                if utf16_count == pos.character {
                    return Some(byte_offset);
                }
                utf16_count += ch.len_utf16() as u32;
                byte_offset += ch.len_utf8();
            }
            // Position at end of line (before '\n').
            if utf16_count == pos.character {
                return Some(byte_offset);
            }
            return None;
        }
        byte_offset += line_str.len() + 1; // +1 for '\n'
        current_line += 1;
    }
    None
}

/// Applies a list of `TextEdit`s to `text`, returning the new string.
///
/// Edits **must be non-overlapping and sorted in reverse document order**
/// (bottom-to-top, then right-to-left) so each byte offset remains valid
/// after previous substitutions. The caller (or `DocumentStore::apply_changes`)
/// is responsible for sorting before calling.
fn apply_edits_sorted(text: &str, edits: &[TextEdit]) -> Result<String, String> {
    let mut result = text.to_string();

    for edit in edits {
        let start = utf16_pos_to_byte_offset(&result, edit.range.start)
            .ok_or_else(|| format!("start position {:?} out of range", edit.range.start))?;
        let end = utf16_pos_to_byte_offset(&result, edit.range.end)
            .ok_or_else(|| format!("end position {:?} out of range", edit.range.end))?;
        if start > end {
            return Err(format!("inverted range: start={start} end={end}"));
        }
        result.replace_range(start..end, &edit.new_text);
    }
    Ok(result)
}

/// Sorts edits in reverse document order (bottom-to-top within the buffer).
fn sort_edits_reverse(edits: &mut Vec<TextEdit>) {
    edits.sort_unstable_by(|a, b| {
        b.range.start.line
            .cmp(&a.range.start.line)
            .then(b.range.start.character.cmp(&a.range.start.character))
    });
}

// ── DocumentStore ─────────────────────────────────────────────────────────────

/// Error variants returned by `DocumentStore` operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// Document is not open.
    NotFound(DocumentId),
    /// Incoming version is not strictly greater than the current version.
    StaleVersion {
        doc: DocumentId,
        current: DocumentVersion,
        received: DocumentVersion,
    },
    /// A text edit could not be applied (position out of range, inverted range, …).
    EditFailed(String),
    /// Attempted to open a document that is already open.
    AlreadyOpen(DocumentId),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(id) => write!(f, "document not open: {id}"),
            Self::StaleVersion { doc, current, received } => write!(
                f,
                "stale version for {doc}: current={}, received={}",
                current.0, received.0
            ),
            Self::EditFailed(msg) => write!(f, "edit failed: {msg}"),
            Self::AlreadyOpen(id) => write!(f, "document already open: {id}"),
        }
    }
}

/// Holds the current `Snapshot` for each open document.
///
/// All methods take `&mut self`; the store is not `Send` by itself. Wrap in
/// `Arc<Mutex<DocumentStore>>` when sharing across async tasks.
#[derive(Default)]
pub struct DocumentStore {
    docs: HashMap<DocumentId, Snapshot>,
}

impl DocumentStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Opens a new document. Returns `StoreError::AlreadyOpen` if the URI is
    /// already tracked — the caller should call `apply_changes` instead.
    pub fn open_document(
        &mut self,
        uri: impl Into<String>,
        version: i32,
        text: impl Into<String>,
    ) -> Result<(), StoreError> {
        let id = DocumentId::new(uri);
        if self.docs.contains_key(&id) {
            return Err(StoreError::AlreadyOpen(id));
        }
        self.docs.insert(
            id.clone(),
            Snapshot {
                id,
                version: DocumentVersion(version),
                text: text.into(),
            },
        );
        Ok(())
    }

    /// Applies incremental text edits, bumping the document to `new_version`.
    ///
    /// * Rejects the update if `new_version <= current_version`.
    /// * Edits are applied in reverse document order to preserve byte offsets.
    pub fn apply_changes(
        &mut self,
        uri: &str,
        new_version: i32,
        mut changes: Vec<TextEdit>,
    ) -> Result<(), StoreError> {
        let id = DocumentId::new(uri);
        let snap = self.docs.get_mut(&id).ok_or_else(|| StoreError::NotFound(id.clone()))?;

        let new_ver = DocumentVersion(new_version);
        if new_ver <= snap.version {
            return Err(StoreError::StaleVersion {
                doc: id,
                current: snap.version,
                received: new_ver,
            });
        }

        sort_edits_reverse(&mut changes);
        let new_text =
            apply_edits_sorted(&snap.text, &changes).map_err(StoreError::EditFailed)?;

        snap.text = new_text;
        snap.version = new_ver;
        Ok(())
    }

    /// Replaces the full text of the document (for whole-document sync).
    pub fn replace_full(
        &mut self,
        uri: &str,
        new_version: i32,
        new_text: impl Into<String>,
    ) -> Result<(), StoreError> {
        let id = DocumentId::new(uri);
        let snap = self.docs.get_mut(&id).ok_or_else(|| StoreError::NotFound(id.clone()))?;

        let new_ver = DocumentVersion(new_version);
        if new_ver <= snap.version {
            return Err(StoreError::StaleVersion {
                doc: id,
                current: snap.version,
                received: new_ver,
            });
        }

        snap.text = new_text.into();
        snap.version = new_ver;
        Ok(())
    }

    /// Closes a document, releasing its memory. Idempotent.
    pub fn close_document(&mut self, uri: &str) {
        self.docs.remove(&DocumentId::new(uri));
    }

    /// Returns an immutable snapshot of the document, or `None` if not open.
    pub fn snapshot(&self, uri: &str) -> Option<&Snapshot> {
        self.docs.get(&DocumentId::new(uri))
    }

    /// Returns all currently-open document ids.
    pub fn open_ids(&self) -> impl Iterator<Item = &DocumentId> {
        self.docs.keys()
    }

    /// Number of open documents.
    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

impl Snapshot {
    /// Converts a byte offset to a (line, UTF-16-char) position.
    pub fn byte_to_position(&self, byte_offset: usize) -> Option<TextPosition> {
        if byte_offset > self.text.len() {
            return None;
        }
        let prefix = &self.text[..byte_offset];
        let line = prefix.chars().filter(|&c| c == '\n').count() as u32;
        let line_start = prefix.rfind('\n').map(|i| i + 1).unwrap_or(0);
        let character = prefix[line_start..].encode_utf16().count() as u32;
        Some(TextPosition { line, character })
    }

    /// Extracts the text covered by `range`. Returns `None` on out-of-bounds.
    pub fn text_at(&self, range: TextRange) -> Option<&str> {
        let start = utf16_pos_to_byte_offset(&self.text, range.start)?;
        let end = utf16_pos_to_byte_offset(&self.text, range.end)?;
        self.text.get(start..end)
    }

    /// Iterates over lines as `(line_index, &str)`.
    pub fn lines(&self) -> impl Iterator<Item = (usize, &str)> {
        self.text.lines().enumerate()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(line: u32, ch: u32) -> TextPosition {
        TextPosition { line, character: ch }
    }

    fn range(sl: u32, sc: u32, el: u32, ec: u32) -> TextRange {
        TextRange { start: pos(sl, sc), end: pos(el, ec) }
    }

    // ── open / close ──────────────────────────────────────────────────────────

    #[test]
    fn open_new_document() {
        let mut store = DocumentStore::new();
        store.open_document("file:///a.cshtml", 1, "hello").unwrap();
        let snap = store.snapshot("file:///a.cshtml").unwrap();
        assert_eq!(snap.text(), "hello");
        assert_eq!(snap.version, DocumentVersion(1));
    }

    #[test]
    fn open_duplicate_is_error() {
        let mut store = DocumentStore::new();
        store.open_document("file:///a.cshtml", 1, "x").unwrap();
        assert!(matches!(
            store.open_document("file:///a.cshtml", 2, "y"),
            Err(StoreError::AlreadyOpen(_))
        ));
    }

    #[test]
    fn close_removes_document() {
        let mut store = DocumentStore::new();
        store.open_document("file:///a.cshtml", 1, "x").unwrap();
        store.close_document("file:///a.cshtml");
        assert!(store.snapshot("file:///a.cshtml").is_none());
    }

    #[test]
    fn close_unknown_is_idempotent() {
        let mut store = DocumentStore::new();
        store.close_document("file:///never-opened.cshtml"); // must not panic
    }

    // ── stale version rejection ───────────────────────────────────────────────

    #[test]
    fn stale_version_rejected() {
        let mut store = DocumentStore::new();
        store.open_document("file:///a.cshtml", 5, "text").unwrap();
        let err = store
            .apply_changes("file:///a.cshtml", 4, vec![])
            .unwrap_err();
        assert!(matches!(err, StoreError::StaleVersion { .. }));
    }

    #[test]
    fn same_version_rejected() {
        let mut store = DocumentStore::new();
        store.open_document("file:///a.cshtml", 5, "text").unwrap();
        let err = store
            .apply_changes("file:///a.cshtml", 5, vec![])
            .unwrap_err();
        assert!(matches!(err, StoreError::StaleVersion { .. }));
    }

    // ── incremental edits ─────────────────────────────────────────────────────

    #[test]
    fn single_insertion() {
        let mut store = DocumentStore::new();
        store.open_document("file:///a.cshtml", 1, "hello world").unwrap();
        // Insert " beautiful" between "hello" and " world"
        store
            .apply_changes(
                "file:///a.cshtml",
                2,
                vec![TextEdit {
                    range: range(0, 5, 0, 5),
                    new_text: " beautiful".into(),
                }],
            )
            .unwrap();
        assert_eq!(store.snapshot("file:///a.cshtml").unwrap().text(), "hello beautiful world");
    }

    #[test]
    fn single_deletion() {
        let mut store = DocumentStore::new();
        store.open_document("file:///a.cshtml", 1, "hello world").unwrap();
        // Delete " world"
        store
            .apply_changes(
                "file:///a.cshtml",
                2,
                vec![TextEdit {
                    range: range(0, 5, 0, 11),
                    new_text: String::new(),
                }],
            )
            .unwrap();
        assert_eq!(store.snapshot("file:///a.cshtml").unwrap().text(), "hello");
    }

    #[test]
    fn multi_line_edit() {
        let mut store = DocumentStore::new();
        store
            .open_document("file:///a.cshtml", 1, "line1\nline2\nline3")
            .unwrap();
        // Replace "line2" with "REPLACED"
        store
            .apply_changes(
                "file:///a.cshtml",
                2,
                vec![TextEdit {
                    range: range(1, 0, 1, 5),
                    new_text: "REPLACED".into(),
                }],
            )
            .unwrap();
        assert_eq!(
            store.snapshot("file:///a.cshtml").unwrap().text(),
            "line1\nREPLACED\nline3"
        );
    }

    // ── Unicode / CRLF ────────────────────────────────────────────────────────

    #[test]
    fn unicode_emoji_position() {
        // "😀" is U+1F600 — two UTF-16 code units, four UTF-8 bytes.
        let mut store = DocumentStore::new();
        store.open_document("file:///u.cshtml", 1, "😀abc").unwrap();
        // Replace "abc" (starts at UTF-16 char 2 because emoji = 2 UTF-16 units)
        store
            .apply_changes(
                "file:///u.cshtml",
                2,
                vec![TextEdit {
                    range: range(0, 2, 0, 5),
                    new_text: "XY".into(),
                }],
            )
            .unwrap();
        assert_eq!(store.snapshot("file:///u.cshtml").unwrap().text(), "😀XY");
    }

    #[test]
    fn crlf_line_ending() {
        let mut store = DocumentStore::new();
        store
            .open_document("file:///crlf.cshtml", 1, "line1\r\nline2")
            .unwrap();
        // On CRLF files, '\n' is at byte after '\r'. Position (1, 0) is start of "line2".
        // UTF-16 position (1, 0) → byte offset of 'l' in "line2".
        let snap = store.snapshot("file:///crlf.cshtml").unwrap();
        let offset = utf16_pos_to_byte_offset(snap.text(), TextPosition { line: 1, character: 0 });
        // "line1\r\n" = 7 bytes, so line2 starts at 7.
        assert_eq!(offset, Some(7));
    }

    #[test]
    fn no_panic_on_incomplete_document() {
        // A document ending mid-character sequence must not panic.
        let mut store = DocumentStore::new();
        store.open_document("file:///inc.cshtml", 1, "abc").unwrap();
        // Request beyond-end position: must return error, not panic.
        let err = store.apply_changes(
            "file:///inc.cshtml",
            2,
            vec![TextEdit {
                range: range(0, 100, 0, 200), // way out of range
                new_text: "x".into(),
            }],
        );
        assert!(err.is_err());
    }

    // ── replace_full ──────────────────────────────────────────────────────────

    #[test]
    fn replace_full_updates_text() {
        let mut store = DocumentStore::new();
        store.open_document("file:///a.cshtml", 1, "old").unwrap();
        store.replace_full("file:///a.cshtml", 2, "new content").unwrap();
        assert_eq!(store.snapshot("file:///a.cshtml").unwrap().text(), "new content");
    }

    // ── byte_to_position ─────────────────────────────────────────────────────

    #[test]
    fn byte_to_position_basic() {
        let mut store = DocumentStore::new();
        store
            .open_document("file:///a.cshtml", 1, "ab\ncd")
            .unwrap();
        let snap = store.snapshot("file:///a.cshtml").unwrap();
        // byte 0 → (0, 0); byte 3 → (1, 0)
        assert_eq!(snap.byte_to_position(0), Some(TextPosition { line: 0, character: 0 }));
        assert_eq!(snap.byte_to_position(3), Some(TextPosition { line: 1, character: 0 }));
    }
}
