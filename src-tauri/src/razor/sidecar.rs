//! Live Razor projection sidecar host (ADR 0002 "fast path").
//!
//! Owns a long-lived `dotnet RazorSidecar.dll` child process and talks to it over
//! newline-delimited JSON (one request per line, one response per line). The
//! sidecar hosts the real Razor source generator and re-emits a `.cshtml`'s
//! `.g.cs` from in-memory text in ~tens of ms — the fast path the keystroke
//! flow uses instead of the ~1s `dotnet build`.
//!
//! Built on first use into the app cache (so the host Roslyn version can match the
//! user's SDK band — see `tools/razor-sidecar`). Request/response is strictly
//! serialized (one in flight); `razor_emit_live` already runs off the UI thread
//! via `spawn_blocking`, so a synchronous std process model is enough and avoids
//! an async runtime dependency here.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Where the sidecar source lives, relative to the workspace root. Built from
/// here on first use into the app cache.
const SIDECAR_SUBDIR: &str = "tools/razor-sidecar";

/// Strip Windows' `\\?\` (and `\\?\UNC\`) extended-length prefix from a path
/// string. `fs::canonicalize`/`resource_dir` produce these, but `dotnet`/MSBuild
/// mishandle them (the `?` gets URL-mangled and glob imports fail). No-op on
/// non-Windows / unprefixed paths.
fn strip_extended_prefix(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = p.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    p.to_string()
}

/// A stable fingerprint of the sidecar SOURCE (so a changed `Program.cs`/`.csproj`
/// or a new app version invalidates a cached build). Hashes the app crate version
/// plus every source file's path + length + mtime under `src`. Cheap (no full file
/// reads) yet catches edits, additions, and removals.
fn build_fingerprint(src: &Path) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |bytes: &[u8]| {
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    // App version: an upgrade changes the protocol/binary expectations.
    mix(env!("CARGO_PKG_VERSION").as_bytes());

    // Every source file under the sidecar dir, sorted for a deterministic order.
    let mut entries: Vec<PathBuf> = Vec::new();
    collect_source_files(src, &mut entries);
    entries.sort();
    for path in entries {
        mix(path.to_string_lossy().as_bytes());
        if let Ok(meta) = std::fs::metadata(&path) {
            mix(&meta.len().to_le_bytes());
            if let Ok(mtime) = meta.modified() {
                if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                    mix(&dur.as_nanos().to_le_bytes());
                }
            }
        }
    }
    format!("{h:016x}")
}

