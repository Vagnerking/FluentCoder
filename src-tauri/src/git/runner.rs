//! Runner do `git` CLI local.
//!
//! Contrato (ver `docs/context/git.md`):
//! - **Nunca roda na thread principal.** Todo `#[tauri::command]` do Git é
//!   `async` e delega o trabalho síncrono a [`blocking`], que usa o pool de
//!   threads bloqueantes do runtime do Tauri. No Tauri 2, comandos síncronos
//!   rodam na main thread — um `git fetch` de 10 s congelava a janela.
//! - **Timeout por tipo de chamada** ([`CallKind`]) e **cancelamento** por repo
//!   ([`cancel_running`]); o processo (e o grupo dele, no Unix) é morto.
//! - **Ambiente estável**: `GIT_TERMINAL_PROMPT=0` (nada de prompt invisível
//!   pendurando o processo), `GIT_OPTIONAL_LOCKS=0` em leituras (o polling de
//!   status não disputa o `index.lock` nem reescreve o index — o que também
//!   evita que o watcher veja o próprio status como mudança) e
//!   `-c core.quotepath=false -c color.ui=never`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Classe de chamada: define timeout e variáveis de ambiente.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CallKind {
    /// Leituras (status, log, show, diff, blame…): `GIT_OPTIONAL_LOCKS=0`.
    Read,
    /// Escritas locais (stage, commit, checkout…).
    Write,
    /// Rede (fetch/pull/push): timeout longo, cancelável pelo usuário.
    Network,
}

impl CallKind {
    pub(crate) fn timeout(self) -> Duration {
        match self {
            CallKind::Read => Duration::from_secs(60),
            CallKind::Write => Duration::from_secs(180),
            CallKind::Network => Duration::from_secs(600),
        }
    }
}

/// Infere a classe a partir do subcomando (primeiro argumento).
pub(crate) fn infer_kind(args: &[&str]) -> CallKind {
    let sub = args.first().copied().unwrap_or("");
    match sub {
        "fetch" | "pull" | "push" | "clone" | "ls-remote" => CallKind::Network,
        "status" | "log" | "show" | "diff" | "blame" | "rev-parse" | "rev-list" | "for-each-ref"
        | "symbolic-ref" | "ls-files" | "cat-file" | "merge-base" | "describe" | "name-rev"
        | "shortlog" | "check-ignore" => CallKind::Read,
        "config" if args.get(1).is_some_and(|a| a.starts_with("--get")) => CallKind::Read,
        "remote" if args.len() == 1 || matches!(args.get(1), Some(&"-v") | Some(&"get-url")) => {
            CallKind::Read
        }
        "stash" if matches!(args.get(1), Some(&"list") | Some(&"show")) => CallKind::Read,
        "worktree" if matches!(args.get(1), Some(&"list")) => CallKind::Read,
        _ => CallKind::Write,
    }
}

/// Opções de uma chamada.
pub(crate) struct RunOptions<'a> {
    pub kind: CallKind,
    pub timeout: Option<Duration>,
    pub stdin: Option<&'a [u8]>,
}

impl RunOptions<'_> {
    pub(crate) fn of(kind: CallKind) -> Self {
        RunOptions {
            kind,
            timeout: None,
            stdin: None,
        }
    }
}

struct Running {
    cwd: String,
    kind: CallKind,
    cancel: Arc<AtomicBool>,
}

