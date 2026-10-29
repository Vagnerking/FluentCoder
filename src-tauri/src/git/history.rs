//! Histórico, file history, line history e blame **sem N+1**.
//!
//! Antes, cada commit do histórico (30), do file history (50) e cada hash do
//! blame custava um `git show --numstat` próprio — e no SSH esses execs eram
//! sequenciais (30 × RTT). Agora:
//! - histórico/file history/compare: **um** `git log -z --numstat` traz
//!   metadados + estatísticas de todos os commits;
//! - line history (`-L`) e blame: os hashes descobertos vão para **um**
//!   `git log --no-walk=unsorted -z --numstat` (via stdin no local, args no SSH);
//! - identidade (`user.name`/`user.email`) e URL do remoto saem de **um**
//!   `git config --get-regexp` em vez de 3–4 spawns.
//!
//! Os construtores de argumentos e os parsers são puros e compartilhados com os
//! espelhos `ssh_git_*` de `ssh.rs`.

use super::{
    commit_url_from_remote, format_relative_time, normalize_git_email, BlameHunk, GitCommit,
    GitGraphCommit,
};
use std::collections::HashMap;

/// Campos de cada commit: hash, short, autor, email, author-time (unix), pais, assunto.
/// Cada registro começa com `\x1e`; com `-z`, o cabeçalho termina em NUL e o
/// numstat vem em seguida (`add\tdel\tpath\0`, ou `add\tdel\t\0old\0new\0` em renames).
pub(crate) const LOG_FORMAT: &str = "--format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%s";

/// Uma chamada para identidade + remotos (origin/upstream).
pub(crate) const META_ARGS: [&str; 3] = [
    "config",
    "--get-regexp",
    r"^(user\.(name|email)|remote\.(origin|upstream)\.url)$",
];

/// Commit parseado de [`LOG_FORMAT`] + estatísticas do numstat.
pub(crate) struct LogRecord {
    pub commit: GitCommit,
    pub parents: Vec<String>,
}

/// `git log -<limit> -z --numstat <fmt> [extra…]`.
pub(crate) fn log_args(limit: u32, extra: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "log".into(),
        format!("-{limit}"),
        "-z".into(),
        "--numstat".into(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        LOG_FORMAT.into(),
    ];
    args.extend(extra.iter().map(|s| s.to_string()));
    args
}

/// `git log --no-walk=unsorted -z --numstat <fmt>` para uma lista de hashes já
/// conhecidos (blame / line history). Sem pathspec de propósito: com pathspec o
/// git descarta commits que não tocam o caminho atual (renames antigos) e perde
/// o pai — filtramos o numstat por caminho no parser.
pub(crate) fn stats_args(hashes_on_stdin: bool) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "log".into(),
        "--no-walk=unsorted".into(),
        "-z".into(),
        "--numstat".into(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        LOG_FORMAT.into(),
    ];
    if hashes_on_stdin {
        args.push("--stdin".into());
    }
    args
}

/// Um caminho do numstat corresponde ao filtro (relativo ao repo **ou** a uma
/// subpasta aberta como root do workspace)?
fn path_matches(numstat_path: &str, filter: &str) -> bool {
    let filter = filter.trim_start_matches("./").trim_start_matches('/');
    numstat_path == filter
        || numstat_path.ends_with(&format!("/{filter}"))
        || filter.ends_with(&format!("/{numstat_path}"))
}

