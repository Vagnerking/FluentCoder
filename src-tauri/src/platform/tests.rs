use super::*;
use std::cell::RefCell;

/// Runner fake: registra o argv e responde conforme o roteiro.
struct FakeRunner {
    calls: RefCell<Vec<Invocation>>,
    /// Programas que "não existem" (spawn falha).
    missing: Vec<&'static str>,
    /// Programas que rodam mas saem com erro.
    failing: Vec<&'static str>,
}

impl FakeRunner {
    fn new(missing: &[&'static str], failing: &[&'static str]) -> Self {
        FakeRunner { calls: RefCell::new(vec![]), missing: missing.to_vec(), failing: failing.to_vec() }
    }
    fn programs(&self) -> Vec<String> {
        self.calls.borrow().iter().map(|c| c.program.clone()).collect()
    }
}

impl CommandRunner for FakeRunner {
    fn spawn(&self, inv: &Invocation) -> Result<(), String> {
        self.calls.borrow_mut().push(inv.clone());
        if self.missing.contains(&inv.program.as_str()) {
            Err(format!("{}: not found", inv.program))
        } else {
            Ok(())
        }
    }
    fn run(&self, inv: &Invocation, _t: Duration) -> Result<bool, String> {
        self.spawn(inv)?;
        Ok(!self.failing.contains(&inv.program.as_str()))
    }
}

fn no_which(_: &str) -> Option<PathBuf> {
    None
}

#[test]
fn current_matches_compile_target() {
    #[cfg(windows)]
    assert_eq!(current().os(), Os::Windows);
    #[cfg(target_os = "macos")]
    assert_eq!(current().os(), Os::Macos);
    #[cfg(all(unix, not(target_os = "macos")))]
    assert_eq!(current().os(), Os::Linux);
}

#[test]
fn windows_reveal_uses_explorer_select() {
    let plan = for_os(Os::Windows).reveal_plan(Path::new(r"\\?\C:\work\a b.txt"));
    assert_eq!(plan, vec![Invocation { program: "explorer".into(), args: vec!["/select,".into(), r"C:\work\a b.txt".into()], wait: false }]);
}

#[test]
fn macos_reveal_uses_open_r() {
    let plan = for_os(Os::Macos).reveal_plan(Path::new("/Users/u/a b.txt"));
    assert_eq!(plan, vec![Invocation::wait("open", &["-R", "/Users/u/a b.txt"])]);
}

#[test]
fn linux_reveal_tries_dbus_then_parent_folder() {
    let plan = for_os(Os::Linux).reveal_plan(Path::new("/home/u/pasta, com 'aspas'/ação.rs"));
    let progs: Vec<_> = plan.iter().map(|i| i.program.as_str()).collect();
    assert_eq!(progs, vec!["gdbus", "dbus-send", "xdg-open"]);
    let uri = "file:///home/u/pasta%2C%20com%20%27aspas%27/a%C3%A7%C3%A3o.rs";
    assert!(plan[0].args.contains(&format!("['{uri}']")), "{:?}", plan[0].args);
    assert!(plan[0].args.contains(&"org.freedesktop.FileManager1.ShowItems".to_string()));
    assert!(plan[1].args.contains(&format!("array:string:{uri}")));
    assert_eq!(plan[2].args, vec!["/home/u/pasta, com 'aspas'".to_string()]);
    assert!(plan[0].wait && plan[1].wait && !plan[2].wait);
}

#[test]
fn plan_falls_back_when_dbus_is_unavailable() {
    let plan = for_os(Os::Linux).reveal_plan(Path::new("/tmp/x.txt"));
    // gdbus não instalado, dbus-send sem FileManager1 registrado → xdg-open.
    let runner = FakeRunner::new(&["gdbus"], &["dbus-send"]);
    execute_plan(&plan, &runner).unwrap();
    assert_eq!(runner.programs(), vec!["gdbus", "dbus-send", "xdg-open"]);
    // Com o serviço D-Bus no ar, para no primeiro passo.
    let runner = FakeRunner::new(&[], &[]);
    execute_plan(&plan, &runner).unwrap();
    assert_eq!(runner.programs(), vec!["gdbus"]);
    // Nada disponível → erro (não pânico).
    let runner = FakeRunner::new(&["gdbus", "dbus-send", "xdg-open"], &[]);
    assert!(execute_plan(&plan, &runner).is_err());
}

#[test]
fn open_plans_use_system_handlers() {
    let url = "https://example.com/a?b=1";
    assert_eq!(for_os(Os::Windows).open_plan(url), vec![Invocation::spawn("rundll32", &["url.dll,FileProtocolHandler", url])]);
    assert_eq!(for_os(Os::Macos).open_plan(url), vec![Invocation::spawn("open", &[url])]);
    let linux = for_os(Os::Linux).open_plan(url);
    assert_eq!(linux[0], Invocation::spawn("xdg-open", &[url]));
    assert_eq!(linux[1], Invocation::spawn("gio", &["open", url]));
}

