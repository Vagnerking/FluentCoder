/// CSHTML language engine — domain model, incremental API, corpus and harness.
///
/// Intentionally free of Tauri, Monaco, LSP, Roslyn and `rzls`.
/// Public surface: `CshtmlEngine` + domain types in `types`.

pub mod document;
pub mod engine;
pub mod harness;
pub mod types;

pub use engine::CshtmlEngine;
