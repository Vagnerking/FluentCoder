/// `CshtmlEngine` facade — the public API of the CSHTML language service (issue #33).
///
/// This layer owns the `DocumentStore` and dispatches to pluggable providers
/// (parser, workspace, metadata — injected via traits so a fake adapter can
/// exercise the engine in tests without starting the real app).
///
/// The engine itself has no knowledge of Tauri, Monaco, LSP, Roslyn or `rzls`.

use std::sync::{Arc, Mutex};

use crate::cshtml::{
    document::DocumentStore,
    types::{Diagnostic, DocumentVersion, Snapshot, Symbol, TextEdit},
};

// ── Provider traits ───────────────────────────────────────────────────────────

/// Pluggable diagnostic provider (syntax/lint). Implemented by the parser in
/// issue #35 and the linter in issue #37; the fake below is for tests.
pub trait DiagnosticProvider: Send + Sync {
    fn diagnostics(&self, snapshot: &Snapshot) -> Vec<Diagnostic>;
}

/// Pluggable symbol provider (outline / go-to-symbol).
pub trait SymbolProvider: Send + Sync {
    fn document_symbols(&self, snapshot: &Snapshot) -> Vec<Symbol>;
}

/// A no-op provider used as a default until real implementations land.
struct NullProvider;

impl DiagnosticProvider for NullProvider {
    fn diagnostics(&self, _snap: &Snapshot) -> Vec<Diagnostic> {
        vec![]
    }
}

impl SymbolProvider for NullProvider {
    fn document_symbols(&self, _snap: &Snapshot) -> Vec<Symbol> {
        vec![]
    }
}

// ── Engine ────────────────────────────────────────────────────────────────────

/// Error type for engine-level operations.
#[derive(Debug)]
pub struct EngineError(pub String);

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "cshtml engine error: {}", self.0)
    }
}

impl From<crate::cshtml::document::StoreError> for EngineError {
    fn from(e: crate::cshtml::document::StoreError) -> Self {
        Self(e.to_string())
    }
}

/// Central coordinator for the CSHTML language service.
///
/// Safe to clone — all state is behind `Arc<Mutex<…>>`.
#[derive(Clone)]
pub struct CshtmlEngine {
    store: Arc<Mutex<DocumentStore>>,
    diagnostics: Arc<dyn DiagnosticProvider>,
    symbols: Arc<dyn SymbolProvider>,
}

impl CshtmlEngine {
    /// Creates an engine with the null (no-op) providers.
    /// Swap providers with `with_diagnostic_provider` / `with_symbol_provider`.
    pub fn new() -> Self {
        Self {
            store: Arc::new(Mutex::new(DocumentStore::new())),
            diagnostics: Arc::new(NullProvider),
            symbols: Arc::new(NullProvider),
        }
    }

    /// Replaces the diagnostic provider (builder pattern).
    pub fn with_diagnostic_provider(mut self, p: impl DiagnosticProvider + 'static) -> Self {
        self.diagnostics = Arc::new(p);
        self
    }

    /// Replaces the symbol provider (builder pattern).
    pub fn with_symbol_provider(mut self, p: impl SymbolProvider + 'static) -> Self {
        self.symbols = Arc::new(p);
        self
    }

    // ── Document lifecycle ────────────────────────────────────────────────────