fn registry() -> &'static Mutex<HashMap<u64, Running>> {
    static REG: OnceLock<Mutex<HashMap<u64, Running>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Cancela os processos git em andamento cujo `cwd` é `cwd` (ou todos, se
/// `None`). Com `network_only`, só fetch/pull/push. Retorna quantos sinalizou.
pub(crate) fn cancel_running(cwd: Option<&str>, network_only: bool) -> usize {
    let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    let mut n = 0;
    for running in reg.values() {
        if network_only && running.kind != CallKind::Network {
            continue;
        }
        if cwd.is_some_and(|c| !same_dir(c, &running.cwd)) {
            continue;
        }
        running.cancel.store(true, Ordering::SeqCst);
        n += 1;
    }
    n
}

fn same_dir(a: &str, b: &str) -> bool {
    let norm = |v: &str| v.replace('\\', "/").trim_end_matches('/').to_string();
    norm(a) == norm(b)
}

/// Quantos processos git estão rodando agora (diagnóstico/testes).
#[cfg(test)]
pub(crate) fn running_count(cwd: &str) -> usize {
    registry()
        .lock()
        .map(|r| r.values().filter(|run| same_dir(&run.cwd, cwd)).count())
        .unwrap_or(0)
}

/// Roda `git <args>` em `cwd` com a classe inferida do subcomando.
pub(crate) fn run(cwd: &str, args: &[&str]) -> Result<String, String> {
    run_with(cwd, args, RunOptions::of(infer_kind(args)))
}

/// Roda `git <args>` em `cwd`. Devolve stdout (lossy UTF-8) no sucesso, ou
/// stderr (stdout se stderr vier vazio) como erro.
pub(crate) fn run_with(cwd: &str, args: &[&str], opts: RunOptions<'_>) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .args(["-c", "core.quotepath=false", "-c", "color.ui=never"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if opts.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if opts.kind == CallKind::Read {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    // Grupo de processos próprio: no timeout/cancelamento matamos também os
    // filhos (ssh, hooks, credential helpers), senão eles seguram os pipes.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    crate::child_process::hide_console_window(&mut command);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Falha ao executar git: {e}"))?;

    if let (Some(input), Some(mut pipe)) = (opts.stdin, child.stdin.take()) {
        let input = input.to_vec();
        std::thread::spawn(move || {
            let _ = pipe.write_all(&input);
        });
    }
    let stdout_reader = spawn_reader(child.stdout.take());
    let stderr_reader = spawn_reader(child.stderr.take());

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut reg) = registry().lock() {
        reg.insert(
            id,
            Running {
                cwd: cwd.to_string(),
                kind: opts.kind,
                cancel: cancel.clone(),
            },
        );
    }
    let deadline = Instant::now() + opts.timeout.unwrap_or_else(|| opts.kind.timeout());

    // Espera com backoff curto (1 → 25 ms): custo desprezível para chamadas
    // de ~10 ms e permite timeout/cancelamento sem threads extras.
    let mut sleep = Duration::from_millis(1);
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(e) => break Err(format!("Falha ao aguardar git: {e}")),
        }
        if cancel.load(Ordering::SeqCst) {
            kill_tree(&mut child);
            break Err("Operação git cancelada.".to_string());
        }
        if Instant::now() >= deadline {
            kill_tree(&mut child);
            let what = args.first().copied().unwrap_or("git");
            break Err(format!(
                "Tempo esgotado: `git {what}` não respondeu em {} s e foi interrompido.",
                opts.timeout.unwrap_or_else(|| opts.kind.timeout()).as_secs()
            ));
        }
        std::thread::sleep(sleep);
        sleep = (sleep * 2).min(Duration::from_millis(25));
    };
    if let Ok(mut reg) = registry().lock() {
        reg.remove(&id);
    }

    let status = outcome?;
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    let stdout = String::from_utf8_lossy(&stdout).to_string();
    if status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&stderr).to_string();
        let msg = if stderr.trim().is_empty() { stdout } else { stderr };
        Err(msg.trim().to_string())
    }
}

