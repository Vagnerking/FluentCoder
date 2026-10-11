//! Processos: matar a árvore inteira de um filho (shell do terminal, servidor
//! de linguagem…) sem deixar netos órfãos nem zumbis.
//!
//! - Unix: o filho do PTY é líder de sessão/grupo (`setsid` do portable-pty),
//!   então `killpg(pid)` alcança todos os descendentes que não trocaram de
//!   grupo. SIGHUP primeiro (o que um terminal fechado manda), SIGKILL depois
//!   do prazo.
//! - Windows: `taskkill /T /F /PID <pid>` (a árvore inteira).

use std::time::Duration;

/// Plano de `taskkill` do Windows (puro, testável em qualquer SO).
pub fn windows_kill_tree_args(pid: u32) -> Vec<String> {
    vec!["/T".into(), "/F".into(), "/PID".into(), pid.to_string()]
}

/// Mata a árvore do processo `pid`. `grace`: quanto esperar o encerramento
/// gracioso (Unix) antes do SIGKILL. Nunca bloqueia além de `grace` + ~50 ms.
pub fn kill_process_tree(pid: u32, grace: Duration) {
    #[cfg(unix)]
    unix_kill_tree(pid, grace);
    #[cfg(windows)]
    {
        let _ = grace;
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(windows_kill_tree_args(pid))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        crate::child_process::hide_console_window(&mut cmd);
        if let Ok(mut child) = cmd.spawn() {
            let _ = child.wait();
        }
    }
}

#[cfg(unix)]
fn unix_kill_tree(pid: u32, grace: Duration) {
    let Ok(pid) = i32::try_from(pid) else { return };
    if pid <= 1 {
        return; // nunca sinalizar init / "todos os processos"
    }
    // SAFETY: chamadas de sinal sem ponteiros; pid > 1 validado acima.
    unsafe {
        // Só sinaliza o grupo se `pid` for mesmo o líder dele — senão
        // `killpg` acertaria o grupo de outra pessoa (ex.: o do próprio app).
        let pgid = libc::getpgid(pid);
        let group = pgid == pid;
        if group {
            libc::killpg(pid, libc::SIGHUP);
            libc::killpg(pid, libc::SIGTERM);
        } else {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    let deadline = std::time::Instant::now() + grace;
    while std::time::Instant::now() < deadline {
        // SAFETY: sinal 0 só testa existência.
        if unsafe { libc::kill(pid, 0) } != 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // SAFETY: idem; ESRCH (já saiu) é inofensivo.
    unsafe {
        if libc::getpgid(pid) == pid {
            libc::killpg(pid, libc::SIGKILL);
        } else {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taskkill_plan_kills_whole_tree_forcefully() {
        assert_eq!(windows_kill_tree_args(42), vec!["/T", "/F", "/PID", "42"]);
    }

    #[cfg(unix)]
    #[test]
    fn kills_process_group_including_grandchildren() {
        use std::os::unix::process::CommandExt;
        // sh vira líder de um grupo novo e cria um neto (sleep) no mesmo grupo.
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30 & echo $! ; wait"])
            .stdout(std::process::Stdio::piped())
            .process_group(0)
            .spawn()
            .expect("spawn sh");
        let mut out = child.stdout.take().unwrap();
        let mut buf = [0u8; 32];
        let n = std::io::Read::read(&mut out, &mut buf).unwrap();
        let grandchild: i32 = std::str::from_utf8(&buf[..n]).unwrap().trim().parse().unwrap();
        kill_process_tree(child.id(), Duration::from_millis(500));
        let status = child.wait().unwrap();
        assert!(!status.success());
        // O neto também morreu (pode ficar zumbi do sh só até o reaper do init).
        std::thread::sleep(Duration::from_millis(100));
        let alive = unsafe { libc::kill(grandchild, 0) } == 0;
        let zombie_or_gone = !alive
            || std::fs::read_to_string(format!("/proc/{grandchild}/stat"))
                .map(|s| s.split_whitespace().nth(2) == Some("Z"))
                .unwrap_or(true);
        assert!(zombie_or_gone, "neto {grandchild} sobreviveu ao kill da árvore");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_signal_init_or_everyone() {
        // Não pode panicar nem sinalizar o mundo.
        kill_process_tree(0, Duration::from_millis(1));
        kill_process_tree(1, Duration::from_millis(1));
    }
}