/// Recursively collect source files under `dir`, skipping build outputs
/// (`bin`/`obj`) which are derived, not source.
fn collect_source_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if path.is_dir() {
            if name == "bin" || name == "obj" {
                continue;
            }
            collect_source_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// True if `path` holds exactly `want` (the recorded fingerprint matches).
fn fingerprint_matches(path: &Path, want: &str) -> bool {
    std::fs::read_to_string(path).map(|s| s == want).unwrap_or(false)
}

/// One file fed to the generator as an AdditionalText (path + base64 TargetPath).
/// `text` carries the in-memory content for files the generator must read besides
/// the edited target — the hierarchical `_ViewImports`/`_ViewStart` chain. When
/// `None`, the FileSpec only contributes TargetPath metadata (e.g. for the target
/// itself, whose text travels in the request's `cshtmlText`).
#[derive(Serialize, Clone)]
pub struct FileSpec {
    pub path: String,
    #[serde(rename = "targetPathB64")]
    pub target_path_b64: String,
    #[serde(rename = "text", skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Project-level inputs shared by `warm` and `emit` (refs + editorconfig globals).
#[derive(Clone)]
pub struct ProjectInputs {
    pub project_dir: String,
    pub references: Vec<String>,
    pub root_namespace: Option<String>,
    pub razor_lang_version: String,
    pub using_microsoft_net_sdk_web: bool,
    pub tfm: String,
    pub view_imports_path: Option<String>,
    pub view_imports_text: Option<String>,
    pub view_start_path: Option<String>,
    pub view_start_text: Option<String>,
    pub files: Vec<FileSpec>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request<'a> {
    id: u64,
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_dir: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cshtml_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cshtml_text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_imports_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_imports_text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_start_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_start_text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    references: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    root_namespace: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    razor_lang_version: Option<&'a str>,
    using_microsoft_net_sdk_web: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tfm: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<&'a [FileSpec]>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    #[allow(dead_code)]
    id: u64,
    ok: bool,
    generated_text: Option<String>,
    error: Option<String>,
}

/// A running sidecar process + its piped stdio. A dedicated reader thread pushes
/// each complete stdout line into `lines`, so `round_trip` can `recv_timeout` and
/// still kill the child if a request hangs (a blocking `read_line` while holding
/// the handle Mutex would otherwise starve `shutdown`).
struct Handle {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

/// The app-owned sidecar. Lazily spawned; serialized request/response.
pub struct Sidecar {
    handle: Mutex<Option<Handle>>,
    /// Path to the built `RazorSidecar.dll` (resolved once, on first use).
    dll: Mutex<Option<PathBuf>>,
    /// Serializes the build-on-first-use so two callers can't `dotnet build`
    /// into the same output dir concurrently (corrupting it).
    build_lock: Mutex<()>,
    next_id: AtomicU64,
}

impl Default for Sidecar {
    fn default() -> Self {
        Self {
            handle: Mutex::new(None),
            dll: Mutex::new(None),
            build_lock: Mutex::new(()),
            next_id: AtomicU64::new(1),
        }
    }
}

impl Sidecar {
    pub fn new() -> Self {
        Self::default()
    }

    /// Warm a project session (pays the cold generator cost up front).
    pub fn warm(&self, inputs: &ProjectInputs, cshtml_path: &str, cshtml_text: &str) -> Result<(), String> {
        let _ = self.request("warm", inputs, Some(cshtml_path), Some(cshtml_text))?;
        Ok(())
    }

    /// Emit the `.g.cs` for `cshtml_path` from `cshtml_text`. Returns the text.
    pub fn emit(&self, inputs: &ProjectInputs, cshtml_path: &str, cshtml_text: &str) -> Result<String, String> {
        let text = self.request("emit", inputs, Some(cshtml_path), Some(cshtml_text))?;
        text.ok_or_else(|| "sidecar emit returned no text".to_string())
    }

    /// Kill the child (app teardown / reset). Safe to call repeatedly.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.handle.lock() {
            if let Some(mut h) = guard.take() {
                let _ = h.child.kill();
                let _ = h.child.wait();
            }
        }
    }

    /// Resolve the built sidecar DLL, building it on first use into the app cache.
    /// `workspace_root` is the repo root containing `tools/razor-sidecar`; `cache`
    /// is the app data dir to build into. Cached after the first success.
    ///
    /// The cached DLL is INVALIDATED when the sidecar source or app version changes:
    /// without this, an app update could keep running a `.g.cs`-emitting binary built
    /// from an older `Program.cs`/`.csproj`/protocol. We write a fingerprint of the
    /// source inputs next to the DLL and rebuild whenever it doesn't match.
    pub fn ensure_built(&self, workspace_root: &Path, cache: &Path) -> Result<PathBuf, String> {
        let src = workspace_root.join(SIDECAR_SUBDIR);
        let csproj = src.join("RazorSidecar.csproj");
        if !csproj.exists() {
            return Err(format!("sidecar source not found: {}", csproj.display()));
        }
        let out = cache.join("razor-sidecar");
        let dll = out.join("RazorSidecar.dll");
        let fingerprint_path = out.join(".fingerprint");
        let want_fingerprint = build_fingerprint(&src);

        // In-process cache: trust it only if the on-disk fingerprint still matches
        // (a newer app/source build would have rewritten it).
        if let Ok(guard) = self.dll.lock() {
            if let Some(p) = guard.as_ref() {
                if p.exists() && fingerprint_matches(&fingerprint_path, &want_fingerprint) {
                    return Ok(p.clone());
                }
            }
        }
        // Serialize the build: two concurrent `dotnet build -o <out>` would corrupt
        // the shared output dir. The first builds; the rest see the cached dll.
        let _build_guard = self.build_lock.lock().map_err(|_| "build lock poisoned".to_string())?;
        let up_to_date = dll.exists() && fingerprint_matches(&fingerprint_path, &want_fingerprint);
        if !up_to_date {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            // Strip Windows' `\\?\` extended-length prefix: MSBuild mangles it
            // (`%3f`) and its `$(MSBuildProjectExtensionsPath)` glob import then
            // can't resolve, failing the build (error MSB4019).
            let csproj_arg = strip_extended_prefix(&csproj.to_string_lossy());
            let out_arg = strip_extended_prefix(&out.to_string_lossy());
            let cwd = strip_extended_prefix(&src.to_string_lossy());
            eprintln!("[razor:sidecar] building {csproj_arg} -> {out_arg}");
            let output = Command::new("dotnet")
                .args([
                    "build",
                    &csproj_arg,
                    "-c",
                    "Release",
                    "-o",
                    &out_arg,
                    "-nologo",
                ])
                .current_dir(&cwd)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| format!("sidecar build spawn failed: {e}"))?;
            if !output.status.success() || !dll.exists() {
                let so = String::from_utf8_lossy(&output.stdout);
                let se = String::from_utf8_lossy(&output.stderr);
                let tail: String = so
                    .lines()
                    .chain(se.lines())
                    .rev()
                    .take(8)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" | ");
                return Err(format!("sidecar build failed: {tail}"));
            }
            // Record the fingerprint of the source this DLL was built from, so a
            // later app/source change is detected and triggers a rebuild.
            let _ = std::fs::write(&fingerprint_path, &want_fingerprint);
        }
        if let Ok(mut guard) = self.dll.lock() {
            *guard = Some(dll.clone());
        }
        Ok(dll)
    }

    /// Configure the resolved DLL path (e.g. after `ensure_built` elsewhere) so a
    /// subsequent request can spawn without rebuilding.
    pub fn set_dll(&self, dll: PathBuf) {
        if let Ok(mut guard) = self.dll.lock() {
            *guard = Some(dll);
        }
    }

    // ── internals ────────────────────────────────────────────────────────────

    fn request(
        &self,
        kind: &str,
        inputs: &ProjectInputs,
        cshtml_path: Option<&str>,
        cshtml_text: Option<&str>,
    ) -> Result<Option<String>, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = Request {
            id,
            kind,
            project_dir: Some(&inputs.project_dir),
            cshtml_path,
            cshtml_text,
            view_imports_path: inputs.view_imports_path.as_deref(),
            view_imports_text: inputs.view_imports_text.as_deref(),
            view_start_path: inputs.view_start_path.as_deref(),
            view_start_text: inputs.view_start_text.as_deref(),
            references: Some(&inputs.references),
            root_namespace: inputs.root_namespace.as_deref(),
            razor_lang_version: Some(&inputs.razor_lang_version),
            using_microsoft_net_sdk_web: inputs.using_microsoft_net_sdk_web,
            tfm: Some(&inputs.tfm),
            files: Some(&inputs.files),
        };
        let line = serde_json::to_string(&req).map_err(|e| e.to_string())?;

        // One try; on a broken pipe (crashed sidecar) respawn once and retry.
        match self.round_trip(&line) {
            Ok(resp) => Self::interpret(resp),
            Err(_) => {
                self.shutdown(); // drop the dead handle
                let resp = self.round_trip(&line)?;
                Self::interpret(resp)
            }
        }
    }

    fn interpret(resp: Response) -> Result<Option<String>, String> {
        if resp.ok {
            Ok(resp.generated_text)
        } else {
            Err(resp.error.unwrap_or_else(|| "sidecar error".to_string()))
        }
    }

    /// Write one request line and read one response line, spawning the process if
    /// needed. Serialized by the `handle` mutex (one request in flight).
    fn round_trip(&self, line: &str) -> Result<Response, String> {
        let mut guard = self.handle.lock().map_err(|_| "sidecar lock poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(self.spawn()?);
        }
        let h = guard.as_mut().unwrap();
        if let Err(e) = h
            .stdin
            .write_all(line.as_bytes())
            .and_then(|_| h.stdin.write_all(b"\n"))
            .and_then(|_| h.stdin.flush())
        {
            return Err(format!("sidecar write failed: {e}"));
        }
        // Bounded wait on the reader thread. A stuck/crashed sidecar must not block
        // forever (and starve shutdown) — on timeout/disconnect we kill the child
        // and drop the handle so the next request respawns.
        match h.lines.recv_timeout(REQUEST_TIMEOUT) {
            Ok(resp_line) => serde_json::from_str::<Response>(resp_line.trim_end())
                .map_err(|e| format!("sidecar bad response: {e}")),
            Err(RecvTimeoutError::Timeout) => {
                let _ = h.child.kill();
                let _ = h.child.wait();
                *guard = None;
                Err("sidecar request timed out".to_string())
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = h.child.wait();
                *guard = None;
                Err("sidecar closed the pipe (crashed?)".to_string())
            }
        }
    }

    fn spawn(&self) -> Result<Handle, String> {
        let dll = self
            .dll
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .ok_or_else(|| "sidecar dll not built (call ensure_built first)".to_string())?;
        let mut cmd = Command::new("dotnet");
        cmd.arg("exec")
            .arg(strip_extended_prefix(&dll.to_string_lossy()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherit stderr so the sidecar's `[razor:sidecar]` logging surfaces in
            // the host process output (diagnostics for empty/failed emits).
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("sidecar spawn failed: {e}"))?;
        let stdin = child.stdin.take().ok_or("no sidecar stdin")?;
        let stdout = child.stdout.take().ok_or("no sidecar stdout")?;
        // Reader thread: push each complete response line into the channel. Ends on
        // EOF (sidecar exit), which surfaces to `round_trip` as Disconnected.
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break, // EOF or read error
                    Ok(_) => {
                        if tx.send(line).is_err() {
                            break; // receiver dropped (handle gone)
                        }
                    }
                }
            }
        });
        Ok(Handle { child, stdin, lines: rx })
    }
}

