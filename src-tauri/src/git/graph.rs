//! Grafo de commits paginado, detalhes de commit e linhagem de branches.
//!
//! - `git_graph_page`: página de N commits (padrão 200) com pais, autor,
//!   datas (`%at`/`%ct`) e co-autores (trailer `Co-authored-by`). A 1ª página
//!   (sem cursor) traz também o cabeçalho: refs (`for-each-ref`, com
//!   upstream e ahead/behind de **todas** as branches), HEAD, branch base
//!   detectada, remotos (para links do provedor), identidade, commits
//!   recebidos/enviados (`rev-list --left-right HEAD...@{u}`) e, com filtro de
//!   autor/texto, os hashes que casam (o grafo **esmaece**, não remove linhas).
//! - O cursor carrega `skip` + os **hashes** das revs resolvidas na 1ª página:
//!   as páginas seguintes não mudam se uma ref andar no meio da rolagem.
//! - Seleção de refs: `auto` (HEAD + upstream + branch base, como o
//!   "Automático" do VS Code), `current` (HEAD + upstream), `all`
//!   (branches, remotos, tags e HEAD — nunca `refs/stash`) e `selected`.
//! - `git_commit_details`: mensagem completa, committer, arquivos e
//!   estatísticas num único `git show -z --raw --numstat`; cache por hash
//!   (commits são imutáveis).
//! - `git_branch_lineage`: ponto de divergência (merge-base) com a base,
//!   ahead/behind, caminho de first-parent até a base e, se já integrada, o
//!   merge que a levou para a base (com o número do PR quando o assunto diz).
//!
//! Construtores de argumentos e parsers são puros e compartilhados com os
//! espelhos `ssh_git_*` (SSH: página 1 = 2 execs, demais = 1).

use super::history;
use super::runner;
use super::GitCommitFile;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Campos por commit do grafo. Registro começa em `\x1e`; co-autores
/// separados por `\x1d`.
pub(crate) const GRAPH_FORMAT: &str =
    "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)";

/// Detalhes: `%B` por último, fechado por `\x1e`; depois vêm `--raw` e
/// `--numstat` em `-z`.
pub(crate) const DETAILS_FORMAT: &str = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)%x1f%B%x1e";

/// `for-each-ref`: nome, objeto, objeto descascado (tags anotadas), tipos,
/// upstream, `ahead N, behind M`, `*` no HEAD e alvo simbólico.
pub(crate) const REFS_FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)%00%(symref)";

/// Identidade + URLs de todos os remotos num `config --get-regexp`.
pub(crate) const GRAPH_META_ARGS: [&str; 3] = [
    "config",
    "--get-regexp",
    r"^(user\.(name|email)|remote\..*\.url)$",
];

pub(crate) const DEFAULT_PAGE_SIZE: u32 = 200;
const MAX_PAGE_SIZE: u32 = 2000;
/// Teto dos conjuntos recebidos/enviados e dos hashes que casam a busca.
const TRACK_CAP: usize = 2000;
const MATCH_CAP: u32 = 5000;
const LINEAGE_PATH_CAP: u32 = 5000;

// ---------------------------------------------------------------- tipos

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RefMode {
    #[default]
    Auto,
    All,
    Current,
    Selected,
}

