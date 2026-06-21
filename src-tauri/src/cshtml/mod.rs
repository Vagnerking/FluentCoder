/// CSHTML language engine — domain model and incremental API (issue #33).
///
/// This module is intentionally free of Tauri, Monaco, LSP, Roslyn and `rzls`.
/// The public surface is `CshtmlEngine` plus the domain types in `types`.

pub mod document;
pub mod engine;
pub mod types;

pub use engine::CshtmlEngine;