/// Parser do `git log -z --numstat` com [`LOG_FORMAT`]. `path_filter` limita as
/// estatísticas a um arquivo (blame/line history); `None` soma tudo.
pub(crate) fn parse_log_z(raw: &str, path_filter: Option<&str>) -> Vec<LogRecord> {
    let mut out = Vec::new();
    for record in raw.split('\x1e') {
        if record.trim_matches(|c| c == '\0' || c == '\n').is_empty() {
            continue;
        }
        let (header, rest) = match record.find('\0') {
            Some(i) => (&record[..i], &record[i + 1..]),
            None => (record.trim_end_matches('\n'), ""),
        };
        let fields: Vec<&str> = header.split('\x1f').collect();
        if fields.len() < 7 {
            continue;
        }
        let email = normalize_git_email(fields[3]);
        let date = fields[4]
            .trim()
            .parse::<i64>()
            .map(format_relative_time)
            .unwrap_or_default();
        let parents: Vec<String> = fields[5].split_whitespace().map(str::to_string).collect();
        let mut commit = GitCommit {
            hash: fields[0].to_string(),
            short: fields[1].to_string(),
            author: fields[2].to_string(),
            avatar_url: super::avatar_url_for_email(&email),
            author_email: email,
            is_current_user: false,
            date,
            subject: fields[6..].join("\x1f"),
            additions: 0,
            deletions: 0,
            files_changed: 0,
            remote_url: String::new(),
        };

        let mut tokens = rest.split('\0');
        while let Some(token) = tokens.next() {
            let token = token.trim_start_matches('\n');
            if token.is_empty() {
                continue;
            }
            let mut parts = token.splitn(3, '\t');
            let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            // Rename/cópia: o caminho vem vazio e os dois seguintes são old/new.
            let (old_path, new_path) = if path.is_empty() {
                let old = tokens.next().unwrap_or("");
                let new = tokens.next().unwrap_or("");
                (Some(old), new)
            } else {
                (None, path)
            };
            if let Some(filter) = path_filter {
                if !path_matches(new_path, filter) && !old_path.is_some_and(|o| path_matches(o, filter)) {
                    continue;
                }
            }
            commit.files_changed += 1;
            // Binários vêm como "-\t-".
            commit.additions += add.parse::<u32>().unwrap_or(0);
            commit.deletions += del.parse::<u32>().unwrap_or(0);
        }
        out.push(LogRecord { commit, parents });
    }
    out
}

pub(crate) fn into_commits(records: Vec<LogRecord>) -> Vec<GitCommit> {
    records.into_iter().map(|r| r.commit).collect()
}

/// Identidade git + URL do remoto (origin, senão upstream) de um repo.
#[derive(Default, Debug, PartialEq)]
pub(crate) struct RepoMeta {
    pub identity: Option<(String, String)>,
    pub remote: String,
}

/// Parser de `git config --get-regexp` com [`META_ARGS`] (`<chave> <valor>`).
pub(crate) fn parse_repo_meta(raw: &str) -> RepoMeta {
    let mut name = String::new();
    let mut email = String::new();
    let mut origin = String::new();
    let mut upstream = String::new();
    for line in raw.lines() {
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        let value = value.trim().to_string();
        match key.to_ascii_lowercase().as_str() {
            "user.name" => name = value,
            "user.email" => email = normalize_git_email(&value),
            "remote.origin.url" => origin = value,
            "remote.upstream.url" => upstream = value,
            _ => {}
        }
    }
    RepoMeta {
        identity: if name.is_empty() && email.is_empty() {
            None
        } else {
            Some((name, email))
        },
        remote: if origin.is_empty() { upstream } else { origin },
    }
}

/// `git config --get-regexp` sai com 1 quando nada casa — não é erro.
pub(crate) fn repo_meta_local(root: &str) -> RepoMeta {
    parse_repo_meta(&super::run_git(root, &META_ARGS).unwrap_or_default())
}

fn is_me(identity: Option<&(String, String)>, author: &str, email: &str) -> bool {
    identity.is_some_and(|(name, me)| {
        (!me.is_empty() && email.eq_ignore_ascii_case(me))
            || (!name.is_empty() && author.eq_ignore_ascii_case(name))
    })
}

pub(crate) fn apply_meta_to_log(commits: &mut [GitCommit], meta: &RepoMeta) {
    for c in commits {
        c.is_current_user = is_me(meta.identity.as_ref(), &c.author, &c.author_email);
        c.remote_url = commit_url_from_remote(&meta.remote, &c.hash);
    }
}

pub(crate) fn apply_meta_to_graph(commits: &mut [GitGraphCommit], meta: &RepoMeta) {
    for c in commits {
        c.is_current_user = is_me(meta.identity.as_ref(), &c.author, &c.author_email);
        c.remote_url = commit_url_from_remote(&meta.remote, &c.hash);
    }
}