/// Filtros do grafo. `author`/`search` não removem linhas (viram `matches`);
/// `path` e `firstParent` mudam o próprio grafo.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphQuery {
    pub refs: RefMode,
    /// Nomes completos (`refs/heads/x`) ou curtos, para `selected`.
    pub selected: Vec<String>,
    pub author: Option<String>,
    pub search: Option<String>,
    pub path: Option<String>,
    pub first_parent: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphCursor {
    pub skip: u32,
    /// Hashes das revs resolvidas na 1ª página.
    pub revs: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GraphPerson {
    pub name: String,
    pub email: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    /// Unix (s).
    pub author_time: i64,
    pub commit_time: i64,
    pub subject: String,
    pub co_authors: Vec<GraphPerson>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphRef {
    /// Nome completo (`refs/heads/main`).
    pub name: String,
    /// Nome curto (`main`, `origin/main`, `v1.0`).
    pub short: String,
    /// `branch` | `remote` | `tag`.
    pub kind: String,
    /// Commit (tags anotadas já descascadas).
    pub target: String,
    /// Upstream curto (`origin/main`).
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Upstream configurado mas apagado no remoto.
    pub gone: bool,
    pub is_head: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphHead {
    pub hash: Option<String>,
    /// Branch curta; `None` destacado.
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GraphRemote {
    pub name: String,
    pub url: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphHeader {
    pub refs: Vec<GraphRef>,
    pub head: GraphHead,
    /// Branch base (curta), ex.: `main`; `origin/main` se só existir remota.
    pub default_branch: Option<String>,
    /// Refs usadas pelo modo escolhido (nomes curtos, para o seletor).
    pub selected_refs: Vec<String>,
    /// Só no upstream (↓ a receber).
    pub incoming: Vec<String>,
    /// Só no HEAD (↑ a enviar).
    pub outgoing: Vec<String>,
    pub remotes: Vec<GraphRemote>,
    pub identity: Option<GraphPerson>,
    /// Hashes que casam autor/texto (com filtro); `None` sem filtro.
    pub matches: Option<Vec<String>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    pub commits: Vec<GraphRow>,
    pub cursor: Option<GraphCursor>,
    pub header: Option<GraphHeader>,
    pub elapsed_ms: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer: String,
    pub committer_email: String,
    pub commit_time: i64,
    pub subject: String,
    /// Mensagem completa (`%B`), com trailers.
    pub message: String,
    pub co_authors: Vec<GraphPerson>,
    pub files: Vec<GitCommitFile>,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineageMerge {
    pub hash: String,
    pub subject: String,
    pub time: i64,
    /// Número do PR/MR quando o assunto diz (`Merge pull request #N`, `(#N)`).
    pub pr: Option<u32>,
    /// Integrada sem commit de merge (fast-forward/rebase).
    pub fast_forward: bool,
    /// 1º pai do merge (a base antes da integração).
    pub first_parent: Option<String>,
    /// Commits que a branch levou no merge (`M^1..ponta`).
    pub commits: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchLineage {
    pub reference: String,
    pub base: String,
    pub tip: String,
    pub base_tip: String,
    pub merge_base: Option<String>,
    pub merge_base_subject: Option<String>,
    pub merge_base_time: Option<i64>,
    /// Commits só na ref.
    pub ahead: u32,
    /// Commits só na base.
    pub behind: u32,
    /// First-parent da ponta até antes do merge-base (destacado no grafo).
    pub path: Vec<String>,
    pub merged_into: Option<LineageMerge>,
    /// A ref é a própria base.
    pub is_base: bool,
}

// ---------------------------------------------------------------- parsers

fn split_people(raw: &str) -> Vec<GraphPerson> {
    raw.split('\x1d')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(parse_person)
        .collect()
}

/// `Nome <email>` → pessoa (sem `<…>` o texto todo vira nome).
pub(crate) fn parse_person(raw: &str) -> GraphPerson {
    let raw = raw.trim();
    match (raw.rfind('<'), raw.rfind('>')) {
        (Some(open), Some(close)) if close > open => GraphPerson {
            name: raw[..open].trim().to_string(),
            email: super::normalize_git_email(&raw[open + 1..close]),
        },
        _ => GraphPerson {
            name: raw.to_string(),
            email: String::new(),
        },
    }
}

/// Parser do `git log` com [`GRAPH_FORMAT`].
pub(crate) fn parse_graph_rows(raw: &str) -> Vec<GraphRow> {
    let mut rows = Vec::new();
    for record in raw.split('\x1e') {
        let record = record.trim_end_matches(['\n', '\0']);
        if record.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = record.split('\x1f').collect();
        if f.len() < 7 {
            continue;
        }
        rows.push(GraphRow {
            hash: f[0].trim().to_string(),
            parents: f[1].split_whitespace().map(str::to_string).collect(),
            author: f[2].to_string(),
            author_email: super::normalize_git_email(f[3]),
            author_time: f[4].trim().parse().unwrap_or(0),
            commit_time: f[5].trim().parse().unwrap_or(0),
            subject: f[6].to_string(),
            co_authors: f.get(7).map(|s| split_people(s)).unwrap_or_default(),
        });
    }
    rows
}

fn short_ref_name(full: &str) -> (String, &'static str) {
    if let Some(rest) = full.strip_prefix("refs/heads/") {
        (rest.to_string(), "branch")
    } else if let Some(rest) = full.strip_prefix("refs/remotes/") {
        (rest.to_string(), "remote")
    } else if let Some(rest) = full.strip_prefix("refs/tags/") {
        (rest.to_string(), "tag")
    } else {
        (full.to_string(), "other")
    }
}

/// `ahead 2, behind 1` / `gone` / vazio.
fn parse_track(track: &str) -> (u32, u32, bool) {
    let mut ahead = 0;
    let mut behind = 0;
    if track.trim() == "gone" {
        return (0, 0, true);
    }
    for part in track.split(',') {
        let mut it = part.split_whitespace();
        match (it.next(), it.next().and_then(|n| n.parse().ok())) {
            (Some("ahead"), Some(n)) => ahead = n,
            (Some("behind"), Some(n)) => behind = n,
            _ => {}
        }
    }
    (ahead, behind, false)
}

/// Refs parseadas + o alvo de `refs/remotes/<r>/HEAD` (para a base).
#[derive(Debug, Default)]
pub(crate) struct ParsedRefs {
    pub refs: Vec<GraphRef>,
    /// `refs/remotes/origin/main` (de `origin/HEAD`).
    pub remote_head: Option<String>,
}

/// Parser do `for-each-ref` com [`REFS_FORMAT`]. Ignora `refs/stash`, notas,
/// tags que não apontam para commits e os `HEAD` simbólicos dos remotos.
pub(crate) fn parse_refs(raw: &str) -> ParsedRefs {
    let mut out = ParsedRefs::default();
    for line in raw.lines() {
        let f: Vec<&str> = line.split('\0').collect();
        if f.len() < 9 {
            continue;
        }
        let name = f[0];
        let (short, kind) = short_ref_name(name);
        if kind == "other" {
            continue;
        }
        if !f[8].is_empty() {
            // `refs/remotes/origin/HEAD -> refs/remotes/origin/main`.
            if kind == "remote" && name.ends_with("/HEAD") && out.remote_head.is_none() {
                out.remote_head = Some(f[8].to_string());
            }
            continue;
        }
        let (target, ty) = if !f[2].is_empty() { (f[2], f[4]) } else { (f[1], f[3]) };
        if ty != "commit" {
            continue;
        }
        let (ahead, behind, gone) = parse_track(f[6]);
        out.refs.push(GraphRef {
            name: name.to_string(),
            short,
            kind: kind.to_string(),
            target: target.to_string(),
            upstream: (!f[5].is_empty()).then(|| short_ref_name(f[5]).0),
            ahead,
            behind,
            gone,
            is_head: f[7].trim() == "*",
        });
    }
    out
}

/// `git rev-parse HEAD --symbolic-full-name HEAD` → (hash, branch completa).
pub(crate) fn head_args() -> Vec<String> {
    vec![
        "rev-parse".into(),
        "HEAD".into(),
        "--symbolic-full-name".into(),
        "HEAD".into(),
    ]
}

pub(crate) fn parse_head(raw: &str, refs: &[GraphRef]) -> GraphHead {
    let mut lines = raw.lines().map(str::trim).filter(|l| !l.is_empty());
    let hash = lines.next().filter(|h| h.len() >= 7 && h.chars().all(|c| c.is_ascii_hexdigit()));
    let Some(hash) = hash else {
        return GraphHead::default();
    };
    let symbolic = lines.next().unwrap_or("HEAD");
    let branch_ref = refs.iter().find(|r| r.kind == "branch" && r.name == symbolic);
    GraphHead {
        hash: Some(hash.to_string()),
        branch: symbolic.strip_prefix("refs/heads/").map(str::to_string),
        detached: !symbolic.starts_with("refs/heads/"),
        upstream: branch_ref.and_then(|r| r.upstream.clone()),
        ahead: branch_ref.map(|r| r.ahead).unwrap_or(0),
        behind: branch_ref.map(|r| r.behind).unwrap_or(0),
    }
}

/// `rev-list --left-right HEAD...@{u}`: `<hash` = enviar, `>hash` = receber.
pub(crate) fn track_args() -> Vec<String> {
    vec![
        "rev-list".into(),
        "--left-right".into(),
        format!("--max-count={TRACK_CAP}"),
        "HEAD...@{upstream}".into(),
    ]
}

pub(crate) fn parse_track_list(raw: &str) -> (Vec<String>, Vec<String>) {
    let mut outgoing = Vec::new();
    let mut incoming = Vec::new();
    for line in raw.lines() {
        if let Some(h) = line.strip_prefix('<') {
            outgoing.push(h.trim().to_string());
        } else if let Some(h) = line.strip_prefix('>') {
            incoming.push(h.trim().to_string());
        }
    }
    (incoming, outgoing)
}

/// Identidade + remotos de [`GRAPH_META_ARGS`].
pub(crate) fn parse_graph_meta(raw: &str) -> (Option<GraphPerson>, Vec<GraphRemote>) {
    let mut name = String::new();
    let mut email = String::new();
    let mut remotes = Vec::new();
    for line in raw.lines() {
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        let lower = key.to_ascii_lowercase();
        match lower.as_str() {
            "user.name" => name = value.trim().to_string(),
            "user.email" => email = super::normalize_git_email(value),
            _ => {
                if let Some(remote) = key
                    .strip_prefix("remote.")
                    .and_then(|r| r.strip_suffix(".url"))
                {
                    remotes.push(GraphRemote {
                        name: remote.to_string(),
                        url: value.trim().to_string(),
                    });
                }
            }
        }
    }
    let identity = (!name.is_empty() || !email.is_empty()).then_some(GraphPerson { name, email });
    (identity, remotes)
}

/// Branch base: alvo de `origin/HEAD` (local se existir), senão
/// main/master/develop/trunk locais, senão remotos com esses nomes.
pub(crate) fn detect_default_branch(parsed: &ParsedRefs) -> Option<&GraphRef> {
    let find = |name: &str| parsed.refs.iter().find(|r| r.name == name);
    if let Some(remote_head) = parsed.remote_head.as_deref() {
        if let Some(rest) = remote_head.strip_prefix("refs/remotes/") {
            if let Some((_, branch)) = rest.split_once('/') {
                if let Some(local) = find(&format!("refs/heads/{branch}")) {
                    return Some(local);
                }
            }
        }
        if let Some(remote) = find(remote_head) {
            return Some(remote);
        }
    }
    for candidate in ["main", "master", "develop", "trunk"] {
        if let Some(local) = find(&format!("refs/heads/{candidate}")) {
            return Some(local);
        }
    }
    for candidate in ["main", "master", "develop", "trunk"] {
        if let Some(remote) = parsed
            .refs
            .iter()
            .find(|r| r.kind == "remote" && r.short.split_once('/').is_some_and(|(_, b)| b == candidate))
        {
            return Some(remote);
        }
    }
    None
}

/// Revs (hashes) + nomes curtos exibidos para o modo de seleção.
pub(crate) fn resolve_revs(query: &GraphQuery, parsed: &ParsedRefs, head: &GraphHead) -> (Vec<String>, Vec<String>) {
    struct Collect {
        revs: Vec<String>,
        names: Vec<String>,
        seen: HashSet<String>,
    }
    impl Collect {
        fn push(&mut self, hash: &str, name: Option<&str>) {
            if let Some(name) = name {
                if !self.names.iter().any(|n| n == name) {
                    self.names.push(name.to_string());
                }
            }
            if !hash.is_empty() && self.seen.insert(hash.to_string()) {
                self.revs.push(hash.to_string());
            }
        }
    }
    let mut c = Collect {
        revs: Vec::new(),
        names: Vec::new(),
        seen: HashSet::new(),
    };
    let by_short = |short: &str| parsed.refs.iter().find(|r| r.short == short || r.name == short);
    let head_name = head.branch.clone().unwrap_or_else(|| "HEAD".to_string());
    let add_current = |c: &mut Collect| {
        if let Some(h) = head.hash.as_deref() {
            c.push(h, Some(&head_name));
        }
        if let Some(up) = head.upstream.as_deref().and_then(by_short) {
            c.push(&up.target, Some(&up.short));
        }
    };
    match query.refs {
        RefMode::All => {
            if let Some(h) = head.hash.as_deref() {
                c.push(h, None);
            }
            for r in &parsed.refs {
                c.push(&r.target, None);
            }
        }
        RefMode::Current => add_current(&mut c),
        RefMode::Auto => {
            add_current(&mut c);
            if let Some(base) = detect_default_branch(parsed) {
                c.push(&base.target, Some(&base.short));
                // A remota da base (origin/main) entra junto: mostra o que chegou.
                let remote = base
                    .upstream
                    .as_deref()
                    .and_then(by_short)
                    .filter(|r| r.kind == "remote");
                if let Some(remote) = remote {
                    c.push(&remote.target, Some(&remote.short));
                }
            }
        }
        RefMode::Selected => {
            for wanted in &query.selected {
                if wanted == "HEAD" {
                    if let Some(h) = head.hash.as_deref() {
                        c.push(h, Some("HEAD"));
                    }
                } else if let Some(r) = by_short(wanted) {
                    c.push(&r.target, Some(&r.short));
                }
            }
            if c.revs.is_empty() {
                add_current(&mut c);
            }
        }
    }
    (c.revs, c.names)
}

/// `git log` de uma página (busca `page + 1` para saber se há mais).
pub(crate) fn page_log_args(query: &GraphQuery, cursor: &GraphCursor, page: u32) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "log".into(),
        "--topo-order".into(),
        "--no-color".into(),
        GRAPH_FORMAT.into(),
        format!("--skip={}", cursor.skip),
        format!("--max-count={}", page + 1),
    ];
    if query.first_parent {
        args.push("--first-parent".into());
    }
    let path = query.path.as_deref().map(str::trim).filter(|p| !p.is_empty());
    if path.is_some() {
        // Pais reescritos: com pathspec o grafo continua conexo.
        args.push("--parents".into());
    }
    args.extend(cursor.revs.iter().cloned());
    if let Some(path) = path {
        args.push("--".into());
        args.push(path.to_string());
    }
    args
}

/// Hashes que casam autor/texto (`None` sem filtro).
pub(crate) fn match_args(query: &GraphQuery, revs: &[String]) -> Option<Vec<String>> {
    let author = query.author.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let search = query.search.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if author.is_none() && search.is_none() {
        return None;
    }
    let mut args: Vec<String> = vec![
        "log".into(),
        "--format=%H".into(),
        format!("--max-count={MATCH_CAP}"),
        "--regexp-ignore-case".into(),
        "--fixed-strings".into(),
        "--all-match".into(),
    ];
    if query.first_parent {
        args.push("--first-parent".into());
    }
    if let Some(a) = author {
        args.push(format!("--author={a}"));
    }
    if let Some(s) = search {
        args.push(format!("--grep={s}"));
    }
    args.extend(revs.iter().cloned());
    if let Some(path) = query.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        args.push("--".into());
        args.push(path.to_string());
    }
    Some(args)
}

/// Linhas → página (corta o excedente e gera o próximo cursor).
pub(crate) fn finish_page(mut rows: Vec<GraphRow>, cursor: &GraphCursor, page: u32) -> (Vec<GraphRow>, Option<GraphCursor>) {
    let more = rows.len() > page as usize;
    rows.truncate(page as usize);
    let next = more.then(|| GraphCursor {
        skip: cursor.skip + page,
        revs: cursor.revs.clone(),
    });
    (rows, next)
}

pub(crate) fn clamp_page(page: Option<u32>) -> u32 {
    page.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE)
}

/// Monta o cabeçalho a partir das saídas cruas da 1ª página.
pub(crate) struct HeaderParts {
    pub parsed: ParsedRefs,
    pub head: GraphHead,
    pub identity: Option<GraphPerson>,
    pub remotes: Vec<GraphRemote>,
    pub incoming: Vec<String>,
    pub outgoing: Vec<String>,
}

pub(crate) fn header_parts(meta_raw: &str, refs_raw: &str, head_raw: &str, track_raw: &str) -> HeaderParts {
    let parsed = parse_refs(refs_raw);
    let head = parse_head(head_raw, &parsed.refs);
    let (identity, remotes) = parse_graph_meta(meta_raw);
    let (incoming, outgoing) = if head.upstream.is_some() {
        parse_track_list(track_raw)
    } else {
        (Vec::new(), Vec::new())
    };
    HeaderParts {
        parsed,
        head,
        identity,
        remotes,
        incoming,
        outgoing,
    }
}

pub(crate) fn build_header(parts: HeaderParts, selected_refs: Vec<String>, matches: Option<Vec<String>>) -> GraphHeader {
    let default_branch = detect_default_branch(&parts.parsed).map(|r| r.short.clone());
    GraphHeader {
        refs: parts.parsed.refs,
        head: parts.head,
        default_branch,
        selected_refs,
        incoming: parts.incoming,
        outgoing: parts.outgoing,
        remotes: parts.remotes,
        identity: parts.identity,
        matches,
    }
}

pub(crate) fn parse_matches(raw: &str) -> Vec<String> {
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

// ---------------------------------------------------------------- detalhes

pub(crate) fn details_args(commit: &str) -> Vec<String> {
    vec![
        "show".into(),
        DETAILS_FORMAT.into(),
        "-z".into(),
        "--raw".into(),
        "--numstat".into(),
        "--find-renames".into(),
        "--no-ext-diff".into(),
        "--no-color".into(),
        // Merge: arquivos em relação ao 1º pai (o que o merge trouxe).
        "--diff-merges=first-parent".into(),
        commit.into(),
        "--".into(),
    ]
}

/// Parser de [`details_args`]: cabeçalho + `--raw -z` (status, caminhos) +
/// `--numstat -z` (adições/remoções; binário `-`).
pub(crate) fn parse_details(raw: &str) -> Option<CommitDetails> {
    let start = raw.find('\x1e')?;
    let rest = &raw[start + 1..];
    let end = rest.find('\x1e')?;
    let header = &rest[..end];
    let tail = &rest[end + 1..];
    let f: Vec<&str> = header.splitn(10, '\x1f').collect();
    if f.len() < 10 {
        return None;
    }
    let message = f[9].trim_end().to_string();
    let subject = message.lines().next().unwrap_or("").to_string();

    let mut files: Vec<GitCommitFile> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut tokens = tail.split('\0').peekable();
    while let Some(token) = tokens.next() {
        let token = token.trim_start_matches('\n');
        if token.is_empty() {
            continue;
        }
        if let Some(meta) = token.strip_prefix(':') {
            // `:100644 100644 abc def M` + caminho(s).
            let status_field = meta.split_whitespace().last().unwrap_or("M");
            let status = status_field.chars().next().unwrap_or('M').to_string();
            let renamed = matches!(status.as_str(), "R" | "C");
            let first = tokens.next().unwrap_or("").to_string();
            let (old_path, path) = if renamed {
                (Some(first), tokens.next().unwrap_or("").to_string())
            } else {
                (None, first)
            };
            if path.is_empty() {
                continue;
            }
            index.insert(path.clone(), files.len());
            files.push(GitCommitFile {
                path,
                old_path,
                status,
                additions: 0,
                deletions: 0,
            });
            continue;
        }
        let mut parts = token.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = tokens.next();
            tokens.next().unwrap_or("").to_string()
        } else {
            path.to_string()
        };
        if let Some(&i) = index.get(&path) {
            files[i].additions = add.parse().unwrap_or(0);
            files[i].deletions = del.parse().unwrap_or(0);
        }
    }
    let additions = files.iter().map(|f| f.additions).sum();
    let deletions = files.iter().map(|f| f.deletions).sum();
    Some(CommitDetails {
        hash: f[0].trim().to_string(),
        parents: f[1].split_whitespace().map(str::to_string).collect(),
        author: f[2].to_string(),
        author_email: super::normalize_git_email(f[3]),
        author_time: f[4].trim().parse().unwrap_or(0),
        committer: f[5].to_string(),
        committer_email: super::normalize_git_email(f[6]),
        commit_time: f[7].trim().parse().unwrap_or(0),
        co_authors: split_people(f[8]),
        subject,
        message,
        files,
        additions,
        deletions,
    })
}

/// Cache de detalhes por (repo, hash completo). Commits não mudam.
struct DetailsCache {
    map: HashMap<String, CommitDetails>,
    order: VecDeque<String>,
}

const DETAILS_CACHE_CAP: usize = 512;

fn details_cache() -> &'static Mutex<DetailsCache> {
    static CACHE: OnceLock<Mutex<DetailsCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(DetailsCache {
            map: HashMap::new(),
            order: VecDeque::new(),
        })
    })
}

