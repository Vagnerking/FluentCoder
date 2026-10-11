//! Watcher do Git: avisa o frontend (`git://repo-changed`) quando um repo
//! local muda, para o SCM/status bar/grafo atualizarem sem polling cego.
//!
//! O que é observado, por repo:
//! - o git dir (`HEAD`, `index`, `MERGE_HEAD`…), sem recursão, e `refs/`
//!   recursivo + o common dir (`packed-refs`, `FETCH_HEAD`) — poucos watches;
//! - a árvore de trabalho, **respeitando o .gitignore**:
//!   - Linux (inotify = 1 watch por diretório): um watch NÃO recursivo por
//!     diretório não ignorado, com **teto global** ([`DEFAULT_DIR_CAP`]) somado
//!     entre todos os repos. Se um repo não cabe no orçamento, ele fica em modo
//!     `git-only` (só `.git`) e o frontend complementa com polling lento. A
//!     máquina de desenvolvimento já estourou `max_user_watches`; por isso o
//!     orçamento é conservador e diretórios ignorados (node_modules, target,
//!     dist…) nunca recebem watch.
//!   - macOS/Windows: um único watch recursivo na raiz (FSEvents /
//!     ReadDirectoryChangesW não custam por diretório); o filtro de ignore é
//!     aplicado nos eventos.
//!
//! Eventos são classificados em escopos (`head`, `index`, `refs`,
//! `operation`, `worktree`), agregados por repo e emitidos com debounce de
//! 300 ms (máx. 1,5 s de atraso numa rajada). `*.lock` e `objects/` são
//! ignorados. O status roda com `GIT_OPTIONAL_LOCKS=0`, então o próprio
//! refresh não reescreve o index e não realimenta o watcher.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Teto global de diretórios da árvore de trabalho observados (Linux).
pub(crate) const DEFAULT_DIR_CAP: usize = 2048;
const DEBOUNCE: Duration = Duration::from_millis(300);
const MAX_DELAY: Duration = Duration::from_millis(1500);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Scope {
    Head,
    Index,
    Refs,
    Operation,
    Worktree,
}

/// Payload de `git://repo-changed`.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct RepoChanged {
    pub root: String,
    pub scopes: Vec<Scope>,
}

/// Como um repo está sendo observado.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub(crate) struct WatchInfo {
    pub root: String,
    /// `full` (árvore + .git), `git-only` (só .git — orçamento esgotado) ou
    /// `failed` (não é repo / erro do backend de watch).
    pub mode: String,
    /// Diretórios da árvore com watch (Linux) — 1 no modo recursivo.
    pub dirs: usize,
    pub error: Option<String>,
}

struct RepoWatch {
    root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    ignore: ignore::gitignore::Gitignore,
    watcher: RecommendedWatcher,
    mode: String,
    /// Diretórios da árvore com watch próprio (Linux).
    dirs: HashSet<PathBuf>,
}

struct Inner {
    repos: HashMap<String, RepoWatch>,
    cap: usize,
}

impl Inner {
    fn used(&self) -> usize {
        self.repos.values().map(|r| r.dirs.len()).sum()
    }
}

type Sink = Arc<dyn Fn(RepoChanged) + Send + Sync>;

/// Núcleo independente do Tauri (testável): conjunto de repos observados +
/// thread de despacho com debounce.
pub(crate) struct GitWatchHub {
    inner: Arc<Mutex<Inner>>,
    tx: Sender<(String, Event)>,
}

