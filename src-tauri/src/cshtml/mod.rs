/// CSHTML language engine — domain model, incremental API, parser, corpus and harness.
///
/// Intentionally free of Tauri, Monaco, LSP, Roslyn and `rzls`.
/// Public surface: `CshtmlEngine` + domain types in `types`.

pub mod ast;
pub mod binding;
pub mod document;
pub mod engine;
pub mod hardening;
pub mod harness;
pub mod intellisense;
pub mod lint;
pub mod parser;
pub mod projection;
pub mod types;
pub mod metadata;
pub mod semantics;
pub mod views;
pub mod workspace;

pub use engine::CshtmlEngine;
pub use parser::parse;
pub use projection::{project, ProjectionMap};