fn is_full_hash(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.chars().all(|c| c.is_ascii_hexdigit())
}

pub(crate) fn cached_details(key_root: &str, hash: &str) -> Option<CommitDetails> {
    if !is_full_hash(hash) {
        return None;
    }
    let cache = details_cache().lock().unwrap_or_else(|e| e.into_inner());
    cache.map.get(&format!("{key_root}\0{hash}")).cloned()
}

pub(crate) fn store_details(key_root: &str, details: &CommitDetails) {
    if !is_full_hash(&details.hash) {
        return;
    }
    let key = format!("{key_root}\0{}", details.hash);
    let mut cache = details_cache().lock().unwrap_or_else(|e| e.into_inner());
    if cache.map.insert(key.clone(), details.clone()).is_none() {
        cache.order.push_back(key);
        while cache.order.len() > DETAILS_CACHE_CAP {
            if let Some(old) = cache.order.pop_front() {
                cache.map.remove(&old);
            }
        }
    }
}

// ---------------------------------------------------------------- linhagem

/// Número do PR/MR no assunto/mensagem de um merge.
pub(crate) fn pull_request_number(message: &str) -> Option<u32> {
    let first = message.lines().next().unwrap_or("");
    let digits = |s: &str| -> Option<u32> {
        let n: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        n.parse().ok()
    };
    if let Some(rest) = first.strip_prefix("Merge pull request #") {
        return digits(rest);
    }
    // Squash do GitHub: "feat: x (#123)".
    if let Some(open) = first.rfind("(#") {
        if first.trim_end().ends_with(')') {
            return digits(&first[open + 2..]);
        }
    }
    // GitLab: "See merge request grupo/proj!42".
    for line in message.lines() {
        if let Some(pos) = line.find("See merge request ") {
            if let Some(bang) = line[pos..].rfind('!') {
                return digits(&line[pos + bang + 1..]);
            }
        }
    }
    None
}

