//! Structured local task execution. Process arguments never enter a shell.
//! The internal runner is the PTY child; its children inherit that terminal.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) const RUNNER_FLAG: &str = "--internal-task-runner";
pub(crate) const RUNNER_ENV: &str = "FLUENT_INTERNAL_TASK_PLAN";
pub(crate) const RUNNER_EXE_ENV: &str = "FLUENT_INTERNAL_TASK_RUNNER_EXE";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum RunStep {
    Process {
        executable: String,
        args: Vec<String>,
        cwd: String,
    },
    Shell {
        source: String,
        args: Vec<String>,
        cwd: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskExecutionPlan {
    pub base_cwd: String,
    pub steps: Vec<RunStep>,
    pub stop_on_failure: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RunnerShell {
    pub program: String,
    pub args: Vec<String>,
    pub powershell: bool,
}

impl From<crate::platform::ShellSpec> for RunnerShell {
    fn from(shell: crate::platform::ShellSpec) -> Self {
        Self {
            program: shell.program,
            args: shell.args,
            powershell: shell.kind == crate::platform::ShellKind::Powershell,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct RunnerRequest {
    pub plan: TaskExecutionPlan,
    pub command_shell: RunnerShell,
    pub interactive_shell: RunnerShell,
}

pub(crate) fn runner_command(binary: &Path, request: &str) -> portable_pty::CommandBuilder {
    runner_command_with_launcher(binary, request, &crate::platform::default_shell().into())
}

fn runner_command_with_launcher(
    binary: &Path,
    request: &str,
    launcher: &RunnerShell,
) -> portable_pty::CommandBuilder {
    #[cfg(windows)]
    let mut command = {
        // The release app is a GUI executable. A fixed console launcher gives
        // it a parent attached to this ConPTY; no user command/argument enters
        // the launcher's script or native binder. All task data stays in JSON.
        let mut command = portable_pty::CommandBuilder::new(&launcher.program);
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference='Stop'; $p=[System.Diagnostics.ProcessStartInfo]::new(); $p.FileName=$env:FLUENT_INTERNAL_TASK_RUNNER_EXE; $p.UseShellExecute=$false; $p.Arguments='--internal-task-runner'; $c=[System.Diagnostics.Process]::Start($p); $c.WaitForExit(); exit $c.ExitCode"]);
        command
    };
    #[cfg(not(windows))]
    let mut command = portable_pty::CommandBuilder::new(binary);
    #[cfg(not(windows))]
    let _ = launcher;
    #[cfg(not(windows))]
    command.arg(RUNNER_FLAG);
    command.env(RUNNER_ENV, request);
    command.env(RUNNER_EXE_ENV, binary.as_os_str());
    command
}

#[cfg(windows)]
fn prepare_runner_console() -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::os::windows::io::{AsRawHandle, IntoRawHandle};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{
        AttachConsole, SetConsoleCtrlHandler, SetStdHandle, ATTACH_PARENT_PROCESS,
        STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    unsafe extern "system" fn keep_runner_alive(event: u32) -> windows::core::BOOL {
        // Native children receive Ctrl+C independently and end their current
        // task; the runner stays alive to restore the interactive prompt.
        (event == 0 || event == 1).into()
    }
    // SAFETY: this internal process runs before Tauri/threads. The parent is
    // the console launcher above. An already-attached console is also valid;
    // opening CONIN$/CONOUT$ below establishes usable handles in either case.
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
    let input = OpenOptions::new().read(true).write(true).open("CONIN$");
    let output = OpenOptions::new().read(true).write(true).open("CONOUT$");
    let error = OpenOptions::new().read(true).write(true).open("CONOUT$");
    let (input, output, error) = match (input, output, error) {
        (Ok(input), Ok(output), Ok(error)) => (input, output, error),
        _ => return Err("Não foi possível conectar a tarefa ao console do terminal.".into()),
    };
    // SAFETY: the files own valid console handles. Ownership is transferred to
    // the process-wide std handles below and retained until this process exits.
    unsafe {
        SetStdHandle(STD_INPUT_HANDLE, HANDLE(input.as_raw_handle())).map_err(|e| e.to_string())?;
        SetStdHandle(STD_OUTPUT_HANDLE, HANDLE(output.as_raw_handle()))
            .map_err(|e| e.to_string())?;
        SetStdHandle(STD_ERROR_HANDLE, HANDLE(error.as_raw_handle())).map_err(|e| e.to_string())?;
    }
    let _ = input.into_raw_handle();
    let _ = output.into_raw_handle();
    let _ = error.into_raw_handle();
    // SAFETY: callback has the required ABI, only returns a BOOL, and does not
    // access Rust shared state. Children do not inherit this handler function.
    unsafe {
        SetConsoleCtrlHandler(Some(keep_runner_alive), true).map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl TaskExecutionPlan {
    pub fn validate(&self) -> Result<(), String> {
        if !Path::new(&self.base_cwd).is_absolute() || self.base_cwd.contains('\0') {
            return Err("Diretório base da tarefa precisa ser um caminho absoluto válido.".into());
        }
        if self.steps.is_empty() {
            return Err("Plano de tarefa sem etapas.".into());
        }
        for step in &self.steps {
            let (program, args, cwd) = match step {
                RunStep::Process {
                    executable,
                    args,
                    cwd,
                } => (executable, args, cwd),
                RunStep::Shell { source, args, cwd } => (source, args, cwd),
            };
            if program.trim().is_empty()
                || program.contains('\0')
                || cwd.contains('\0')
                || args.iter().any(|s| s.contains('\0'))
            {
                return Err("Tarefa contém programa, diretório ou argumento inválido.".into());
            }
        }
        Ok(())
    }
}

fn step_cwd(base: &Path, cwd: &str) -> PathBuf {
    if cwd.is_empty() {
        base.to_owned()
    } else {
        base.join(cwd)
    }
}

/// Literal for the intentional shell surface, not for native process execution.
fn quote_shell(value: &str, powershell: bool) -> String {
    if powershell {
        let mut out = String::from("'");
        for c in value.chars() {
            out.push(c);
            if matches!(c, '\'' | '\u{2018}'..='\u{201b}') {
                out.push(c);
            }
        }
        out.push('\'');
        out
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn inherit_terminal_signals(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: pre_exec runs in the child before exec. Only async-signal-safe
        // signal calls occur here; no allocation, locks, or shared Rust state.
        unsafe {
            command.pre_exec(|| {
                libc::signal(libc::SIGINT, libc::SIG_DFL);
                libc::signal(libc::SIGQUIT, libc::SIG_DFL);
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    let _ = command;
}

pub(crate) fn step_command(
    step: &RunStep,
    base: &Path,
    shell: &RunnerShell,
) -> Result<Command, String> {
    let (mut command, cwd) = match step {
        RunStep::Process {
            executable,
            args,
            cwd,
        } => {
            let dir = step_cwd(base, cwd);
            // which_in keeps PATH/PATHEXT and relative executables rooted at the
            // step's own cwd, rather than the previous dependency's directory.
            let executable_path = which::which_in(executable, std::env::var_os("PATH"), &dir)
                .map_err(|e| format!("Executável da tarefa não encontrado ({executable}): {e}"))?;
            let mut cmd = Command::new(executable_path);
            cmd.args(args);
            (cmd, dir)
        }
        RunStep::Shell { source, args, cwd } => {
            let line = std::iter::once(source.clone())
                .chain(args.iter().map(|arg| quote_shell(arg, shell.powershell)))
                .collect::<Vec<_>>()
                .join(" ");
            let mut cmd = Command::new(&shell.program);
            if shell.powershell {
                cmd.args(["-Command", &line]);
            } else {
                cmd.args(["-lc", &line]);
            }
            (cmd, step_cwd(base, cwd))
        }
    };
    command.current_dir(cwd);
    command.env_remove(RUNNER_ENV);
    command.env_remove(RUNNER_EXE_ENV);
    inherit_terminal_signals(&mut command);
    Ok(command)
}

pub(crate) fn execute_plan(plan: &TaskExecutionPlan, shell: &RunnerShell) -> Result<i32, String> {
    plan.validate()?;
    let mut code = 0;
    for step in &plan.steps {
        code = step_command(step, Path::new(&plan.base_cwd), shell)?
            .status()
            .map_err(|e| format!("Não foi possível executar a tarefa: {e}"))?
            .code()
            .unwrap_or(1);
        if code != 0 && plan.stop_on_failure {
            break;
        }
    }
    Ok(code)
}

/// Called before Tauri, login-shell discovery, or background threads start.
pub(crate) fn run_if_requested() -> Option<i32> {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(RUNNER_FLAG)) {
        return None;
    }
    #[cfg(windows)]
    if prepare_runner_console().is_err() {
        return Some(1);
    }
    let request = std::env::var(RUNNER_ENV)
        .map_err(|_| "Plano interno de execução ausente.".to_string())
        .and_then(|json| {
            serde_json::from_str::<RunnerRequest>(&json)
                .map_err(|e| format!("Plano de execução inválido: {e}"))
        });
    // This is a dedicated process, before any thread. The plan is not inherited
    // by the target programs or by the interactive shell that follows them.
    std::env::remove_var(RUNNER_ENV);
    std::env::remove_var(RUNNER_EXE_ENV);
    #[cfg(unix)]
    // SAFETY: this dedicated runner has not started threads. It survives Ctrl+C
    // while its children restore default handlers immediately before exec.
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGQUIT, libc::SIG_IGN);
    }
    let request = match request {
        Ok(request) => request,
        Err(error) => {
            eprintln!("{error}");
            return Some(1);
        }
    };
    let code = match execute_plan(&request.plan, &request.command_shell) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    };
    println!("\r\nTarefa finalizada com código {code}.\r\n");
    // The output and the same PTY stay visible; no terminal stdin is consumed
    // to transport the plan, so interactive programs retain their input.
    let mut interactive = Command::new(&request.interactive_shell.program);
    interactive
        .args(&request.interactive_shell.args)
        .current_dir(&request.plan.base_cwd);
    inherit_terminal_signals(&mut interactive);
    let status = interactive.status();
    Some(match status {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("Não foi possível abrir o terminal: {error}");
            1
        }
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::OnceLock;

    // A real native executable, not a PowerShell function standing in for one.
    pub(crate) fn capture_binary() -> &'static Path {
        static CAPTURE: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
        &CAPTURE.get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("capture.rs");
            std::fs::write(&source, r#"
                fn main() {
                    let mut args = std::env::args().skip(1);
                    let output = args.next().unwrap();
                    let values: Vec<_> = args.collect();
                    std::fs::write(output, format!("{:?}\n{:?}", values, std::env::current_dir().unwrap().canonicalize().unwrap())).unwrap();
                    println!("CAPTURE-OUTPUT");
                    if values.iter().any(|arg| arg == "__fixture_stdin") {
                        let mut line = String::new();
                        std::io::stdin().read_line(&mut line).unwrap();
                        std::fs::write(format!("{}.stdin", std::env::args().nth(1).unwrap()), line).unwrap();
                    }
                    if values.iter().any(|arg| arg == "__fixture_tree") {
                        let child_output = format!("{}.child", std::env::args().nth(1).unwrap());
                        let _child = std::process::Command::new(std::env::current_exe().unwrap())
                            .args([child_output.as_str(), "__fixture_wait"]).spawn().unwrap();
                    }
                    if values.iter().any(|arg| arg == "__fixture_wait" || arg == "__fixture_tree") {
                        std::fs::write(format!("{}.pid", std::env::args().nth(1).unwrap()), std::process::id().to_string()).unwrap();
                        loop { std::thread::sleep(std::time::Duration::from_millis(50)); }
                    }
                    if values.iter().any(|arg| arg == "__fixture_exit_7") { std::process::exit(7); }
                }
            "#).unwrap();
            let binary = dir.path().join(format!("capture{}", std::env::consts::EXE_SUFFIX));
            let out = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
                .args([source.as_os_str(), std::ffi::OsStr::new("-o"), binary.as_os_str()]).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            (dir, binary)
        }).1
    }

    fn shell() -> RunnerShell {
        crate::platform::default_shell().into()
    }

    #[test]
    fn native_process_receives_literal_arguments_and_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("it's ’ [literal] $envPATH");
        std::fs::create_dir(&cwd).unwrap();
        let output = dir.path().join("captured.txt");
        let values: Vec<String> = [
            "",
            "--%",
            "a b",
            "%PATH%",
            "@args",
            "$env:PATH",
            "a$($script:ran = 1)b",
            "a\"b",
            "it's",
            "a’b",
            "C:\\trailing\\",
            "a;b&c|d",
            "line\nnext",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let mut args = vec![output.to_string_lossy().into_owned()];
        args.extend(values.clone());
        let step = RunStep::Process {
            executable: capture_binary().to_string_lossy().into_owned(),
            args,
            cwd: cwd.to_string_lossy().into_owned(),
        };
        let mut cmd = step_command(&step, dir.path(), &shell()).unwrap();
        assert!(cmd.status().unwrap().success());
        let actual = std::fs::read_to_string(output).unwrap();
        // Canonicalization accounts for /tmp symlinks on macOS and Windows.
        assert_eq!(
            actual,
            format!("{values:?}\n{:?}", cwd.canonicalize().unwrap())
        );
    }

    #[test]
    fn plan_stops_on_failure_and_resolves_each_cwd_from_base() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let first = dir.path().join("first.txt");
        let second = dir.path().join("second.txt");
        let step = |output: &Path, cwd: &str, fail: bool| RunStep::Process {
            executable: capture_binary().to_string_lossy().into_owned(),
            args: vec![
                output.to_string_lossy().into_owned(),
                if fail { "__fixture_exit_7" } else { "ok" }.into(),
            ],
            cwd: cwd.into(),
        };
        let mut plan = TaskExecutionPlan {
            base_cwd: dir.path().to_string_lossy().into_owned(),
            steps: vec![step(&first, "sub", true), step(&second, "", false)],
            stop_on_failure: true,
        };
        assert_eq!(execute_plan(&plan, &shell()).unwrap(), 7);
        assert!(first.exists());
        assert!(
            !second.exists(),
            "dependent command must not run after failure"
        );
        plan.stop_on_failure = false;
        assert_eq!(execute_plan(&plan, &shell()).unwrap(), 0);
        assert!(std::fs::read_to_string(second)
            .unwrap()
            .ends_with(&format!("{:?}", dir.path().canonicalize().unwrap())));
    }

    #[test]
    fn invalid_plan_is_rejected_before_any_step_starts() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("must-not-run.txt");
        let plan = TaskExecutionPlan {
            base_cwd: dir.path().to_string_lossy().into_owned(),
            steps: vec![
                RunStep::Process {
                    executable: capture_binary().to_string_lossy().into_owned(),
                    args: vec![output.to_string_lossy().into_owned()],
                    cwd: "".into(),
                },
                RunStep::Process {
                    executable: "node".into(),
                    args: vec!["bad\0arg".into()],
                    cwd: "".into(),
                },
            ],
            stop_on_failure: true,
        };
        assert!(execute_plan(&plan, &shell())
            .unwrap_err()
            .contains("inválido"));
        assert!(
            !output.exists(),
            "a later invalid step must prevent earlier side effects"
        );
        assert!(serde_json::from_str::<TaskExecutionPlan>(
            r#"{"baseCwd":"/tmp","steps":[],"stopOnFailure":true,"command":"ignored"}"#
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn batch_control_runs_and_metacharacters_do_not_start_a_second_command() {
        let dir = tempfile::tempdir().unwrap();
        let batch = dir.path().join("control.cmd");
        std::fs::write(&batch, "@echo off\r\n@echo batch-ok\r\n").unwrap();
        let mut step = RunStep::Process {
            executable: batch.to_string_lossy().into_owned(),
            args: vec!["normal".into(), "with space".into()],
            cwd: String::new(),
        };
        let output = step_command(&step, dir.path(), &shell())
            .unwrap()
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("batch-ok"));
        let marker = dir.path().join("injected.txt");
        if let RunStep::Process { args, .. } = &mut step {
            *args = vec![format!("ok&echo INJECTED>{}", marker.display())];
        }
        // Rust may reject an unrepresentable batch argument. It must never
        // fall back to passing the data to PowerShell or to a raw cmd string.
        let _ = step_command(&step, dir.path(), &shell()).unwrap().output();
        assert!(!marker.exists());
    }

    #[cfg(windows)]
    #[test]
    fn batch_forwarding_preserves_arguments_or_rejects_before_execution() {
        // The same forwarding shape used by ordinary command shims: a fixed
        // native executable followed by %*. A successful spawn must not
        // silently expand, split, or discard the supplied arguments.
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("batch-argv.txt");
        let marker = dir.path().join("injected.txt");
        let cases = vec![
            (vec!["normal".into(), "with space".into(), "".into()], false),
            (vec!["--%".into(), "a b".into(), "%PATH%".into()], true),
            (
                vec![
                    "@args".into(),
                    "$()".into(),
                    "a’b".into(),
                    "C:\\trailing\\".into(),
                ],
                true,
            ),
            (vec![format!("ok&echo INJECTED>{}", marker.display())], true),
            (
                vec![format!("x\"&echo INJECTED>{}&rem ", marker.display())],
                true,
            ),
            (vec!["a\"b".into(), "line\r\nnext".into()], true),
        ];
        for extension in ["cmd", "bat"] {
            let batch = dir.path().join(format!("forward.{extension}"));
            std::fs::write(
                &batch,
                "@echo off\r\n\"%FLUENT_TEST_CAPTURE_EXE%\" \"%FLUENT_TEST_CAPTURE_OUT%\" %*\r\n",
            )
            .unwrap();
            for (values, may_reject) in &cases {
                let _ = std::fs::remove_file(&output);
                let step = RunStep::Process {
                    executable: batch.to_string_lossy().into_owned(),
                    args: values.clone(),
                    cwd: String::new(),
                };
                let result = step_command(&step, dir.path(), &shell())
                    .unwrap()
                    .env("FLUENT_TEST_CAPTURE_EXE", capture_binary())
                    .env("FLUENT_TEST_CAPTURE_OUT", &output)
                    .output();
                match result {
                    Ok(result) => {
                        assert!(
                            result.status.success(),
                            "batch {extension}, args {values:?}: {result:?}"
                        );
                        assert_eq!(
                            std::fs::read_to_string(&output).unwrap(),
                            format!("{values:?}\n{:?}", dir.path().canonicalize().unwrap()),
                            "batch {extension} must preserve argv when it accepts an argument"
                        );
                    }
                    Err(error) => {
                        assert!(*may_reject, "legitimate batch control failed: {error}");
                        assert_eq!(
                            error.kind(),
                            std::io::ErrorKind::InvalidInput,
                            "only an explicit unrepresentable-argument rejection is accepted"
                        );
                        assert!(
                            !output.exists(),
                            "rejected arguments must not execute the shim"
                        );
                    }
                }
                assert!(!marker.exists(), "batch {extension} executed argument data");
            }
        }
    }

    #[test]
    #[ignore = "requires FLUENT_TEST_APP_BINARY pointing to the built app (release on Windows)"]
    fn runner_in_real_pty_preserves_argv_output_stdin_and_profile_transition() {
        use portable_pty::{native_pty_system, PtySize};
        use std::io::{Read, Write};
        use std::time::{Duration, Instant};
        let binary = std::env::var_os("FLUENT_TEST_APP_BINARY")
            .expect("build the application and set FLUENT_TEST_APP_BINARY");
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("process.txt");
        let profile_output = dir.path().join("profile.txt");
        let waiting_output = dir.path().join("waiting.txt");
        let values = vec![
            "--%".to_string(),
            "a b".into(),
            "%PATH%".into(),
            "$()".into(),
            "__fixture_stdin".into(),
        ];
        let mut args = vec![output.to_string_lossy().into_owned()];
        args.extend(values.clone());
        let plan = TaskExecutionPlan {
            base_cwd: dir.path().to_string_lossy().into_owned(),
            steps: vec![
                RunStep::Process {
                    executable: capture_binary().to_string_lossy().into_owned(),
                    args,
                    cwd: String::new(),
                },
                RunStep::Process {
                    executable: capture_binary().to_string_lossy().into_owned(),
                    args: vec![
                        waiting_output.to_string_lossy().into_owned(),
                        "__fixture_wait".into(),
                    ],
                    cwd: String::new(),
                },
            ],
            stop_on_failure: true,
        };
        let request = RunnerRequest {
            plan,
            command_shell: shell(),
            interactive_shell: RunnerShell {
                program: capture_binary().to_string_lossy().into_owned(),
                args: vec![
                    profile_output.to_string_lossy().into_owned(),
                    "__fixture_stdin".into(),
                ],
                powershell: false,
            },
        };
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let launcher = std::env::var("FLUENT_TEST_RUNNER_SHELL")
            .ok()
            .map(|program| RunnerShell {
                program,
                args: vec![],
                powershell: true,
            });
        let mut command = match launcher {
            Some(launcher) => runner_command_with_launcher(
                Path::new(&binary),
                &serde_json::to_string(&request).unwrap(),
                &launcher,
            ),
            None => runner_command(
                Path::new(&binary),
                &serde_json::to_string(&request).unwrap(),
            ),
        };
        command.cwd(dir.path());
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut writer = pair.master.take_writer().unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let read_thread = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = reader.read_to_string(&mut text);
            let _ = tx.send(text);
        });
        let wait_file = |path: &Path| {
            let deadline = Instant::now() + Duration::from_secs(15);
            while !path.exists() {
                if Instant::now() >= deadline {
                    if let Some(pid) = child.process_id() {
                        crate::platform::process::force_kill_tree(pid);
                    }
                    panic!("runner did not reach {}", path.display());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        wait_file(&output);
        writer.write_all(b"to-task\r").unwrap();
        writer.flush().unwrap();
        wait_file(&waiting_output);
        // The runner survives Ctrl+C, while its current process is interrupted.
        writer.write_all(&[3]).unwrap();
        writer.flush().unwrap();
        wait_file(&profile_output);
        writer.write_all(b"from-terminal\r").unwrap();
        writer.flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if Instant::now() >= deadline {
                if let Some(pid) = child.process_id() {
                    crate::platform::process::force_kill_tree(pid);
                }
                let _ = child.kill();
                let _ = child.wait();
                panic!("runner did not finish after stdin was delivered");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(writer);
        drop(pair.master);
        let text = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("PTY output reader must stop");
        read_thread.join().unwrap();
        assert!(
            text.contains("CAPTURE-OUTPUT"),
            "native stdout must reach the PTY: {text:?}"
        );
        let completion = text
            .lines()
            .find(|line| line.contains("Tarefa finalizada com código "))
            .expect("task completion stays visible");
        // Unix signals and Windows STATUS_CONTROL_C_EXIT have different codes.
        assert!(
            !completion.contains("código 0."),
            "interruption must not be reported as success"
        );
        assert_eq!(
            std::fs::read_to_string(output).unwrap(),
            format!("{values:?}\n{:?}", dir.path().canonicalize().unwrap())
        );
        assert!(
            profile_output.exists(),
            "the configured profile starts after the task"
        );
        assert_eq!(
            std::fs::read_to_string(format!(
                "{}.stdin",
                dir.path().join("process.txt").display()
            ))
            .unwrap()
            .trim(),
            "to-task"
        );
        assert_eq!(
            std::fs::read_to_string(format!("{}.stdin", profile_output.display()))
                .unwrap()
                .trim(),
            "from-terminal"
        );
    }
}