impl GitWatchHub {
    pub(crate) fn new(sink: Sink, cap: usize) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            repos: HashMap::new(),
            cap,
        }));
        let (tx, rx) = channel::<(String, Event)>();
        let dispatch_inner = inner.clone();
        std::thread::Builder::new()
            .name("git-watch-dispatch".into())
            .spawn(move || {
                let mut pending: HashMap<String, (BTreeSet<Scope>, Instant, Instant)> = HashMap::new();
                loop {
                    match rx.recv_timeout(Duration::from_millis(50)) {
                        Ok((key, event)) => {
                            let scopes = handle_event(&dispatch_inner, &key, &event);
                            if !scopes.is_empty() {
                                let now = Instant::now();
                                let entry = pending
                                    .entry(key)
                                    .or_insert_with(|| (BTreeSet::new(), now, now));
                                entry.0.extend(scopes);
                                entry.2 = now;
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                    let now = Instant::now();
                    let due: Vec<String> = pending
                        .iter()
                        .filter(|(_, (_, first, last))| {
                            now.duration_since(*last) >= DEBOUNCE || now.duration_since(*first) >= MAX_DELAY
                        })
                        .map(|(k, _)| k.clone())
                        .collect();
                    for key in due {
                        if let Some((scopes, _, _)) = pending.remove(&key) {
                            sink(RepoChanged {
                                root: key,
                                scopes: scopes.into_iter().collect(),
                            });
                        }
                    }
                }
            })
            .expect("git watch dispatcher");
        GitWatchHub { inner, tx }
    }

    /// Substitui o conjunto de repos observados (toplevels locais). Repos que
    /// saíram têm o watcher descartado (libera os watches do inotify).
    #[cfg(test)]
    pub(crate) fn set_roots(&self, roots: &[String]) -> Vec<WatchInfo> {
        set_roots_impl(&self.inner, &self.tx, roots)
    }

    #[cfg(test)]
    pub(crate) fn watched_dirs(&self) -> usize {
        self.inner.lock().map(|i| i.used()).unwrap_or(0)
    }
}

fn set_roots_impl(
    inner: &Arc<Mutex<Inner>>,
    tx: &Sender<(String, Event)>,
    roots: &[String],
) -> Vec<WatchInfo> {
    {
        let wanted: Vec<String> = {
            let mut seen = HashSet::new();
            roots
                .iter()
                .map(|r| normalize_key(r))
                .filter(|r| !r.is_empty() && seen.insert(r.clone()))
                .collect()
        };
        let mut inner = inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.repos.retain(|key, _| wanted.contains(key));
        let mut infos = Vec::new();
        for key in wanted {
            if let Some(repo) = inner.repos.get(&key) {
                infos.push(info_of(&key, repo));
                continue;
            }
            let budget = inner.cap.saturating_sub(inner.used());
            match start_repo(&key, budget, tx.clone()) {
                Ok(repo) => {
                    infos.push(info_of(&key, &repo));
                    inner.repos.insert(key, repo);
                }
                Err(error) => infos.push(WatchInfo {
                    root: key,
                    mode: "failed".into(),
                    dirs: 0,
                    error: Some(error),
                }),
            }
        }
        infos
    }
}

fn info_of(key: &str, repo: &RepoWatch) -> WatchInfo {
    WatchInfo {
        root: key.to_string(),
        mode: repo.mode.clone(),
        dirs: if cfg!(target_os = "linux") { repo.dirs.len() } else { 1 },
        error: None,
    }
}

fn normalize_key(root: &str) -> String {
    let t = root.trim();
    let t = t.trim_end_matches(['/', '\\']);
    if t.is_empty() && root.starts_with('/') {
        "/".into()
    } else {
        t.to_string()
    }
}

fn start_repo(key: &str, budget: usize, tx: Sender<(String, Event)>) -> Result<RepoWatch, String> {
    let root = PathBuf::from(key);
    let out = super::run_git(
        key,
        &["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"],
    )?;
    let mut lines = out.lines();
    let git_dir = PathBuf::from(lines.next().unwrap_or("").trim());
    let common_dir = PathBuf::from(lines.next().unwrap_or("").trim());
    if git_dir.as_os_str().is_empty() {
        return Err("git dir não encontrado".into());
    }
    let common_dir = if common_dir.as_os_str().is_empty() { git_dir.clone() } else { common_dir };

    let mut builder = ignore::gitignore::GitignoreBuilder::new(&root);
    let _ = builder.add(root.join(".gitignore"));
    let _ = builder.add(common_dir.join("info").join("exclude"));
    let ignore = builder.build().unwrap_or_else(|_| ignore::gitignore::Gitignore::empty());

    let event_key = key.to_string();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            let _ = tx.send((event_key.clone(), event));
        }
    })
    .map_err(|e| format!("watcher: {e}"))?;

    // .git: HEAD/index/estado de operação (sem recursão) + refs (recursivo).
    watcher
        .watch(&git_dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch {}: {e}", git_dir.display()))?;
    if common_dir != git_dir {
        let _ = watcher.watch(&common_dir, RecursiveMode::NonRecursive);
    }
    let refs = common_dir.join("refs");
    if refs.is_dir() {
        let _ = watcher.watch(&refs, RecursiveMode::Recursive);
    }

    let mut dirs = HashSet::new();
    let mode;
    if cfg!(target_os = "linux") {
        let candidates = worktree_dirs(&root, budget + 1);
        if candidates.len() > budget {
            mode = "git-only".to_string();
        } else {
            for dir in candidates {
                if watcher.watch(&dir, RecursiveMode::NonRecursive).is_ok() {
                    dirs.insert(dir);
                }
            }
            mode = "full".to_string();
        }
    } else {
        mode = match watcher.watch(&root, RecursiveMode::Recursive) {
            Ok(()) => "full".to_string(),
            Err(_) => "git-only".to_string(),
        };
    }

    Ok(RepoWatch {
        root,
        git_dir,
        common_dir,
        ignore,
        watcher,
        mode,
        dirs,
    })
}