/// Comandos independentes da linhagem (um lote no SSH).
pub(crate) fn lineage_args(reference: &str, base: &str) -> Vec<Vec<String>> {
    vec![
        vec![
            "rev-parse".into(),
            format!("{reference}^{{commit}}"),
            format!("{base}^{{commit}}"),
        ],
        vec!["merge-base".into(), reference.into(), base.into()],
        vec![
            "rev-list".into(),
            "--left-right".into(),
            "--count".into(),
            format!("{reference}...{base}"),
            "--".into(),
        ],
        vec![
            "rev-list".into(),
            "--first-parent".into(),
            format!("--max-count={LINEAGE_PATH_CAP}"),
            format!("{base}..{reference}"),
            "--".into(),
        ],
        vec![
            "log".into(),
            "--first-parent".into(),
            "--ancestry-path".into(),
            "--format=%H%x1f%P%x1f%ct%x1f%s".into(),
            format!("{reference}..{base}"),
            "--".into(),
        ],
    ]
}

/// Branch já mesclada: o merge-base com a base fica na própria ponta, então a
/// divergência real é com o 1º pai do merge (`M^1`), e o caminho são os
/// commits que o merge trouxe (`M^1..ponta`, first-parent).
pub(crate) fn merged_lineage_args(tip: &str, merge_first_parent: &str) -> Vec<Vec<String>> {
    vec![
        vec!["merge-base".into(), tip.into(), merge_first_parent.into()],
        vec![
            "rev-list".into(),
            "--first-parent".into(),
            format!("--max-count={LINEAGE_PATH_CAP}"),
            format!("{merge_first_parent}..{tip}"),
            "--".into(),
        ],
        vec!["rev-list".into(), "--count".into(), format!("{merge_first_parent}..{tip}"), "--".into()],
    ]
}

