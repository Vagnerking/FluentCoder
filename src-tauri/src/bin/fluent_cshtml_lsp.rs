//! fluent-cshtml-lsp — servidor LSP 3.17 stdio para arquivos .cshtml
//!
//! Implementa o subconjunto LSP necessário para diagnósticos push:
//!   initialize / initialized / shutdown / exit
//!   textDocument/didOpen / didChange / didClose
//!   textDocument/publishDiagnostics (push)
//!
//! Testável sem Tauri: `echo '<request>' | fluent-cshtml-lsp`
//! Não anuncia capabilities privadas Microsoft (_ms_*, razor/*, _vs_*).
//! Erros internos são logados em stderr; o processo nunca entra em panic.

use fluent_coder_lib::cshtml::{
    engine::CshtmlEngine,
    lint::CshtmlLinter,
    types::{Diagnostic, TextPosition, TextRange},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, BufWriter, Write};

// ── JSON-RPC framing ──────────────────────────────────────────────────────────

fn read_message(reader: &mut impl BufRead) -> Option<Value> {
    // Parse Content-Length header
    let mut content_length: Option<usize> = None;
    loop {
        let mut header = String::new();
        match reader.read_line(&mut header) {
            Ok(0) | Err(_) => return None,
            _ => {}
        }
        let header = header.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break; // blank line separates headers from body
        }
        if let Some(rest) = header.strip_prefix("Content-Length: ") {
            content_length = rest.trim().parse().ok();
        }
    }
    let len = content_length?;
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).ok()?;
    serde_json::from_slice(&body).ok()
}

fn write_message(writer: &mut impl Write, value: &Value) {
    let body = value.to_string();
    let bytes = body.as_bytes();
    let _ = write!(
        writer,
        "Content-Length: {}\r\n\r\n{}",
        bytes.len(),
        body
    );
    let _ = writer.flush();
}

// ── LSP types (minimal) ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct InitializeParams {
    // rootUri/rootPath stored for future workspace-aware features.
    #[serde(rename = "rootUri")]
    _root_uri: Option<String>,
    #[serde(rename = "rootPath")]
    _root_path: Option<String>,
}

#[derive(Deserialize)]
struct TextDocumentItem {
    uri: String,
    #[serde(rename = "languageId")]
    _language_id: String,
    version: i32,
    text: String,
}

#[derive(Deserialize)]
struct DidOpenParams {
    #[serde(rename = "textDocument")]
    text_document: TextDocumentItem,
}

#[derive(Deserialize, Clone)]
struct ContentChange {
    text: String,
}

#[derive(Deserialize)]
struct DidChangeParams {
    #[serde(rename = "textDocument")]
    text_document: VersionedTextDocument,
    #[serde(rename = "contentChanges")]
    content_changes: Vec<ContentChange>,
}

#[derive(Deserialize)]
struct VersionedTextDocument {
    uri: String,
    version: i32,
}

#[derive(Deserialize)]
struct DidCloseParams {
    #[serde(rename = "textDocument")]
    text_document: UriDocument,
}

#[derive(Deserialize)]
struct UriDocument {
    uri: String,
}

// ── Serialization helpers ─────────────────────────────────────────────────────

fn diag_to_lsp(d: &Diagnostic) -> Value {
    json!({
        "range": range_to_lsp(d.range),
        "severity": match d.severity {
            fluent_coder_lib::cshtml::types::Severity::Error => 1,
            fluent_coder_lib::cshtml::types::Severity::Warning => 2,
            fluent_coder_lib::cshtml::types::Severity::Information => 3,
            fluent_coder_lib::cshtml::types::Severity::Hint => 4,
        },
        "code": d.code.as_ref().map(|c| c.0.as_str()),
        "source": &d.source,
        "message": &d.message,
    })
}

fn range_to_lsp(r: TextRange) -> Value {
    json!({
        "start": pos_to_lsp(r.start),
        "end":   pos_to_lsp(r.end),
    })
}

fn pos_to_lsp(p: TextPosition) -> Value {
    json!({ "line": p.line, "character": p.character })
}

