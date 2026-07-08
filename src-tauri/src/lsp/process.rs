//! Spawning and owning a long-running LSP server child process over stdio.
//!
//! Mirrors the long-lived-process pattern of `terminal.rs` (a managed handle +
//! a reader task), but uses `tokio::process` + async tasks instead of a PTY,
//! since LSP servers communicate over plain stdin/stdout, not a terminal.

use std::path::Path;
use std::process::Stdio;
use tokio::io::BufReader;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

/// A spawned LSP server process with captured stdio handles.
pub struct LspProcess {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: BufReader<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

impl LspProcess {
    /// Spawns `program` with `args` in `cwd`, with the given extra environment.
    ///
    /// stdin/stdout/stderr are all piped so the bridge can proxy them and so the
    /// server's stderr can be forwarded to the Tauri log.
    pub fn spawn(
        program: &str,
        args: &[String],
        cwd: &Path,
        env: &[(String, String)],
    ) -> std::io::Result<LspProcess> {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        for (k, v) in env {
            cmd.env(k, v);
        }

        crate::child_process::hide_tokio_console_window(&mut cmd);

        let mut child = cmd.spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("failed to capture LSP stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("failed to capture LSP stdout"))?;
        let stderr = child.stderr.take();

        Ok(LspProcess {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            stderr,
        })
    }

    /// Spawns a task that forwards the child's stderr to the Tauri log, prefixed
    /// with the server id so multiple servers stay distinguishable.
    pub fn forward_stderr(&mut self, server_id: String) {
        if let Some(stderr) = self.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};
                let mut lines = TokioBufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[lsp:{server_id}] {line}");
                }
            });
        }
    }

    /// Kills the process and waits for it to exit (graceful teardown).
    pub async fn kill(mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}