pub(crate) fn apply_merged_lineage(lineage: &mut BranchLineage, outs: &[Result<String, String>]) {
    let get = |i: usize| outs.get(i).and_then(|r| r.as_ref().ok()).map(String::as_str).unwrap_or("");
    let mb = get(0).trim();
    if !mb.is_empty() {
        lineage.merge_base = Some(mb.to_string());
    }
    lineage.path = parse_matches(get(1));
    if let Some(m) = lineage.merged_into.as_mut() {
        m.commits = get(2).trim().parse().unwrap_or(0);
    }
}

/// Precisa da 2ª rodada (branch mesclada via commit de merge)?
pub(crate) fn merged_first_parent(lineage: &BranchLineage) -> Option<String> {
    lineage
        .merged_into
        .as_ref()
        .filter(|m| !m.fast_forward)
        .and_then(|m| m.first_parent.clone())
}

pub(crate) fn merge_base_summary_args(hash: &str) -> Vec<String> {
    vec![
        "log".into(),
        "-1".into(),
        "--format=%s%x1f%ct".into(),
        hash.into(),
    ]
}

/// Monta a linhagem a partir das saídas de [`lineage_args`] (erros = vazio).
pub(crate) fn build_lineage(reference: &str, base: &str, outs: &[Result<String, String>]) -> Result<BranchLineage, String> {
    let get = |i: usize| outs.get(i).and_then(|r| r.as_ref().ok()).map(String::as_str).unwrap_or("");
    let mut tips = get(0).lines().map(str::trim).filter(|l| !l.is_empty());
    let tip = tips.next().map(str::to_string).ok_or_else(|| format!("Ref não encontrada: {reference}"))?;
    let base_tip = tips.next().map(str::to_string).ok_or_else(|| format!("Branch base não encontrada: {base}"))?;
    let merge_base = get(1).trim().to_string();
    let merge_base = (!merge_base.is_empty()).then_some(merge_base);
    let mut counts = get(2).split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
    let ahead = counts.next().unwrap_or(0);
    let behind = counts.next().unwrap_or(0);
    let path = parse_matches(get(3));
    let is_base = tip == base_tip && ahead == 0 && behind == 0 && reference_same_branch(reference, base);
    let mut merged_into = None;
    if ahead == 0 && tip != base_tip && !is_base {
        // O mais antigo do first-parent da base que descende da ponta.
        if let Some(line) = get(4).lines().filter(|l| !l.trim().is_empty()).last() {
            let f: Vec<&str> = line.splitn(4, '\x1f').collect();
            if f.len() == 4 {
                let parents: Vec<&str> = f[1].split_whitespace().collect();
                let is_merge = parents.len() > 1 && parents[0] != tip;
                merged_into = Some(LineageMerge {
                    hash: f[0].to_string(),
                    subject: f[3].to_string(),
                    time: f[2].trim().parse().unwrap_or(0),
                    pr: pull_request_number(f[3]),
                    fast_forward: !is_merge,
                    first_parent: parents.first().map(|p| p.to_string()),
                    commits: 0,
                });
            }
        }
    }
    Ok(BranchLineage {
        reference: reference.to_string(),
        base: base.to_string(),
        tip,
        base_tip,
        merge_base,
        merge_base_subject: None,
        merge_base_time: None,
        ahead,
        behind,
        path,
        merged_into,
        is_base,
    })
}

fn reference_same_branch(a: &str, b: &str) -> bool {
    let strip = |s: &str| -> String {
        let s = s
            .trim_start_matches("refs/heads/")
            .trim_start_matches("refs/remotes/");
        s.to_string()
    };
    let (a, b) = (strip(a), strip(b));
    a == b || a.split_once('/').is_some_and(|(_, rest)| rest == b) || b.split_once('/').is_some_and(|(_, rest)| rest == a)
}

pub(crate) fn apply_merge_base_summary(lineage: &mut BranchLineage, raw: &str) {
    let line = raw.lines().next().unwrap_or("");
    if let Some((subject, time)) = line.split_once('\x1f') {
        lineage.merge_base_subject = Some(subject.to_string());
        lineage.merge_base_time = time.trim().parse().ok();
    }
}

// ---------------------------------------------------------------- local

fn run_owned(path: &str, args: &[String]) -> Result<String, String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    runner::run(path, &refs)
}

fn elapsed_ms(start: Instant) -> u32 {
    start.elapsed().as_millis().min(u32::MAX as u128) as u32
}

/// Página do grafo (local). Sem cursor = 1ª página + cabeçalho.
#[tauri::command]
pub async fn git_graph_page(
    path: String,
    query: Option<GraphQuery>,
    cursor: Option<GraphCursor>,
    page_size: Option<u32>,
) -> Result<GraphPage, String> {
    runner::blocking(move || git_graph_page_blocking(path, query.unwrap_or_default(), cursor, page_size)).await
}

pub(crate) fn git_graph_page_blocking(
    path: String,
    query: GraphQuery,
    cursor: Option<GraphCursor>,
    page_size: Option<u32>,
) -> Result<GraphPage, String> {
    let start = Instant::now();
    let page = clamp_page(page_size);
    if let Some(cursor) = cursor {
        let raw = match run_owned(&path, &page_log_args(&query, &cursor, page)) {
            Ok(raw) => raw,
            Err(e) if history::is_empty_history_error(&e) => String::new(),
            Err(e) => return Err(e),
        };
        let (commits, next) = finish_page(parse_graph_rows(&raw), &cursor, page);
        return Ok(GraphPage {
            commits,
            cursor: next,
            header: None,
            elapsed_ms: elapsed_ms(start),
        });
    }

    // 1ª página: meta, refs, HEAD e recebidos/enviados em paralelo.
    let (meta, refs, head, track) = std::thread::scope(|s| {
        let meta = s.spawn(|| runner::run(&path, &GRAPH_META_ARGS).unwrap_or_default());
        let refs = s.spawn(|| run_owned(&path, &["for-each-ref".into(), REFS_FORMAT.into()]));
        let head = s.spawn(|| run_owned(&path, &head_args()).unwrap_or_default());
        let track = s.spawn(|| run_owned(&path, &track_args()).unwrap_or_default());
        (
            meta.join().unwrap_or_default(),
            refs.join().unwrap_or_else(|_| Err("for-each-ref falhou".into())),
            head.join().unwrap_or_default(),
            track.join().unwrap_or_default(),
        )
    });
    let refs = match refs {
        Ok(raw) => raw,
        Err(e) if super::is_not_repo_error(&e) => return Err("Esta pasta não é um repositório Git.".into()),
        Err(e) => return Err(e),
    };
    let parts = header_parts(&meta, &refs, &head, &track);
    let (revs, selected) = resolve_revs(&query, &parts.parsed, &parts.head);
    if revs.is_empty() {
        return Ok(GraphPage {
            commits: Vec::new(),
            cursor: None,
            header: Some(build_header(parts, selected, None)),
            elapsed_ms: elapsed_ms(start),
        });
    }
    let first = GraphCursor { skip: 0, revs };
    let match_cmd = match_args(&query, &first.revs);
    let root = path.as_str();
    let (log, matches) = std::thread::scope(|s| {
        let matches = match_cmd
            .as_ref()
            .map(|args| s.spawn(move || run_owned(root, args).map(|raw| parse_matches(&raw)).unwrap_or_default()));
        let log = run_owned(root, &page_log_args(&query, &first, page));
        (log, matches.map(|h| h.join().unwrap_or_default()))
    });
    let raw = match log {
        Ok(raw) => raw,
        Err(e) if history::is_empty_history_error(&e) => String::new(),
        Err(e) => return Err(e),
    };
    let (commits, next) = finish_page(parse_graph_rows(&raw), &first, page);
    Ok(GraphPage {
        commits,
        cursor: next,
        header: Some(build_header(parts, selected, matches)),
        elapsed_ms: elapsed_ms(start),
    })
}