/// Aplica identidade, remoto e estatísticas por commit (do `stats_args`) ao blame.
pub(crate) fn apply_to_blame(hunks: &mut [BlameHunk], meta: &RepoMeta, stats: &[LogRecord]) {
    let by_hash: HashMap<&str, &LogRecord> =
        stats.iter().map(|r| (r.commit.hash.as_str(), r)).collect();
    for hunk in hunks {
        hunk.is_current_user = is_me(meta.identity.as_ref(), &hunk.author, &hunk.author_email);
        hunk.avatar_url = super::avatar_url_for_email(&hunk.author_email);
        if hunk.hash.is_empty() {
            continue;
        }
        hunk.remote_url = commit_url_from_remote(&meta.remote, &hunk.hash);
        if let Some(rec) = by_hash.get(hunk.hash.as_str()) {
            hunk.previous_hash = rec.parents.first().cloned().unwrap_or_default();
            hunk.additions = rec.commit.additions;
            hunk.deletions = rec.commit.deletions;
            hunk.files_changed = rec.commit.files_changed;
        }
    }
}

/// Hashes únicos (ordem estável) dos hunks já commitados.
pub(crate) fn blame_hashes(hunks: &[BlameHunk]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    hunks
        .iter()
        .filter(|h| !h.hash.is_empty() && seen.insert(h.hash.clone()))
        .map(|h| h.hash.clone())
        .collect()
}

/// Erros de "repo sem commits" (branch não nascida) viram lista vazia.
pub(crate) fn is_empty_history_error(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("does not have any commits yet")
        || e.contains("not a git repository")
        || e.contains("bad default revision 'head'")
        || e.contains("unknown revision or path not in the working tree")
            && e.contains("head")
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = "\x1e5999de0aaaa\x1f5999de0\x1fAna\x1fAna@X.com\x1f1700000000\x1fbf65747\x1fren\0\n1\t0\tcaf\u{e9} \u{e9}.txt\0\
0\t0\t\0old.txt\0new.txt\0\x1ebf65747bbbb\x1fbf65747\x1fBia\x1fbia@x.com\x1f1700000000\x1f79b0c11\x1ftwo\0\n\
1\t0\tcaf\u{e9} \u{e9}.txt\0-\t-\timg.png\0\x1e79b0c11cccc\x1f79b0c11\x1fAna\x1fana@x.com\x1f1700000000\x1f\x1finit\0";

    #[test]
    fn parses_log_z_with_numstat_renames_binary_and_root() {
        let recs = parse_log_z(RAW, None);
        assert_eq!(recs.len(), 3);
        let c0 = &recs[0].commit;
        assert_eq!(c0.hash, "5999de0aaaa");
        assert_eq!(c0.author_email, "ana@x.com");
        assert_eq!(c0.subject, "ren");
        assert_eq!((c0.files_changed, c0.additions, c0.deletions), (2, 1, 0));
        assert_eq!(recs[0].parents, vec!["bf65747"]);
        let c1 = &recs[1].commit;
        assert_eq!((c1.files_changed, c1.additions, c1.deletions), (2, 1, 0));
        assert!(recs[2].parents.is_empty());
        assert_eq!(recs[2].commit.files_changed, 0);
        assert!(c0.date.starts_with("há "), "{}", c0.date);
    }

    #[test]
    fn path_filter_matches_new_old_and_subfolder_roots() {
        let recs = parse_log_z(RAW, Some("old.txt"));
        assert_eq!(recs[0].commit.files_changed, 1);
        assert_eq!(recs[1].commit.files_changed, 0);
        let recs = parse_log_z(RAW, Some("café é.txt"));
        assert_eq!(recs[0].commit.additions, 1);
        assert!(path_matches("docs/a/b.md", "a/b.md"));
        assert!(!path_matches("docs/xa/b.md", "a/b.md"));
    }

    #[test]
    fn parses_repo_meta_in_one_call() {
        let meta = parse_repo_meta(
            "user.name Rafael Gomes\nuser.email <Rafa@X.com>\nremote.upstream.url u\nremote.origin.url git@github.com:a/b.git\n",
        );
        assert_eq!(meta.identity, Some(("Rafael Gomes".into(), "rafa@x.com".into())));
        assert_eq!(meta.remote, "git@github.com:a/b.git");
        assert_eq!(parse_repo_meta(""), RepoMeta::default());
        assert_eq!(parse_repo_meta("remote.upstream.url u\n").remote, "u");
    }
}