/// Diretórios não ignorados da árvore (inclui a raiz), no máximo `limit`.
/// Usa o walker do `ignore` (mesmas regras do git: .gitignore aninhados,
/// info/exclude, global excludes) e nunca entra em `.git`.
fn worktree_dirs(root: &Path, limit: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .parents(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build();
    for entry in walker.flatten() {
        if entry.file_type().is_some_and(|t| t.is_dir()) {
            out.push(entry.into_path());
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

/// Classifica um caminho de evento. Puro (testado).
pub(crate) fn classify(
    path: &Path,
    root: &Path,
    git_dir: &Path,
    common_dir: &Path,
    is_ignored: &dyn Fn(&Path) -> bool,
) -> Option<Scope> {
    for base in [git_dir, common_dir] {
        if let Ok(rel) = path.strip_prefix(base) {
            return classify_git_path(rel);
        }
    }
    let rel = path.strip_prefix(root).ok()?;
    if rel.components().any(|c| c.as_os_str() == ".git") {
        return None;
    }
    if is_ignored(path) {
        return None;
    }
    Some(Scope::Worktree)
}

fn classify_git_path(rel: &Path) -> Option<Scope> {
    let rel = rel.to_string_lossy().replace('\\', "/");
    if rel.is_empty() || rel.ends_with(".lock") {
        return None;
    }
    let first = rel.split('/').next().unwrap_or("");
    match first {
        "HEAD" => Some(Scope::Head),
        "index" => Some(Scope::Index),
        "refs" | "packed-refs" | "FETCH_HEAD" => Some(Scope::Refs),
        "MERGE_HEAD" | "REBASE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "ORIG_HEAD"
        | "rebase-merge" | "rebase-apply" | "sequencer" => Some(Scope::Operation),
        _ => None,
    }
}

/// Classifica o evento e, no Linux, adiciona watch a diretórios novos que
/// caibam no orçamento.
fn handle_event(inner: &Arc<Mutex<Inner>>, key: &str, event: &Event) -> Vec<Scope> {
    if matches!(event.kind, EventKind::Access(_)) {
        return Vec::new();
    }
    let mut guard = inner.lock().unwrap_or_else(|e| e.into_inner());
    let used = guard.used();
    let cap = guard.cap;
    let Some(repo) = guard.repos.get_mut(key) else {
        return Vec::new();
    };
    let mut scopes = Vec::new();
    for path in &event.paths {
        let ignore = &repo.ignore;
        let root = repo.root.clone();
        let is_ignored = |p: &Path| {
            p.strip_prefix(&root).is_ok()
                && ignore.matched_path_or_any_parents(p, p.is_dir()).is_ignore()
        };
        let Some(scope) = classify(path, &repo.root, &repo.git_dir, &repo.common_dir, &is_ignored) else {
            continue;
        };
        if scope == Scope::Worktree
            && cfg!(target_os = "linux")
            && repo.mode == "full"
            && matches!(event.kind, EventKind::Create(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)))
            && path.is_dir()
            && !repo.dirs.contains(path)
        {
            if used < cap && repo.watcher.watch(path, RecursiveMode::NonRecursive).is_ok() {
                repo.dirs.insert(path.clone());
            } else if used >= cap {
                // Estourou o orçamento ao crescer: degrada para git-only.
                repo.mode = "git-only".into();
            }
        }
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    scopes
}

/// Estado gerenciado pelo Tauri.
#[derive(Default)]
pub struct GitWatchState {
    hub: OnceLock<GitWatchHub>,
}

impl GitWatchState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Define os repos locais observados (toplevels). Devolve o modo de cada um;
/// para `git-only`/`failed` o frontend mantém polling.
#[tauri::command]
pub async fn git_watch_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, GitWatchState>,
    roots: Vec<String>,
) -> Result<Vec<WatchInfo>, String> {
    use tauri::Emitter;
    let hub = state.hub.get_or_init(|| {
        let app = app.clone();
        GitWatchHub::new(
            Arc::new(move |change: RepoChanged| {
                let _ = app.emit("git://repo-changed", change);
            }),
            DEFAULT_DIR_CAP,
        )
    });
    // O walk da árvore é bloqueante: fora da main thread e das workers async.
    let inner = hub.inner.clone();
    let tx = hub.tx.clone();
    super::runner::blocking(move || Ok(set_roots_impl(&inner, &tx, &roots))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::TempRepo;

    fn collector() -> (Sink, Arc<Mutex<Vec<RepoChanged>>>) {
        let got = Arc::new(Mutex::new(Vec::<RepoChanged>::new()));
        let got2 = got.clone();
        (Arc::new(move |c| got2.lock().unwrap().push(c)), got)
    }

    fn wait_for(got: &Arc<Mutex<Vec<RepoChanged>>>, scope: Scope) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(5) {
            if got.lock().unwrap().iter().any(|c| c.scopes.contains(&scope)) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    }

    #[test]
    fn classifies_git_internals_and_ignores_locks_objects() {
        let root = Path::new("/r");
        let git = Path::new("/r/.git");
        let none = |_: &Path| false;
        let c = |p: &str| classify(Path::new(p), root, git, git, &none);
        assert_eq!(c("/r/.git/HEAD"), Some(Scope::Head));
        assert_eq!(c("/r/.git/index"), Some(Scope::Index));
        assert_eq!(c("/r/.git/index.lock"), None);
        assert_eq!(c("/r/.git/refs/heads/feat/x"), Some(Scope::Refs));
        assert_eq!(c("/r/.git/refs/heads/feat/x.lock"), None);
        assert_eq!(c("/r/.git/packed-refs"), Some(Scope::Refs));
        assert_eq!(c("/r/.git/MERGE_HEAD"), Some(Scope::Operation));
        assert_eq!(c("/r/.git/objects/ab/cdef"), None);
        assert_eq!(c("/r/.git/logs/HEAD"), None);
        assert_eq!(c("/r/src/a.ts"), Some(Scope::Worktree));
        assert_eq!(c("/r/sub/.git/HEAD"), None);
        assert_eq!(c("/elsewhere/a"), None);
        let ignored = |p: &Path| p.to_string_lossy().contains("node_modules");
        assert_eq!(classify(Path::new("/r/node_modules/x.js"), root, git, git, &ignored), None);
        // Worktree: git dir fora da raiz.
        let wt_git = Path::new("/main/.git/worktrees/wt");
        let common = Path::new("/main/.git");
        assert_eq!(classify(Path::new("/main/.git/worktrees/wt/HEAD"), Path::new("/wt"), wt_git, common, &none), Some(Scope::Head));
        assert_eq!(classify(Path::new("/main/.git/refs/heads/x"), Path::new("/wt"), wt_git, common, &none), Some(Scope::Refs));
    }

    #[test]
    fn real_repo_events_are_scoped_debounced_and_respect_gitignore() {
        let repo = TempRepo::new();
        repo.write(".gitignore", "node_modules/\n*.log\n");
        repo.write("src/a.txt", "a\n");
        repo.write("node_modules/pkg/index.js", "x\n");
        repo.commit_all("base");
        let (sink, got) = collector();
        let hub = GitWatchHub::new(sink, DEFAULT_DIR_CAP);
        let infos = hub.set_roots(&[repo.root()]);
        assert_eq!(infos[0].mode, "full", "{infos:?}");
        if cfg!(target_os = "linux") {
            // raiz + src (node_modules é ignorado → sem watch).
            assert_eq!(infos[0].dirs, 2, "{infos:?}");
        }
        std::thread::sleep(Duration::from_millis(100));

        // Arquivo ignorado: nenhum evento.
        repo.write("debug.log", "x\n");
        repo.write("node_modules/pkg/index.js", "y\n");
        std::thread::sleep(Duration::from_millis(600));
        assert!(got.lock().unwrap().is_empty(), "{:?}", got.lock().unwrap());

        // Edição na árvore → worktree; várias edições viram 1 evento.
        for i in 0..5 {
            repo.write("src/a.txt", &format!("{i}\n"));
        }
        assert!(wait_for(&got, Scope::Worktree));
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(got.lock().unwrap().len(), 1, "debounce: {:?}", got.lock().unwrap());

        // Diretório novo ganha watch e seus arquivos geram evento.
        got.lock().unwrap().clear();
        std::fs::create_dir_all(repo.file("novo dir")).unwrap();
        std::thread::sleep(Duration::from_millis(400));
        got.lock().unwrap().clear();
        repo.write("novo dir/ç.txt", "x\n");
        assert!(wait_for(&got, Scope::Worktree), "arquivo em dir novo");

        got.lock().unwrap().clear();
        repo.git(&["add", "-A"]);
        assert!(wait_for(&got, Scope::Index));
        got.lock().unwrap().clear();
        repo.git(&["commit", "-q", "-m", "c"]);
        assert!(wait_for(&got, Scope::Refs) || wait_for(&got, Scope::Head));
        got.lock().unwrap().clear();
        repo.git(&["checkout", "-q", "-b", "feat/x"]);
        assert!(wait_for(&got, Scope::Head));

        // Status com GIT_OPTIONAL_LOCKS=0 não realimenta o watcher.
        std::thread::sleep(Duration::from_millis(500));
        got.lock().unwrap().clear();
        crate::git::git_status_blocking(repo.root()).unwrap();
        std::thread::sleep(Duration::from_millis(600));
        assert!(got.lock().unwrap().is_empty(), "status gerou evento: {:?}", got.lock().unwrap());

        // Sair do conjunto libera os watches.
        hub.set_roots(&[]);
        assert_eq!(hub.watched_dirs(), 0);
    }

    #[test]
    fn global_cap_degrades_big_repo_to_git_only() {
        let small = TempRepo::new();
        small.write("a/x.txt", "x\n");
        small.commit_all("a");
        let big = TempRepo::new();
        for i in 0..20 {
            big.write(&format!("d{i}/x.txt"), "x\n");
        }
        big.commit_all("big");
        let (sink, got) = collector();
        let hub = GitWatchHub::new(sink, 10);
        let infos = hub.set_roots(&[small.root(), big.root(), small.root()]);
        assert_eq!(infos.len(), 2, "duplicados ignorados");
        assert_eq!(infos[0].mode, "full");
        if cfg!(target_os = "linux") {
            assert_eq!(infos[1].mode, "git-only", "{infos:?}");
            assert!(hub.watched_dirs() <= 10);
            // Mesmo em git-only, operações no .git chegam.
            std::thread::sleep(Duration::from_millis(100));
            big.git(&["checkout", "-q", "-b", "outra"]);
            assert!(wait_for(&got, Scope::Head));
        }
    }

    /// Medição: quantos watches um repo real custaria (`FLUENT_BENCH_REPO`).
    #[test]
    #[ignore]
    fn bench_watch_cost() {
        let root = std::env::var("FLUENT_BENCH_REPO").expect("FLUENT_BENCH_REPO");
        let t = Instant::now();
        let dirs = worktree_dirs(Path::new(&root), usize::MAX);
        let all = walkdir_count(Path::new(&root));
        println!(
            "watch: {} dirs não ignorados de {} no total ({:?} para listar)",
            dirs.len(),
            all,
            t.elapsed()
        );
    }

    fn walkdir_count(root: &Path) -> usize {
        let mut n = 0;
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            n += 1;
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    if e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()) {
                        stack.push(e.path());
                    }
                }
            }
        }
        n
    }

    #[test]
    fn non_repo_is_reported_as_failed() {
        let plain = tempfile::tempdir().unwrap();
        let (sink, _) = collector();
        let hub = GitWatchHub::new(sink, 10);
        let infos = hub.set_roots(&[plain.path().to_string_lossy().to_string()]);
        assert_eq!(infos[0].mode, "failed");
    }
}