/// Detalhes de um commit (mensagem completa, committer, arquivos, stats).
#[tauri::command]
pub async fn git_commit_details(path: String, commit: String) -> Result<CommitDetails, String> {
    runner::blocking(move || git_commit_details_blocking(path, commit)).await
}

pub(crate) fn git_commit_details_blocking(path: String, commit: String) -> Result<CommitDetails, String> {
    let commit = commit.trim().to_string();
    if commit.is_empty() || commit.starts_with('-') {
        return Err("Commit inválido.".into());
    }
    if let Some(hit) = cached_details(&path, &commit) {
        return Ok(hit);
    }
    let raw = run_owned(&path, &details_args(&commit))?;
    let details = parse_details(&raw).ok_or_else(|| "Não foi possível ler o commit.".to_string())?;
    store_details(&path, &details);
    Ok(details)
}

/// Linhagem de uma ref em relação à base (padrão: a base detectada).
#[tauri::command]
pub async fn git_branch_lineage(path: String, reference: String, base: Option<String>) -> Result<BranchLineage, String> {
    runner::blocking(move || git_branch_lineage_blocking(path, reference, base)).await
}

pub(crate) fn git_branch_lineage_blocking(path: String, reference: String, base: Option<String>) -> Result<BranchLineage, String> {
    let reference = reference.trim().to_string();
    if reference.is_empty() || reference.starts_with('-') {
        return Err("Ref inválida.".into());
    }
    let base = match base.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()) {
        Some(b) if !b.starts_with('-') => b,
        Some(_) => return Err("Base inválida.".into()),
        None => {
            let parsed = parse_refs(&run_owned(&path, &["for-each-ref".into(), REFS_FORMAT.into()])?);
            detect_default_branch(&parsed)
                .map(|r| r.short.clone())
                .ok_or_else(|| "Nenhuma branch base (main/master) encontrada.".to_string())?
        }
    };
    let cmds = lineage_args(&reference, &base);
    let outs: Vec<Result<String, String>> = std::thread::scope(|s| {
        let handles: Vec<_> = cmds.iter().map(|args| s.spawn(|| run_owned(&path, args))).collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Err("git falhou".into())))
            .collect()
    });
    let mut lineage = build_lineage(&reference, &base, &outs)?;
    if let Some(mfp) = merged_first_parent(&lineage) {
        let outs: Vec<Result<String, String>> = merged_lineage_args(&lineage.tip, &mfp)
            .iter()
            .map(|args| run_owned(&path, args))
            .collect();
        apply_merged_lineage(&mut lineage, &outs);
    }
    if let Some(mb) = lineage.merge_base.clone() {
        if let Ok(raw) = run_owned(&path, &merge_base_summary_args(&mb)) {
            apply_merge_base_summary(&mut lineage, &raw);
        }
    }
    Ok(lineage)
}

/// Arquivos entre duas revisões (`to` vazio = árvore de trabalho).
#[tauri::command]
pub async fn git_diff_files(path: String, from: String, to: Option<String>) -> Result<Vec<GitCommitFile>, String> {
    runner::blocking(move || git_diff_files_blocking(path, from, to)).await
}

pub(crate) fn diff_files_args(from: &str, to: Option<&str>, numstat: bool) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "diff".into(),
        if numstat { "--numstat".into() } else { "--name-status".into() },
        "--find-renames".into(),
        "--no-ext-diff".into(),
        "--no-color".into(),
        from.into(),
    ];
    if let Some(to) = to {
        args.push(to.into());
    }
    args.push("--".into());
    args
}

pub(crate) fn git_diff_files_blocking(path: String, from: String, to: Option<String>) -> Result<Vec<GitCommitFile>, String> {
    let from = from.trim().to_string();
    let to = to.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    if from.is_empty() || from.starts_with('-') || to.as_deref().is_some_and(|t| t.starts_with('-')) {
        return Err("Revisão inválida.".into());
    }
    let status = run_owned(&path, &diff_files_args(&from, to.as_deref(), false))?;
    let numstat = run_owned(&path, &diff_files_args(&from, to.as_deref(), true)).unwrap_or_default();
    Ok(super::parse_commit_file_records(&status, &numstat))
}

/// Cherry-pick de um commit no HEAD atual.
#[tauri::command]
pub async fn git_cherry_pick(path: String, commit: String) -> Result<String, String> {
    runner::blocking(move || git_cherry_pick_blocking(path, commit)).await
}

pub(crate) fn cherry_pick_args(commit: &str) -> Result<Vec<String>, String> {
    let commit = commit.trim();
    if commit.is_empty() || commit.starts_with('-') {
        return Err("Commit inválido para cherry-pick.".into());
    }
    Ok(vec!["cherry-pick".into(), commit.into()])
}

fn git_cherry_pick_blocking(path: String, commit: String) -> Result<String, String> {
    run_owned(&path, &cherry_pick_args(&commit)?)
}

/// Cria uma branch num commit (`git branch <nome> <commit>`), com checkout opcional.
#[tauri::command]
pub async fn git_create_branch_at(path: String, name: String, start: String, checkout: bool) -> Result<(), String> {
    runner::blocking(move || git_create_branch_at_blocking(path, name, start, checkout)).await
}

pub(crate) fn create_branch_at_args(name: &str, start: &str, checkout: bool) -> Result<Vec<String>, String> {
    let name = name.trim();
    let start = start.trim();
    if name.is_empty() || name.starts_with('-') {
        return Err("Nome de branch inválido.".into());
    }
    if start.is_empty() || start.starts_with('-') {
        return Err("Commit de origem inválido.".into());
    }
    Ok(if checkout {
        vec!["checkout".into(), "-b".into(), name.into(), start.into()]
    } else {
        vec!["branch".into(), name.into(), start.into()]
    })
}

