//! Razor (.cshtml/.razor) language support — Option B projection broker.
//!
//! Per [ADR 0002](../../../docs/adr/0002-cshtml-projection-roslyn.md): the Razor
//! compiler projects `.cshtml` to C# (`.g.cs`); the standard Roslyn C# LSP
//! analyzes that projection; this module maps positions/results back to the
//! `.cshtml`. Independent of the (retiring) homegrown `cshtml` engine.

// Foundational bricks: consumed by the projection broker in a later slice.
#[allow(dead_code)]
pub mod sourcemap;
#[allow(dead_code)]
pub mod shadow;
#[allow(dead_code)]
pub mod remap;
#[allow(dead_code)]
pub mod projection_gen;
#[allow(dead_code)]
pub mod derive;
#[allow(dead_code)]
pub mod broker;
#[allow(dead_code)]
pub mod exec;
#[allow(dead_code)]
pub mod runtime;
#[allow(dead_code)]
pub mod sidecar;
pub mod commands;