/// Per-request timeout: the sidecar answers in ms when healthy; a request beyond
/// this means a crash/hang — kill + respawn, and the caller falls back to build.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_serializes_camel_case_with_files() {
        let inputs = ProjectInputs {
            project_dir: "C:/p".into(),
            references: vec!["a.dll".into()],
            root_namespace: Some("App".into()),
            razor_lang_version: "8.0".into(),
            using_microsoft_net_sdk_web: true,
            tfm: "net8.0".into(),
            view_imports_path: None,
            view_imports_text: None,
            view_start_path: None,
            view_start_text: None,
            files: vec![FileSpec {
                path: "C:/p/Index.cshtml".into(),
                target_path_b64: "Vmlld3M=".into(),
                text: None,
            }],
        };
        let req = Request {
            id: 7,
            kind: "emit",
            project_dir: Some(&inputs.project_dir),
            cshtml_path: Some("C:/p/Index.cshtml"),
            cshtml_text: Some("<p>@Model.X</p>"),
            view_imports_path: None,
            view_imports_text: None,
            view_start_path: None,
            view_start_text: None,
            references: Some(&inputs.references),
            root_namespace: inputs.root_namespace.as_deref(),
            razor_lang_version: Some(&inputs.razor_lang_version),
            using_microsoft_net_sdk_web: true,
            tfm: Some(&inputs.tfm),
            files: Some(&inputs.files),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"kind\":\"emit\""));
        assert!(json.contains("\"cshtmlPath\":\"C:/p/Index.cshtml\""));
        assert!(json.contains("\"usingMicrosoftNetSdkWeb\":true"));
        assert!(json.contains("\"targetPathB64\":\"Vmlld3M=\""));
        // None fields are omitted.
        assert!(!json.contains("viewImportsPath"));
    }

    #[test]
    fn response_parses_ok_and_error() {
        let ok: Response = serde_json::from_str(r#"{"id":1,"ok":true,"generatedText":"x"}"#).unwrap();
        assert!(ok.ok && ok.generated_text.as_deref() == Some("x"));
        let err: Response = serde_json::from_str(r#"{"id":2,"ok":false,"error":"boom"}"#).unwrap();
        assert!(!err.ok && err.error.as_deref() == Some("boom"));
    }

    #[test]
    fn build_fingerprint_changes_when_source_changes() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let src = std::env::temp_dir().join(format!("fluent-razor-sidecar-fp-{id}"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("Program.cs"), "// v1").unwrap();
        std::fs::write(src.join("RazorSidecar.csproj"), "<Project/>").unwrap();

        let fp1 = build_fingerprint(&src);
        // Same content → same fingerprint (deterministic).
        assert_eq!(fp1, build_fingerprint(&src));

        // A content change (different length) → different fingerprint.
        std::fs::write(src.join("Program.cs"), "// v2 changed").unwrap();
        let fp2 = build_fingerprint(&src);
        assert_ne!(fp1, fp2, "fingerprint must change when source changes");

        // Build outputs are ignored: an obj/ artifact must not affect the fingerprint.
        std::fs::create_dir_all(src.join("obj")).unwrap();
        std::fs::write(src.join("obj").join("junk.cache"), "noise").unwrap();
        assert_eq!(fp2, build_fingerprint(&src), "obj/ must be ignored");

        // fingerprint_matches round-trips.
        let fpfile = src.join(".fingerprint");
        std::fs::write(&fpfile, &fp2).unwrap();
        assert!(fingerprint_matches(&fpfile, &fp2));
        assert!(!fingerprint_matches(&fpfile, "deadbeef"));

        let _ = std::fs::remove_dir_all(&src);
    }
}