fn git_create_branch_at_blocking(path: String, name: String, start: String, checkout: bool) -> Result<(), String> {
    run_owned(&path, &create_branch_at_args(&name, &start, checkout)?).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::TempRepo;

    #[test]
    fn parses_graph_rows_with_co_authors() {
        let raw = "\x1eaaa\x1fbbb ccc\x1fAna\x1f<Ana@X.com>\x1f1700000000\x1f1700000100\x1fMerge x\x1fClaude <c@a.com>\x1dBia <b@x.com>\n\x1ebbb\x1f\x1fBia\x1fb@x.com\x1f1\x1f2\x1finit\x1f\n";
        let rows = parse_graph_rows(raw);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].parents, vec!["bbb", "ccc"]);
        assert_eq!(rows[0].author_email, "ana@x.com");
        assert_eq!(rows[0].commit_time, 1700000100);
        assert_eq!(
            rows[0].co_authors,
            vec![
                GraphPerson { name: "Claude".into(), email: "c@a.com".into() },
                GraphPerson { name: "Bia".into(), email: "b@x.com".into() }
            ]
        );
        assert!(rows[1].parents.is_empty());
        assert!(rows[1].co_authors.is_empty());
    }

    #[test]
    fn parses_refs_track_tags_and_remote_head() {
        let raw = [
            "refs/heads/main\0aaa\0\0commit\0\0refs/remotes/origin/main\0ahead 2, behind 1\0*\0",
            "refs/heads/feat/x\0bbb\0\0commit\0\0refs/remotes/origin/feat/x\0gone\0 \0",
            "refs/remotes/origin/HEAD\0aaa\0\0commit\0\0\0\0 \0refs/remotes/origin/main",
            "refs/remotes/origin/main\0ccc\0\0commit\0\0\0\0 \0",
            "refs/tags/v1\0ttt\0ddd\0tag\0commit\0\0\0 \0",
            "refs/tags/blob\0eee\0\0blob\0\0\0\0 \0",
            "refs/stash\0fff\0\0commit\0\0\0\0 \0",
        ]
        .join("\n");
        let parsed = parse_refs(&raw);
        let names: Vec<&str> = parsed.refs.iter().map(|r| r.short.as_str()).collect();
        assert_eq!(names, vec!["main", "feat/x", "origin/main", "v1"]);
        assert_eq!(parsed.refs[0].ahead, 2);
        assert_eq!(parsed.refs[0].behind, 1);
        assert!(parsed.refs[0].is_head);
        assert!(parsed.refs[1].gone);
        assert_eq!(parsed.refs[3].target, "ddd");
        assert_eq!(parsed.refs[3].kind, "tag");
        assert_eq!(parsed.remote_head.as_deref(), Some("refs/remotes/origin/main"));
        assert_eq!(detect_default_branch(&parsed).map(|r| r.short.as_str()), Some("main"));
    }

    #[test]
    fn detects_pr_numbers() {
        assert_eq!(pull_request_number("Merge pull request #108 from a/b"), Some(108));
        assert_eq!(pull_request_number("feat: x (#42)"), Some(42));
        assert_eq!(pull_request_number("Merge branch 'x' into 'main'\n\nSee merge request grp/p!7"), Some(7));
        assert_eq!(pull_request_number("Merge branch 'x'"), None);
    }

    #[test]
    fn parses_details_with_rename_and_binary() {
        let raw = "\x1eabc\x1fp1\x1fAna\x1fana@x.com\x1f10\x1fBia\x1fbia@x.com\x1f20\x1fClaude <c@a.com>\x1ftitle\n\nbody line\n\nCo-authored-by: Claude <c@a.com>\n\x1e\0\
:100644 100644 a b M\0src/a.ts\0:100644 100644 c d R090\0old.ts\0new.ts\0:000000 100644 0 e A\0img.png\0\
3\t1\tsrc/a.ts\0\x30\t2\t\0old.ts\0new.ts\0-\t-\timg.png\0";
        let d = parse_details(raw).expect("details");
        assert_eq!(d.subject, "title");
        assert!(d.message.contains("body line"));
        assert_eq!(d.committer, "Bia");
        assert_eq!(d.co_authors.len(), 1);
        assert_eq!(d.files.len(), 3);
        assert_eq!(d.files[1].old_path.as_deref(), Some("old.ts"));
        assert_eq!(d.files[1].path, "new.ts");
        assert_eq!(d.files[1].status, "R");
        assert_eq!((d.files[0].additions, d.files[0].deletions), (3, 1));
        assert_eq!((d.files[1].additions, d.files[1].deletions), (0, 2));
        assert_eq!((d.additions, d.deletions), (3, 3));
    }

    /// main: c1 ← c2 ← (merge feat) m ← c5 ; feat: c1 ← f1 ← f2 ; tag v1 em c2;
    /// topic: c5 ← t1 (não integrada); origin/main = c2 (upstream de main).
    fn sample_repo() -> TempRepo {
        let repo = TempRepo::new();
        repo.write("a.txt", "1\n");
        repo.commit_all("c1");
        repo.git(&["checkout", "-q", "-b", "feat/x"]);
        repo.write("f.txt", "f1\n");
        repo.commit_all("f1");
        repo.write("f.txt", "f2\n");
        repo.git(&["add", "-A"]);
        repo.git(&["-c", "trailer.ifexists=add", "commit", "-q", "-m", "f2", "-m", "Co-authored-by: Claude Opus <noreply@anthropic.com>"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("a.txt", "2\n");
        repo.commit_all("c2");
        repo.git(&["tag", "-a", "v1", "-m", "versão 1"]);
        // "Remoto": origin/main parado em c2.
        repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        repo.git(&["config", "branch.main.remote", "origin"]);
        repo.git(&["config", "branch.main.merge", "refs/heads/main"]);
        repo.git(&["config", "remote.origin.url", "git@github.com:acme/app.git"]);
        repo.git(&["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
        repo.git(&["merge", "-q", "--no-ff", "feat/x", "-m", "Merge pull request #7 from acme/feat/x"]);
        repo.write("a.txt", "5\n");
        repo.commit_all("c5");
        repo.git(&["checkout", "-q", "-b", "topic"]);
        repo.write("t.txt", "t\n");
        repo.commit_all("t1");
        repo.git(&["checkout", "-q", "main"]);
        repo
    }

    #[test]
    fn graph_page_header_auto_and_paging() {
        let repo = sample_repo();
        let page = git_graph_page_blocking(repo.root(), GraphQuery::default(), None, Some(3)).expect("page");
        let header = page.header.expect("header");
        assert_eq!(header.head.branch.as_deref(), Some("main"));
        assert_eq!(header.head.upstream.as_deref(), Some("origin/main"));
        assert_eq!(header.head.ahead, 4, "merge + f1 + f2 + c5: {:?}", header.head);
        assert_eq!(header.default_branch.as_deref(), Some("main"));
        assert_eq!(header.outgoing.len(), 4);
        assert!(header.incoming.is_empty());
        assert_eq!(header.selected_refs, vec!["main", "origin/main"]);
        assert!(header.refs.iter().any(|r| r.short == "v1" && r.kind == "tag"));
        assert_eq!(header.remotes, vec![GraphRemote { name: "origin".into(), url: "git@github.com:acme/app.git".into() }]);
        assert_eq!(header.identity.as_ref().map(|p| p.email.as_str()), Some("ana@example.com"));
        // Auto não inclui `topic` (não é HEAD/upstream/base).
        assert_eq!(page.commits.len(), 3);
        assert_eq!(page.commits[0].subject, "c5");
        assert_eq!(page.commits[1].parents.len(), 2, "merge");
        let mut all = page.commits.clone();
        let mut cursor = page.cursor.clone();
        while let Some(c) = cursor {
            let next = git_graph_page_blocking(repo.root(), GraphQuery::default(), Some(c), Some(3)).unwrap();
            assert!(next.header.is_none());
            all.extend(next.commits);
            cursor = next.cursor;
        }
        let subjects: Vec<&str> = all.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects.len(), 6, "{subjects:?}");
        assert!(!subjects.contains(&"t1"));
        let f2 = all.iter().find(|c| c.subject == "f2").unwrap();
        assert_eq!(f2.co_authors[0].name, "Claude Opus");
    }

    #[test]
    fn graph_modes_all_selected_and_filters() {
        let repo = sample_repo();
        let all = git_graph_page_blocking(
            repo.root(),
            GraphQuery { refs: RefMode::All, ..Default::default() },
            None,
            Some(100),
        )
        .unwrap();
        assert_eq!(all.commits.len(), 7);
        assert!(all.cursor.is_none());

        let selected = git_graph_page_blocking(
            repo.root(),
            GraphQuery { refs: RefMode::Selected, selected: vec!["topic".into()], ..Default::default() },
            None,
            None,
        )
        .unwrap();
        assert_eq!(selected.header.unwrap().selected_refs, vec!["topic"]);
        assert_eq!(selected.commits[0].subject, "t1");

        let filtered = git_graph_page_blocking(
            repo.root(),
            GraphQuery { refs: RefMode::All, search: Some("F2".into()), ..Default::default() },
            None,
            None,
        )
        .unwrap();
        assert_eq!(filtered.commits.len(), 7, "o filtro não remove linhas");
        let matches = filtered.header.unwrap().matches.unwrap();
        assert_eq!(matches.len(), 1);

        let by_path = git_graph_page_blocking(
            repo.root(),
            GraphQuery { refs: RefMode::All, path: Some("f.txt".into()), ..Default::default() },
            None,
            None,
        )
        .unwrap();
        let subjects: Vec<&str> = by_path.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, vec!["f2", "f1"]);
        // Pais reescritos: f1 não aponta para c1 (fora do filtro).
        assert!(by_path.commits[1].parents.is_empty(), "{:?}", by_path.commits[1].parents);
    }

    #[test]
    fn commit_details_merge_and_cache() {
        let repo = sample_repo();
        let merge = repo.git(&["rev-parse", "main~1"]).trim().to_string();
        let d = git_commit_details_blocking(repo.root(), merge.clone()).unwrap();
        assert_eq!(d.parents.len(), 2);
        assert_eq!(d.files.len(), 1, "merge vs 1º pai: {:?}", d.files);
        assert_eq!(d.files[0].path, "f.txt");
        assert_eq!(d.additions, 1);
        assert!(cached_details(&repo.root(), &merge).is_some());
        let f2 = repo.git(&["rev-parse", "feat/x"]).trim().to_string();
        let d2 = git_commit_details_blocking(repo.root(), f2).unwrap();
        assert_eq!(d2.co_authors.len(), 1);
        assert!(d2.message.contains("Co-authored-by"));
    }

    #[test]
    fn lineage_divergence_merge_and_pending_branch() {
        let repo = sample_repo();
        let feat = git_branch_lineage_blocking(repo.root(), "feat/x".into(), None).unwrap();
        assert_eq!(feat.base, "main");
        assert_eq!(feat.ahead, 0);
        assert_eq!(feat.behind, 3, "c2, merge, c5");
        let merged = feat.merged_into.expect("integrada");
        assert_eq!(merged.pr, Some(7));
        assert!(!merged.fast_forward);
        assert_eq!(merged.commits, 2, "f1 + f2");
        // Divergência real: com o 1º pai do merge (c1), não com a ponta.
        assert_eq!(feat.merge_base_subject.as_deref(), Some("c1"));
        assert_eq!(feat.path.len(), 2);

        let topic = git_branch_lineage_blocking(repo.root(), "topic".into(), Some("main".into())).unwrap();
        assert_eq!((topic.ahead, topic.behind), (1, 0));
        assert_eq!(topic.path.len(), 1);
        assert!(topic.merged_into.is_none());
        assert_eq!(topic.merge_base_subject.as_deref(), Some("c5"));

        let base = git_branch_lineage_blocking(repo.root(), "main".into(), None).unwrap();
        assert!(base.is_base);
    }

    #[test]
    fn diff_files_cherry_pick_and_branch_at() {
        let repo = sample_repo();
        let files = git_diff_files_blocking(repo.root(), "v1".into(), Some("main".into())).unwrap();
        let mut paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["a.txt", "f.txt"]);
        repo.write("a.txt", "wt\n");
        let wt = git_diff_files_blocking(repo.root(), "HEAD".into(), None).unwrap();
        assert_eq!(wt.len(), 1);
        repo.git(&["checkout", "-q", "--", "a.txt"]);

        git_create_branch_at_blocking(repo.root(), "from-v1".into(), "v1".into(), false).unwrap();
        assert_eq!(repo.git(&["rev-parse", "from-v1"]), repo.git(&["rev-parse", "v1^{commit}"]));
        let t1 = repo.git(&["rev-parse", "topic"]).trim().to_string();
        git_cherry_pick_blocking(repo.root(), t1).unwrap();
        assert!(repo.git(&["log", "-1", "--format=%s"]).contains("t1"));
        assert!(cherry_pick_args("--abort").is_err());
        assert!(create_branch_at_args("x", "-x", false).is_err());
    }

    /// Medição manual: `FLUENT_GRAPH_BENCH=/caminho/repo cargo test --lib
    /// bench_graph_first_page -- --ignored --nocapture` (só leitura).
    #[test]
    #[ignore]
    fn bench_graph_first_page() {
        let Ok(root) = std::env::var("FLUENT_GRAPH_BENCH") else {
            return;
        };
        for mode in [RefMode::Auto, RefMode::All] {
            let mut best = u128::MAX;
            let mut rows = 0;
            for _ in 0..5 {
                let t = Instant::now();
                let page = git_graph_page_blocking(root.clone(), GraphQuery { refs: mode, ..Default::default() }, None, None).unwrap();
                best = best.min(t.elapsed().as_millis());
                rows = page.commits.len();
            }
            println!("{mode:?}: 1ª página ({rows} commits) em {best} ms");
        }
    }

    #[test]
    fn graph_commands_are_async() {
        fn is_future<F: std::future::Future>(_: F) {}
        let p = || String::from("/nonexistent");
        is_future(git_graph_page(p(), None, None, None));
        is_future(git_commit_details(p(), p()));
        is_future(git_branch_lineage(p(), p(), None));
        is_future(git_diff_files(p(), p(), None));
        is_future(git_cherry_pick(p(), p()));
        is_future(git_create_branch_at(p(), p(), p(), false));
    }
}