#[test]
fn external_url_allowlist() {
    assert!(is_safe_external_url("https://github.com/x/y/pull/1"));
    assert!(is_safe_external_url("HTTP://example.com"));
    assert!(is_safe_external_url("mailto:a@b.c"));
    assert!(!is_safe_external_url("file:///etc/passwd"));
    assert!(!is_safe_external_url("javascript:alert(1)"));
    assert!(!is_safe_external_url("https://x\n--evil"));
    assert!(open_external_url("vscode://x").is_err());
}

#[test]
fn default_shell_per_os() {
    let pwsh = |n: &str| (n == "pwsh.exe").then(|| PathBuf::from(r"C:\pwsh.exe"));
    let win = for_os(Os::Windows);
    assert_eq!(win.default_shell(&ShellEnv { shell_var: None, which: &pwsh }).program, "pwsh.exe");
    assert_eq!(win.default_shell(&ShellEnv { shell_var: None, which: &no_which }).program, "powershell.exe");
    let mac = for_os(Os::Macos).default_shell(&ShellEnv { shell_var: None, which: &no_which });
    assert_eq!((mac.program.as_str(), mac.args.as_slice()), ("/bin/zsh", &["-l".to_string()][..]));
    let bash = |n: &str| (n == "bash").then(|| PathBuf::from("/usr/bin/bash"));
    let lin = for_os(Os::Linux);
    assert_eq!(lin.default_shell(&ShellEnv { shell_var: Some("/usr/bin/fish".into()), which: &bash }).program, "/usr/bin/fish");
    assert_eq!(lin.default_shell(&ShellEnv { shell_var: None, which: &bash }).program, "/usr/bin/bash");
    assert_eq!(lin.default_shell(&ShellEnv { shell_var: None, which: &no_which }).program, "/bin/sh");
    assert_eq!(lin.default_shell(&ShellEnv { shell_var: None, which: &no_which }).kind, ShellKind::Posix);
}

#[test]
fn shell_line_and_exe_names() {
    assert_eq!(for_os(Os::Windows).shell_line("dir"), Invocation::spawn("cmd.exe", &["/C", "dir"]));
    assert_eq!(for_os(Os::Linux).shell_line("ls"), Invocation::spawn("/bin/sh", &["-c", "ls"]));
    assert_eq!(for_os(Os::Windows).exe_name("dotnet"), "dotnet.exe");
    assert_eq!(for_os(Os::Windows).exe_name("node.EXE"), "node.EXE");
    assert_eq!(for_os(Os::Macos).exe_name("dotnet"), "dotnet");
}

#[test]
fn data_and_home_dirs() {
    let env = |vars: &'static [(&'static str, &'static str)]| move |k: &str| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
    let w = env(&[("USERPROFILE", r"C:\Users\u"), ("APPDATA", r"C:\Users\u\AppData\Roaming")]);
    assert_eq!(for_os(Os::Windows).home_dir(&w), Some(PathBuf::from(r"C:\Users\u")));
    assert_eq!(for_os(Os::Windows).user_data_dir(&w), Some(PathBuf::from(r"C:\Users\u\AppData\Roaming")));
    let m = env(&[("HOME", "/Users/u")]);
    assert_eq!(for_os(Os::Macos).user_data_dir(&m), Some(PathBuf::from("/Users/u/Library/Application Support")));
    let l = env(&[("HOME", "/home/u")]);
    assert_eq!(for_os(Os::Linux).user_data_dir(&l), Some(PathBuf::from("/home/u/.local/share")));
    let x = env(&[("HOME", "/home/u"), ("XDG_DATA_HOME", "/data")]);
    assert_eq!(for_os(Os::Linux).user_data_dir(&x), Some(PathBuf::from("/data")));
    // XDG relativo é inválido pela spec → cai para o padrão.
    let rel = env(&[("HOME", "/home/u"), ("XDG_DATA_HOME", "rel")]);
    assert_eq!(for_os(Os::Linux).user_data_dir(&rel), Some(PathBuf::from("/home/u/.local/share")));
}

#[test]
fn linux_xdg_paths_use_posix_rules_on_every_host() {
    let linux = for_os(Os::Linux);
    for path in ["/", "/data", "/dados com espaços/ação", "//shared/data"] {
        let env = |name: &str| match name {
            "HOME" => Some("/home/u".into()),
            "XDG_DATA_HOME" => Some(path.to_string()),
            _ => None,
        };
        assert_eq!(
            linux.user_data_dir(&env),
            Some(PathBuf::from(path)),
            "{path}"
        );
    }
    for path in ["", "relative", "~/data", r"C:\data", "C:/data", r"\data"] {
        let env = |name: &str| match name {
            "HOME" => Some("/home/u".into()),
            "XDG_DATA_HOME" => Some(path.to_string()),
            _ => None,
        };
        assert_eq!(
            linux.user_data_dir(&env),
            Some(PathBuf::from("/home/u/.local/share")),
            "{path}"
        );
    }
}

