//! Diagnostic log for the Razor/C# projection pipeline.
//!
//! The broker's pipeline (`razor_prepare` → shadow restore → Roslyn → remap)
//! runs across the backend (this crate) and the frontend (`src/lsp`). Its
//! `eprintln!("[razor:*]")` lines go to the app's stderr, which is invisible
//! once the app is a packaged binary (and not captured by the E2E driver). When
//! the projection silently fails to surface a diagnostic, there is nothing to
//! inspect.
//!
//! This module mirrors every pipeline log line to a single file
//! (`<app_data_dir>/razor-diag.log`) with a millisecond timestamp, so a failing
//! C#/Razor run is diagnosable after the fact — both the Rust steps (timings,
//! restore/emit skips, failures) and the frontend LSP chain (via the
//! `razor_diag_log` command) land in one ordered trace.
//!
//! The file is bounded (`MAX_BYTES`): when it would grow past the cap it is
//! truncated first, so a long-running session can't fill the disk. Logging is a
//! no-op until [`init`] runs (in the app `setup`), so unit tests and the MCP
//! path pay nothing.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Resolved path of `razor-diag.log`. `None` until [`init`] runs.
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Truncate the log once it passes this size (bytes). Keeps the most recent
/// run's trace bounded without external rotation. 4 MiB holds a very long
/// session's worth of pipeline lines.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Points the diagnostic log at `<app_data_dir>/razor-diag.log`. Idempotent:
/// the first call wins (later calls are ignored). Call once from the app setup.
pub fn init(app_data_dir: PathBuf) {
    let _ = std::fs::create_dir_all(&app_data_dir);
    let _ = LOG_PATH.set(app_data_dir.join("razor-diag.log"));
}

/// Milliseconds since the Unix epoch (monotonic enough for ordering log lines;
/// avoids pulling a date crate just for a debug stamp).
fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Append one line to the diagnostic log (best-effort; never panics). Also
/// echoes to stderr so `tauri dev` / a terminal launch still shows it live.
/// A no-op (stderr only) until [`init`] has run.
pub fn log(line: &str) {
    eprintln!("{line}");
    let Some(path) = LOG_PATH.get() else { return };

    // Bound the file: if it's already at/over the cap, start fresh. Checked
    // before each append — cheap (a stat) next to the dotnet spawns this traces.
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() >= MAX_BYTES {
            let _ = std::fs::write(path, b"");
        }
    }

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {}", now_ms(), line);
    }
}

/// `rdiag!("[razor:timing] derive {:?}", elapsed)` — formats like `eprintln!`,
/// routes through [`log`] (file + stderr). Use for every pipeline step so a
/// failed C#/Razor run leaves an ordered trace.
#[macro_export]
macro_rules! rdiag {
    ($($arg:tt)*) => {
        $crate::razor::diag::log(&format!($($arg)*))
    };
}