// ── Server state ──────────────────────────────────────────────────────────────

struct Server {
    engine: CshtmlEngine,
    initialized: bool,
    shutdown_requested: bool,
}

impl Server {
    fn new() -> Self {
        let linter = CshtmlLinter::new();
        let engine = CshtmlEngine::new().with_diagnostic_provider(linter);
        Server {
            engine,
            initialized: false,
            shutdown_requested: false,
        }
    }

    fn push_diagnostics(&self, writer: &mut impl Write, uri: &str) {
        let diags = self.engine.diagnostics(uri);
        let lsp_diags: Vec<Value> = diags.iter().map(diag_to_lsp).collect();
        write_message(writer, &json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": uri,
                "diagnostics": lsp_diags,
            }
        }));
    }

    fn handle(&mut self, msg: &Value, writer: &mut impl Write) -> bool {
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let id = msg.get("id");
        let params = msg.get("params");

        match method {
            "initialize" => {
                if !self.initialized {
                    self.initialized = true;
                }
                let _init: Option<InitializeParams> = params
                    .and_then(|p| serde_json::from_value(p.clone()).ok());

                let response = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "capabilities": {
                            "textDocumentSync": {
                                "openClose": true,
                                // Full sync (1) for simplicity; incremental (2) can be added later.
                                "change": 1,
                            },
                            "diagnosticProvider": {
                                // Push-only; pull (textDocument/diagnostic) is not implemented.
                                "interFileDependencies": false,
                                "workspaceDiagnostics": false,
                            },
                        },
                        "serverInfo": {
                            "name": "fluent-cshtml-lsp",
                            "version": "0.1.0",
                        }
                    }
                });
                write_message(writer, &response);
            }
            "initialized" => {
                // Notification — no response needed.
            }
            "shutdown" => {
                self.shutdown_requested = true;
                write_message(writer, &json!({ "jsonrpc": "2.0", "id": id, "result": null }));
            }
            "exit" => {
                return false; // signal the main loop to stop
            }
            "textDocument/didOpen" => {
                if let Some(p) = params.and_then(|p| serde_json::from_value::<DidOpenParams>(p.clone()).ok()) {
                    let _ = self.engine.open_document(
                        &p.text_document.uri,
                        p.text_document.version,
                        &p.text_document.text,
                    );
                    self.push_diagnostics(writer, &p.text_document.uri);
                }
            }
            "textDocument/didChange" => {
                if let Some(p) = params.and_then(|p| serde_json::from_value::<DidChangeParams>(p.clone()).ok()) {
                    // Full sync: take the last change's full text.
                    if let Some(last) = p.content_changes.last() {
                        let _ = self.engine.replace_full(
                            &p.text_document.uri,
                            p.text_document.version,
                            &last.text,
                        );
                        self.push_diagnostics(writer, &p.text_document.uri);
                    }
                }
            }
            "textDocument/didClose" => {
                if let Some(p) = params.and_then(|p| serde_json::from_value::<DidCloseParams>(p.clone()).ok()) {
                    let _ = self.engine.close_document(&p.text_document.uri);
                    // Clear diagnostics on close.
                    write_message(writer, &json!({
                        "jsonrpc": "2.0",
                        "method": "textDocument/publishDiagnostics",
                        "params": { "uri": &p.text_document.uri, "diagnostics": [] }
                    }));
                }
            }
            "$/cancelRequest" => {
                // Best-effort — our requests are synchronous so nothing to cancel.
            }
            _ => {
                // Unknown method — if it has an id, respond with method-not-found.
                if let Some(id) = id {
                    write_message(writer, &json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": "Method not found" }
                    }));
                }
            }
        }
        true
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = io::BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    let mut server = Server::new();

    loop {
        match read_message(&mut reader) {
            None => {
                // EOF — client closed the connection.
                break;
            }
            Some(msg) => {
                if !server.handle(&msg, &mut writer) {
                    break;
                }
            }
        }
    }

    // Exit cleanly per LSP spec (0 after shutdown+exit, 1 if abrupt).
    let code = if server.shutdown_requested { 0 } else { 1 };
    std::process::exit(code);
}