#[test]
fn capabilities_per_os() {
    assert!(!for_os(Os::Macos).capabilities().custom_caption_buttons);
    assert!(for_os(Os::Windows).capabilities().snap_layouts);
    assert!(!for_os(Os::Linux).capabilities().snap_layouts);
    assert!(for_os(Os::Macos).capabilities().paths_case_insensitive);
    assert!(!for_os(Os::Linux).capabilities().paths_case_insensitive);
}

#[test]
fn dotnet_rids_cover_every_supported_target() {
    assert_eq!(dotnet_rid("linux", "aarch64"), Some("linux-arm64"));
    assert_eq!(dotnet_rid("linux", "x86_64"), Some("linux-x64"));
    assert_eq!(dotnet_rid("windows", "aarch64"), Some("win-arm64"));
    assert_eq!(dotnet_rid("macos", "aarch64"), Some("osx-arm64"));
    assert_eq!(dotnet_rid("windows", "x86"), None);
    assert_eq!(dotnet_rid("freebsd", "x86_64"), None);
}

#[test]
fn file_uri_to_path_unix_keeps_absolute_paths() {
    assert_eq!(file_uri_to_path("file:///home/u/a.code-workspace", Os::Linux), Some(PathBuf::from("/home/u/a.code-workspace")));
    assert_eq!(file_uri_to_path("file:///Users/u/My%20Work/%C3%A1.code-workspace", Os::Macos), Some(PathBuf::from("/Users/u/My Work/á.code-workspace")));
    assert_eq!(file_uri_to_path("file://localhost/tmp/x", Os::Linux), Some(PathBuf::from("/tmp/x")));
    assert_eq!(file_uri_to_path("file://server/share/x", Os::Linux), None);
    assert_eq!(file_uri_to_path("https://x/y", Os::Linux), None);
}

#[test]
fn file_uri_to_path_windows_drives_and_unc() {
    assert_eq!(file_uri_to_path("file:///C:/work/a.code-workspace", Os::Windows), Some(PathBuf::from(r"C:\work\a.code-workspace")));
    assert_eq!(file_uri_to_path("file:///c%3A/work/My%20App/x", Os::Windows), Some(PathBuf::from(r"C:\work\My App\x")));
    assert_eq!(file_uri_to_path("FILE://srv/share/x", Os::Windows), Some(PathBuf::from(r"\\srv\share\x")));
}

#[test]
fn file_uri_round_trip() {
    let p = Path::new("/home/u/a b/ç%.txt");
    let uri = path_to_file_uri(p, Os::Linux);
    assert_eq!(uri, "file:///home/u/a%20b/%C3%A7%25.txt");
    assert_eq!(file_uri_to_path(&uri, Os::Linux).as_deref(), Some(p));
    let w = path_to_file_uri(Path::new(r"C:\a b\x"), Os::Windows);
    assert_eq!(w, "file:///C:/a%20b/x");
    assert_eq!(path_to_file_uri(Path::new(r"\\srv\share\x"), Os::Windows), "file://srv/share/x");
}

#[test]
fn percent_decode_is_lenient() {
    assert_eq!(percent_decode("a%20b"), "a b");
    assert_eq!(percent_decode("100%"), "100%");
    assert_eq!(percent_decode("%zz"), "%zz");
    assert_eq!(percent_decode("%4"), "%4");
}

#[test]
fn init_script_exposes_platform_snapshot() {
    let s = init_script();
    assert!(s.starts_with("window.__FLUENT_PLATFORM__ = Object.freeze({"));
    assert!(s.contains(&format!("\"os\":\"{}\"", Os::host().as_str())));
    assert!(s.contains("\"customCaptionButtons\":"));
}

/// Linux real: o plano executa de verdade com binários que não abrem janela
/// (stub no PATH), provando que o fallback chega ao `xdg-open` da pasta-pai.
#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn linux_plan_executes_with_real_processes() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("fluent-platform-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("log");
    let stub = |name: &str, code: i32| {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\necho {name} \"$@\" >> '{}'\nexit {code}\n", log.display())).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.to_string_lossy().to_string()
    };
    let gdbus = stub("gdbus", 1);
    let xdg = stub("xdg-open", 0);
    let mut plan = for_os(Os::Linux).reveal_plan(Path::new("/tmp/pasta/a.txt"));
    plan[0].program = gdbus;
    plan[1].program = dir.join("nao-existe").to_string_lossy().to_string();
    plan[2].program = xdg;
    execute_plan(&plan, &SystemRunner).unwrap();
    // O spawn do xdg-open é assíncrono: espera o log.
    for _ in 0..100 {
        if std::fs::read_to_string(&log).map(|s| s.contains("xdg-open")).unwrap_or(false) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let text = std::fs::read_to_string(&log).unwrap();
    assert!(text.contains("gdbus call --session"), "{text}");
    assert!(text.contains("xdg-open /tmp/pasta"), "{text}");
    std::fs::remove_dir_all(&dir).unwrap();
}