    /// Opens a new document. Idempotent if the same URI was already open
    /// with the same version (re-opening is silently ignored after a
    /// `close_document` in the same session).
    pub fn open_document(
        &self,
        uri: &str,
        version: i32,
        text: impl Into<String>,
    ) -> Result<(), EngineError> {
        let mut store = self.store.lock().unwrap();
        match store.open_document(uri, version, text) {
            Ok(()) => Ok(()),
            // Treat re-open of the same document gracefully: just update via replace_full.
            Err(crate::cshtml::document::StoreError::AlreadyOpen(_)) => {
                store.replace_full(uri, version, "").ok();
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Applies incremental text changes, bumping the version.
    pub fn apply_changes(
        &self,
        uri: &str,
        new_version: i32,
        changes: Vec<TextEdit>,
    ) -> Result<(), EngineError> {
        self.store
            .lock()
            .unwrap()
            .apply_changes(uri, new_version, changes)
            .map_err(EngineError::from)
    }

    /// Replaces the full document content.
    pub fn replace_full(
        &self,
        uri: &str,
        new_version: i32,
        text: impl Into<String>,
    ) -> Result<(), EngineError> {
        self.store
            .lock()
            .unwrap()
            .replace_full(uri, new_version, text)
            .map_err(EngineError::from)
    }

    /// Closes a document. Idempotent.
    pub fn close_document(&self, uri: &str) {
        self.store.lock().unwrap().close_document(uri);
    }

    // ── Analysis ─────────────────────────────────────────────────────────────

    /// Returns diagnostics for the document at `uri`.
    /// Returns an empty vec if the document is not open.
    pub fn diagnostics(&self, uri: &str) -> Vec<Diagnostic> {
        let snap = {
            let store = self.store.lock().unwrap();
            store.snapshot(uri).cloned()
        };
        match snap {
            Some(s) => self.diagnostics.diagnostics(&s),
            None => vec![],
        }
    }

    /// Returns the document symbols (outline) for `uri`.
    pub fn document_symbols(&self, uri: &str) -> Vec<Symbol> {
        let snap = {
            let store = self.store.lock().unwrap();
            store.snapshot(uri).cloned()
        };
        match snap {
            Some(s) => self.symbols.document_symbols(&s),
            None => vec![],
        }
    }

    /// Takes an immutable snapshot of a document for concurrent analysis.
    /// Returns `None` if the document is not open.
    pub fn snapshot(&self, uri: &str) -> Option<Snapshot> {
        self.store.lock().unwrap().snapshot(uri).cloned()
    }

    /// Current version of the document, or `None` if not open.
    pub fn version(&self, uri: &str) -> Option<DocumentVersion> {
        self.store
            .lock()
            .unwrap()
            .snapshot(uri)
            .map(|s| s.version)
    }

    /// Number of open documents.
    pub fn document_count(&self) -> usize {
        self.store.lock().unwrap().len()
    }
}

impl Default for CshtmlEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cshtml::types::{
        Diagnostic, Severity, DiagnosticCode, TextRange, TextPosition, Symbol, SymbolKind,
    };

    // ── Fake providers for testing ────────────────────────────────────────────

    struct FakeDiagProvider(Vec<Diagnostic>);

    impl DiagnosticProvider for FakeDiagProvider {
        fn diagnostics(&self, _snap: &Snapshot) -> Vec<Diagnostic> {
            self.0.clone()
        }
    }

    struct CountingSymbolProvider(usize);

    impl SymbolProvider for CountingSymbolProvider {
        fn document_symbols(&self, snap: &Snapshot) -> Vec<Symbol> {
            (0..self.0)
                .map(|i| Symbol {
                    name: format!("sym{i}"),
                    kind: SymbolKind::Function,
                    range: TextRange {
                        start: TextPosition { line: 0, character: 0 },
                        end: TextPosition { line: 0, character: 1 },
                    },
                    selection_range: TextRange {
                        start: TextPosition { line: 0, character: 0 },
                        end: TextPosition { line: 0, character: 1 },
                    },
                })
                .collect::<Vec<_>>()
                .into_iter()
                .filter(|_| !snap.text().is_empty())
                .collect()
        }
    }

    fn sample_diag() -> Diagnostic {
        Diagnostic {
            range: TextRange {
                start: TextPosition { line: 0, character: 0 },
                end: TextPosition { line: 0, character: 5 },
            },
            severity: Severity::Error,
            code: Some(DiagnosticCode("RZ0001".into())),
            source: "fluent-cshtml".into(),
            message: "test diagnostic".into(),
        }
    }

    // ── Engine lifecycle tests ────────────────────────────────────────────────

    #[test]
    fn open_and_close() {
        let engine = CshtmlEngine::new();
        engine.open_document("file:///a.cshtml", 1, "@model Foo").unwrap();
        assert_eq!(engine.document_count(), 1);
        engine.close_document("file:///a.cshtml");
        assert_eq!(engine.document_count(), 0);
    }

    #[test]
    fn diagnostics_from_fake_provider() {
        let engine = CshtmlEngine::new()
            .with_diagnostic_provider(FakeDiagProvider(vec![sample_diag()]));
        engine.open_document("file:///a.cshtml", 1, "@model Foo").unwrap();
        let diags = engine.diagnostics("file:///a.cshtml");
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].message, "test diagnostic");
    }

    #[test]
    fn diagnostics_on_closed_doc_is_empty() {
        let engine = CshtmlEngine::new()
            .with_diagnostic_provider(FakeDiagProvider(vec![sample_diag()]));
        // Not opened — must return empty, not panic.
        let diags = engine.diagnostics("file:///not-open.cshtml");
        assert!(diags.is_empty());
    }

    #[test]
    fn symbols_from_fake_provider() {
        let engine = CshtmlEngine::new().with_symbol_provider(CountingSymbolProvider(3));
        engine.open_document("file:///a.cshtml", 1, "content").unwrap();
        let syms = engine.document_symbols("file:///a.cshtml");
        assert_eq!(syms.len(), 3);
    }

    #[test]
    fn snapshot_is_consistent() {
        let engine = CshtmlEngine::new();
        engine.open_document("file:///a.cshtml", 1, "hello").unwrap();
        let snap = engine.snapshot("file:///a.cshtml").unwrap();
        assert_eq!(snap.text(), "hello");
        assert_eq!(snap.version, DocumentVersion(1));
    }

    #[test]
    fn engine_is_clone_and_shared() {
        let engine = CshtmlEngine::new();
        engine.open_document("file:///a.cshtml", 1, "x").unwrap();
        let engine2 = engine.clone();
        // Both handles see the same store.
        assert_eq!(engine2.document_count(), 1);
        engine2.close_document("file:///a.cshtml");
        assert_eq!(engine.document_count(), 0);
    }

    #[test]
    fn no_panic_on_empty_document() {
        let engine = CshtmlEngine::new();
        engine.open_document("file:///empty.cshtml", 1, "").unwrap();
        let diags = engine.diagnostics("file:///empty.cshtml");
        assert!(diags.is_empty()); // NullProvider always returns empty
    }
}