fn spawn_reader<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    })
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // `process_group(0)` fez o pid do git virar o pgid do grupo.
        let pgid = child.id() as i32;
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Valor devolvido quando a tarefa bloqueante em si falha (panic/cancelamento
/// do runtime) — mantém a assinatura de cada comando.
pub(crate) trait JoinFallback {
    fn join_failed(message: String) -> Self;
}

impl<T> JoinFallback for Result<T, String> {
    fn join_failed(message: String) -> Self {
        Err(message)
    }
}

impl<T> JoinFallback for Option<T> {
    fn join_failed(_message: String) -> Self {
        None
    }
}

/// Executa `f` no pool de threads bloqueantes (fora da main thread e fora das
/// worker threads do runtime async).
pub(crate) async fn blocking<T, F>(f: F) -> T
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + JoinFallback + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(value) => value,
        Err(e) => T::join_failed(format!("Tarefa git falhou: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().to_str().unwrap();
        run(p, &["init", "-q"]).expect("git init");
        // Alias que dorme: simula um fetch lento sem rede.
        run(p, &["config", "alias.slow", "!sleep 2"]).expect("alias");
        dir
    }

    #[test]
    fn infers_call_kinds() {
        assert_eq!(infer_kind(&["fetch"]), CallKind::Network);
        assert_eq!(infer_kind(&["push", "-u", "origin", "x"]), CallKind::Network);
        assert_eq!(infer_kind(&["status", "--porcelain=v2"]), CallKind::Read);
        assert_eq!(infer_kind(&["config", "--get", "user.name"]), CallKind::Read);
        assert_eq!(infer_kind(&["config", "alias.x", "y"]), CallKind::Write);
        assert_eq!(infer_kind(&["remote", "get-url", "origin"]), CallKind::Read);
        assert_eq!(infer_kind(&["remote", "add", "o", "u"]), CallKind::Write);
        assert_eq!(infer_kind(&["stash", "list"]), CallKind::Read);
        assert_eq!(infer_kind(&["stash", "push"]), CallKind::Write);
        assert_eq!(infer_kind(&["commit", "-m", "x"]), CallKind::Write);
    }

    #[test]
    fn timeout_kills_hung_process() {
        let repo = temp_repo();
        let p = repo.path().to_str().unwrap();
        let start = Instant::now();
        let err = run_with(
            p,
            &["slow"],
            RunOptions {
                kind: CallKind::Network,
                timeout: Some(Duration::from_millis(300)),
                stdin: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("Tempo esgotado"), "{err}");
        // Matou o grupo (git + sleep): não esperou os 2 s do sleep.
        assert!(start.elapsed() < Duration::from_millis(1500), "{:?}", start.elapsed());
        assert_eq!(running_count(p), 0);
    }

    #[test]
    fn cancel_stops_network_call_for_repo() {
        let repo = temp_repo();
        let p = repo.path().to_str().unwrap().to_string();
        let p2 = p.clone();
        let handle = std::thread::spawn(move || {
            run_with(&p2, &["slow"], RunOptions::of(CallKind::Network))
        });
        // Espera o processo entrar no registro.
        let t0 = Instant::now();
        while running_count(&p) == 0 && t0.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(cancel_running(Some("/outro/repo"), true), 0);
        assert_eq!(cancel_running(Some(&p), true), 1);
        let err = handle.join().unwrap().unwrap_err();
        assert!(err.contains("cancelada"), "{err}");
        assert!(t0.elapsed() < Duration::from_millis(1500));
    }

    #[test]
    fn stdin_is_forwarded() {
        let repo = temp_repo();
        let p = repo.path().to_str().unwrap();
        let out = run_with(
            p,
            &["hash-object", "--stdin"],
            RunOptions {
                kind: CallKind::Read,
                timeout: None,
                stdin: Some(b"hello\n"),
            },
        )
        .unwrap();
        assert_eq!(out.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
    }

    /// Prova que o trabalho roda FORA da thread chamadora e que ela continua
    /// livre enquanto um git lento roda: num runtime de UMA thread (o pior
    /// caso — como a main thread), um ticker de 10 ms segue disparando
    /// durante um `git slow` de 2 s.
    #[test]
    fn blocking_runs_off_the_calling_thread_and_keeps_it_responsive() {
        let repo = temp_repo();
        let p = repo.path().to_str().unwrap().to_string();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async move {
            let caller = std::thread::current().id();
            let worker = blocking(|| Ok::<_, String>(std::thread::current().id()))
                .await
                .unwrap();
            assert_ne!(caller, worker, "o git deve rodar em outra thread");

            let ticks = Arc::new(AtomicU64::new(0));
            let ticks2 = ticks.clone();
            let ticker = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    ticks2.fetch_add(1, Ordering::Relaxed);
                }
            });
            let start = Instant::now();
            let res = blocking(move || {
                run_with(
                    &p,
                    &["slow"],
                    RunOptions {
                        kind: CallKind::Network,
                        timeout: Some(Duration::from_millis(1000)),
                        stdin: None,
                    },
                )
            })
            .await;
            ticker.abort();
            assert!(res.is_err());
            let elapsed = start.elapsed();
            let n = ticks.load(Ordering::Relaxed);
            // ~1 s de git; a thread chamadora deve ter feito dezenas de ticks.
            assert!(elapsed >= Duration::from_millis(900), "{elapsed:?}");
            assert!(n >= 50, "a thread chamadora ficou bloqueada: só {n} ticks em {elapsed:?}");
        });
    }
}
