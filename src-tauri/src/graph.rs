//! Builds the workspace "context graph" (Obsidian-style): every markdown file is
//! a node linked to the files it references (markdown links + `[[wikilinks]]`),
//! and every source file is a node linked to the local files it imports
//! (`import`/`require`/`export … from` in JS/TS, `mod` in Rust). The front end
//! lays it out with a force-directed simulation and renders it on a canvas.
//!
//! Resolution is best-effort and purely lexical (no disk canonicalisation beyond
//! the existence check against the collected file set), so it stays fast: only
//! edges whose target resolves to a file that is itself a node are kept. Bare
//! package imports (`react`, `serde`) have no node and are dropped.

use crate::walk::is_skipped_dir;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// Absolute path — also the node id and what the UI opens on click.
    pub id: String,
    /// File name (the node's label).
    pub name: String,
    /// Path relative to the root, normalised to `/` (shown on hover).
    pub rel: String,
    /// `"markdown"` or `"code"` — drives the node colour + the UI filter.
    pub kind: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    /// `"link"` | `"wikilink"` | `"import"`.
    pub kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// Cap the node count so a huge tree can't stall the layout simulation.
const MAX_NODES: usize = 4000;
/// Don't parse files larger than this (generated bundles, vendored blobs).
const MAX_PARSE_SIZE: u64 = 1_500_000;

fn is_markdown(p: &Path) -> bool {
    matches!(
        p.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md") | Some("markdown") | Some("mdx")
    )
}

fn is_code(p: &Path) -> bool {
    matches!(
        p.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("ts")
            | Some("tsx")
            | Some("js")
            | Some("jsx")
            | Some("mjs")
            | Some("cjs")
            | Some("rs")
    )
}

/// Lexically normalise a path (resolve `.`/`..` without touching the disk), so we
/// can match resolved import targets against the collected file set on any OS.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        use std::path::Component::*;
        match comp {
            ParentDir => {
                out.pop();
            }
            CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Walks `dir`, collecting markdown + source files (skipping heavy dirs).
fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_NODES {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_NODES {
            return;
        }
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_skipped_dir(&name) || name.starts_with('.') {
                continue;
            }
            collect(&path, out);
        } else if ft.is_file() && (is_markdown(&path) || is_code(&path)) {
            out.push(normalize(&path));
        }
    }
}

/// Candidate file extensions tried when a JS/TS import omits one.
const JS_EXTS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs"];

/// Resolves a relative JS/TS import `spec` (from `from_file`) to a node path.
fn resolve_js(from_file: &Path, spec: &str, set: &HashSet<PathBuf>) -> Option<PathBuf> {
    if !(spec.starts_with('.') || spec.starts_with('/')) {
        return None; // bare package import — no node for it
    }
    let base = normalize(&from_file.parent()?.join(spec));
    // Exact path (when the import already carries an extension).
    if set.contains(&base) {
        return Some(base);
    }
    // `./foo` → `./foo.ts`, `.tsx`, …
    for ext in JS_EXTS {
        let cand = base.with_extension(ext);
        if set.contains(&cand) {
            return Some(cand);
        }
    }
    // `./foo` → `./foo/index.ts`, …
    for ext in JS_EXTS {
        let cand = base.join(format!("index.{ext}"));
        if set.contains(&cand) {
            return Some(cand);
        }
    }
    None
}

/// Resolves a markdown link/anchor target (relative path) to a node path.
fn resolve_md(from_file: &Path, target: &str, set: &HashSet<PathBuf>) -> Option<PathBuf> {
    let clean = target.split(['#', '?']).next().unwrap_or(target).trim();
    if clean.is_empty()
        || clean.starts_with("http://")
        || clean.starts_with("https://")
        || clean.starts_with("mailto:")
    {
        return None;
    }
    let base = normalize(&from_file.parent()?.join(clean));
    if set.contains(&base) {
        return Some(base);
    }
    // A bare `[doc](editor)` link → try the markdown extension.
    let md = base.with_extension("md");
    if set.contains(&md) {
        return Some(md);
    }
    None
}

/// Resolves a Rust `mod name;` to its file (`name.rs` or `name/mod.rs`), honouring
/// the 2018-edition rule that a submodule of `a.rs` lives under `a/`.
fn resolve_rust_mod(from_file: &Path, name: &str, set: &HashSet<PathBuf>) -> Option<PathBuf> {
    let parent = from_file.parent()?;
    let stem = from_file.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let dir = if matches!(stem, "mod" | "lib" | "main") {
        parent.to_path_buf()
    } else {
        parent.join(stem)
    };
    let direct = normalize(&dir.join(format!("{name}.rs")));
    if set.contains(&direct) {
        return Some(direct);
    }
    let nested = normalize(&dir.join(name).join("mod.rs"));
    if set.contains(&nested) {
        return Some(nested);
    }
    None
}

struct Patterns {
    md_link: Regex,
    wikilink: Regex,
    js_import: Regex,
    js_from: Regex,
    js_call: Regex,
    rs_mod: Regex,
    // Index-only (Phase 2): markdown inline #tags and ATX headings.
    tag: Regex,
    heading: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        // [text](target) — capture the target.
        md_link: Regex::new(r"\[[^\]]*\]\(([^)\s]+)").unwrap(),
        // [[name]] or [[name|alias]] — capture the name.
        wikilink: Regex::new(r"\[\[([^\]\|#]+)").unwrap(),
        // import … from "x"   /   import "x"
        js_import: Regex::new(r#"(?m)^\s*import\b[^"']*?['"]([^'"]+)['"]"#).unwrap(),
        // export … from "x"
        js_from: Regex::new(r#"(?m)\bfrom\s+['"]([^'"]+)['"]"#).unwrap(),
        // require("x") / import("x")
        js_call: Regex::new(r#"\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]"#).unwrap(),
        // mod name;  (optionally `pub`/`pub(...)`)
        rs_mod: Regex::new(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;")
            .unwrap(),
        // inline #tag (not a heading: the `#` is preceded by start/non-word and
        // followed by a letter; `# Heading` has a space, so it never matches).
        tag: Regex::new(r"(?:^|[^\w#])#([A-Za-z][A-Za-z0-9_/-]*)").unwrap(),
        // ATX heading: `#`..`######` + text (trailing `#`s trimmed by the parser).
        heading: Regex::new(r"^(#{1,6})\s+(.+?)\s*#*\s*$").unwrap(),
    })
}

/// Builds the context graph for `root`.
#[tauri::command]
pub fn build_context_graph(root: String) -> Result<GraphData, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("não é um diretório: {root}"));
    }
    let root_norm = normalize(root_path);

    // 1. Collect candidate files (markdown + code).
    let mut files: Vec<PathBuf> = Vec::new();
    collect(&root_norm, &mut files);

    // 2. Lookup structures for resolution.
    let set: HashSet<PathBuf> = files.iter().cloned().collect();
    // Wikilinks resolve by file stem (case-insensitive), markdown only.
    let mut by_stem: HashMap<String, PathBuf> = HashMap::new();
    for f in &files {
        if is_markdown(f) {
            if let Some(stem) = f.file_stem().and_then(|s| s.to_str()) {
                by_stem
                    .entry(stem.to_lowercase())
                    .or_insert_with(|| f.clone());
            }
        }
    }

    let pat = patterns();
    // 3. Parse each file and collect edges (deduped via a set of (src,tgt,kind)).
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    let mut edges: Vec<GraphEdge> = Vec::new();
    let push = |src: &Path,
                tgt: &Path,
                kind: &str,
                edges: &mut Vec<GraphEdge>,
                seen: &mut HashSet<(String, String, String)>| {
        if src == tgt {
            return;
        }
        let s = src.to_string_lossy().to_string();
        let t = tgt.to_string_lossy().to_string();
        let key = (s.clone(), t.clone(), kind.to_string());
        if seen.insert(key) {
            edges.push(GraphEdge {
                source: s,
                target: t,
                kind: kind.to_string(),
            });
        }
    };

    for f in &files {
        if fs::metadata(f)
            .map(|m| m.len() > MAX_PARSE_SIZE)
            .unwrap_or(true)
        {
            continue;
        }
        let content = match fs::read_to_string(f) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if is_markdown(f) {
            for cap in pat.md_link.captures_iter(&content) {
                if let Some(t) = resolve_md(f, &cap[1], &set) {
                    push(f, &t, "link", &mut edges, &mut seen);
                }
            }
            for cap in pat.wikilink.captures_iter(&content) {
                let name = cap[1].trim().to_lowercase();
                if let Some(t) = by_stem.get(&name) {
                    push(f, t, "wikilink", &mut edges, &mut seen);
                }
            }
        } else if is_code(f) {
            let ext = f.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext.eq_ignore_ascii_case("rs") {
                for cap in pat.rs_mod.captures_iter(&content) {
                    if let Some(t) = resolve_rust_mod(f, &cap[1], &set) {
                        push(f, &t, "import", &mut edges, &mut seen);
                    }
                }
            } else {
                for re in [&pat.js_import, &pat.js_from, &pat.js_call] {
                    for cap in re.captures_iter(&content) {
                        if let Some(t) = resolve_js(f, &cap[1], &set) {
                            push(f, &t, "import", &mut edges, &mut seen);
                        }
                    }
                }
            }
        }
    }

    // 4. Build the node list.
    let nodes: Vec<GraphNode> = files
        .iter()
        .map(|f| {
            let rel = f
                .strip_prefix(&root_norm)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| f.to_string_lossy().to_string());
            GraphNode {
                id: f.to_string_lossy().to_string(),
                name: f
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                rel,
                kind: if is_markdown(f) {
                    "markdown".into()
                } else {
                    "code".into()
                },
            }
        })
        .collect();

    Ok(GraphData { nodes, edges })
}

// ---- Remote (SSH) graphs: the same engine over a streamed set of POSIX files ----
//
// For a remote workspace the files live on the host, so we can't walk the local
// disk. The SSH layer streams `(rel, content)` pairs (one `find | cat` over an
// exec channel) and we run the identical link/import extraction here — but on
// plain `/`-separated strings, so resolution is correct regardless of the local
// OS (Windows `PathBuf` would mangle POSIX paths). Node ids are `<root>/<rel>` so
// the UI opens them over SSH like any remote file.

/// One file streamed from a remote host: its path relative to the workspace root
/// (POSIX, no leading `./`) and its text content.
pub struct RawFile {
    pub rel: String,
    pub content: String,
}

fn posix_normalize(p: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for comp in p.split('/') {
        match comp {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out.join("/")
}

fn posix_parent(p: &str) -> &str {
    match p.rfind('/') {
        Some(i) => &p[..i],
        None => "",
    }
}

fn posix_basename(p: &str) -> &str {
    match p.rfind('/') {
        Some(i) => &p[i + 1..],
        None => p,
    }
}

fn posix_stem(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    }
}

fn posix_ext(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 => &name[i + 1..],
        _ => "",
    }
}

/// Replaces (or adds) the extension on a POSIX path's final component.
fn posix_with_ext(p: &str, ext: &str) -> String {
    let parent = posix_parent(p);
    let stem = posix_stem(posix_basename(p));
    if parent.is_empty() {
        format!("{stem}.{ext}")
    } else {
        format!("{parent}/{stem}.{ext}")
    }
}

fn is_markdown_ext(ext: &str) -> bool {
    matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdx")
}

fn is_code_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "rs"
    )
}

/// POSIX twin of {@link resolve_js}, matching against the set of relative paths.
fn resolve_js_posix(from_rel: &str, spec: &str, set: &HashSet<String>) -> Option<String> {
    if !(spec.starts_with('.') || spec.starts_with('/')) {
        return None;
    }
    let base = posix_normalize(&format!("{}/{}", posix_parent(from_rel), spec));
    if set.contains(&base) {
        return Some(base);
    }
    for ext in JS_EXTS {
        let cand = posix_with_ext(&base, ext);
        if set.contains(&cand) {
            return Some(cand);
        }
    }
    for ext in JS_EXTS {
        let cand = posix_normalize(&format!("{base}/index.{ext}"));
        if set.contains(&cand) {
            return Some(cand);
        }
    }
    None
}

/// POSIX twin of {@link resolve_md}.
fn resolve_md_posix(from_rel: &str, target: &str, set: &HashSet<String>) -> Option<String> {
    let clean = target.split(['#', '?']).next().unwrap_or(target).trim();
    if clean.is_empty()
        || clean.starts_with("http://")
        || clean.starts_with("https://")
        || clean.starts_with("mailto:")
    {
        return None;
    }
    let base = posix_normalize(&format!("{}/{}", posix_parent(from_rel), clean));
    if set.contains(&base) {
        return Some(base);
    }
    let md = posix_with_ext(&base, "md");
    if set.contains(&md) {
        return Some(md);
    }
    None
}

/// POSIX twin of {@link resolve_rust_mod}.
fn resolve_rust_mod_posix(from_rel: &str, name: &str, set: &HashSet<String>) -> Option<String> {
    let parent = posix_parent(from_rel);
    let stem = posix_stem(posix_basename(from_rel));
    let dir = if matches!(stem, "mod" | "lib" | "main") {
        parent.to_string()
    } else if parent.is_empty() {
        stem.to_string()
    } else {
        format!("{parent}/{stem}")
    };
    let direct = posix_normalize(&format!("{dir}/{name}.rs"));
    if set.contains(&direct) {
        return Some(direct);
    }
    let nested = posix_normalize(&format!("{dir}/{name}/mod.rs"));
    if set.contains(&nested) {
        return Some(nested);
    }
    None
}

fn push_edge_str(
    source: &str,
    target: &str,
    kind: &str,
    edges: &mut Vec<GraphEdge>,
    seen: &mut HashSet<(String, String, String)>,
) {
    if source == target {
        return;
    }
    let key = (source.to_string(), target.to_string(), kind.to_string());
    if seen.insert(key) {
        edges.push(GraphEdge {
            source: source.to_string(),
            target: target.to_string(),
            kind: kind.to_string(),
        });
    }
}

/// Builds the context graph from an in-memory set of remote files. `root` is the
/// absolute remote (POSIX) workspace path; `files` carry paths relative to it.
pub fn build_context_graph_from_files(root: &str, files: Vec<RawFile>) -> GraphData {
    let root = root.trim_end_matches('/');
    // Keep only the file kinds we graph, normalized, capped.
    let mut rels: Vec<String> = Vec::new();
    let mut content_by_rel: HashMap<String, String> = HashMap::new();
    for f in files {
        let rel = posix_normalize(&f.rel);
        if rel.is_empty() {
            continue;
        }
        let ext = posix_ext(posix_basename(&rel));
        if !(is_markdown_ext(ext) || is_code_ext(ext)) {
            continue;
        }
        if !content_by_rel.contains_key(&rel) {
            if rels.len() >= MAX_NODES {
                break;
            }
            rels.push(rel.clone());
        }
        content_by_rel.insert(rel, f.content);
    }

    let set: HashSet<String> = rels.iter().cloned().collect();
    // Wikilinks resolve by markdown file stem (case-insensitive).
    let mut by_stem: HashMap<String, String> = HashMap::new();
    for rel in &rels {
        let name = posix_basename(rel);
        if is_markdown_ext(posix_ext(name)) {
            by_stem
                .entry(posix_stem(name).to_lowercase())
                .or_insert_with(|| rel.clone());
        }
    }

    let pat = patterns();
    let id_of = |rel: &str| format!("{root}/{rel}");
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    let mut edges: Vec<GraphEdge> = Vec::new();

    for rel in &rels {
        let content = match content_by_rel.get(rel) {
            Some(c) => c,
            None => continue,
        };
        if content.len() as u64 > MAX_PARSE_SIZE {
            continue;
        }
        let ext = posix_ext(posix_basename(rel));
        let src = id_of(rel);
        if is_markdown_ext(ext) {
            for cap in pat.md_link.captures_iter(content) {
                if let Some(t) = resolve_md_posix(rel, &cap[1], &set) {
                    push_edge_str(&src, &id_of(&t), "link", &mut edges, &mut seen);
                }
            }
            for cap in pat.wikilink.captures_iter(content) {
                if let Some(t) = by_stem.get(&cap[1].trim().to_lowercase()) {
                    push_edge_str(&src, &id_of(t), "wikilink", &mut edges, &mut seen);
                }
            }
        } else if ext.eq_ignore_ascii_case("rs") {
            for cap in pat.rs_mod.captures_iter(content) {
                if let Some(t) = resolve_rust_mod_posix(rel, &cap[1], &set) {
                    push_edge_str(&src, &id_of(&t), "import", &mut edges, &mut seen);
                }
            }
        } else {
            for re in [&pat.js_import, &pat.js_from, &pat.js_call] {
                for cap in re.captures_iter(content) {
                    if let Some(t) = resolve_js_posix(rel, &cap[1], &set) {
                        push_edge_str(&src, &id_of(&t), "import", &mut edges, &mut seen);
                    }
                }
            }
        }
    }

    let nodes: Vec<GraphNode> = rels
        .iter()
        .map(|rel| {
            let name = posix_basename(rel).to_string();
            let kind = if is_markdown_ext(posix_ext(&name)) {
                "markdown"
            } else {
                "code"
            };
            GraphNode {
                id: id_of(rel),
                name,
                rel: rel.clone(),
                kind: kind.into(),
            }
        })
        .collect();

    GraphData { nodes, edges }
}

// ---- Phase 2: richer knowledge index (the base the MCP + RAG consume) ----

/// A resolved outgoing link with the source line + its text, so consumers (the
/// backlinks panel, the MCP tools) can show context — Obsidian's "linked mention".
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexLink {
    /// Absolute path of the linked file (a node in the index).
    pub target: String,
    /// `"link"` | `"wikilink"` | `"import"`.
    pub relation: String,
    /// 1-based line where the link appears in the source file.
    pub line: usize,
    /// The trimmed source line (a short context snippet, capped).
    pub snippet: String,
}

/// A markdown heading (outline entry).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Heading {
    pub level: usize,
    pub text: String,
    pub line: usize,
}

/// One file in the knowledge index, with everything the agents need to reason
/// about it: where it points (with context), its tags and its outline.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFile {
    pub path: String,
    pub name: String,
    pub rel: String,
    pub kind: String,
    pub outgoing: Vec<IndexLink>,
    pub tags: Vec<String>,
    pub headings: Vec<Heading>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeIndex {
    pub files: Vec<KnowledgeFile>,
}

/// Caps a context snippet so the payload stays small.
fn snippet_of(line: &str) -> String {
    let t = line.trim();
    if t.chars().count() > 200 {
        t.chars().take(200).collect::<String>() + "…"
    } else {
        t.to_string()
    }
}

/// Builds the richer knowledge index for `root`. Same walk + resolution as the
/// graph, but line-based so each link carries its line number + a snippet, plus
/// markdown tags and the heading outline.
#[tauri::command]
pub fn build_knowledge_index(root: String) -> Result<KnowledgeIndex, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("não é um diretório: {root}"));
    }
    let root_norm = normalize(root_path);

    let mut files: Vec<PathBuf> = Vec::new();
    collect(&root_norm, &mut files);
    let set: HashSet<PathBuf> = files.iter().cloned().collect();
    let mut by_stem: HashMap<String, PathBuf> = HashMap::new();
    for f in &files {
        if is_markdown(f) {
            if let Some(stem) = f.file_stem().and_then(|s| s.to_str()) {
                by_stem
                    .entry(stem.to_lowercase())
                    .or_insert_with(|| f.clone());
            }
        }
    }

    let pat = patterns();
    let mut out: Vec<KnowledgeFile> = Vec::with_capacity(files.len());

    for f in &files {
        let kind = if is_markdown(f) { "markdown" } else { "code" };
        let rel = f
            .strip_prefix(&root_norm)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| f.to_string_lossy().to_string());
        let mut outgoing: Vec<IndexLink> = Vec::new();
        let mut tags: Vec<String> = Vec::new();
        let mut headings: Vec<Heading> = Vec::new();

        let too_big = fs::metadata(f)
            .map(|m| m.len() > MAX_PARSE_SIZE)
            .unwrap_or(true);
        let content = if too_big {
            String::new()
        } else {
            fs::read_to_string(f).unwrap_or_default()
        };
        let mut seen_tgt: HashSet<(String, String)> = HashSet::new();
        let mut seen_tag: HashSet<String> = HashSet::new();
        let is_md = kind == "markdown";
        let is_rs = f
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("rs"))
            .unwrap_or(false);

        for (i, raw_line) in content.lines().enumerate() {
            let line_no = i + 1;
            let add = |target: PathBuf,
                       relation: &str,
                       outgoing: &mut Vec<IndexLink>,
                       seen: &mut HashSet<(String, String)>| {
                if target == *f {
                    return;
                }
                let tp = target.to_string_lossy().to_string();
                if seen.insert((tp.clone(), relation.to_string())) {
                    outgoing.push(IndexLink {
                        target: tp,
                        relation: relation.to_string(),
                        line: line_no,
                        snippet: snippet_of(raw_line),
                    });
                }
            };

            if is_md {
                for cap in pat.heading.captures_iter(raw_line) {
                    headings.push(Heading {
                        level: cap[1].len(),
                        text: cap[2].trim().to_string(),
                        line: line_no,
                    });
                }
                for cap in pat.tag.captures_iter(raw_line) {
                    let t = cap[1].to_string();
                    if seen_tag.insert(t.clone()) {
                        tags.push(t);
                    }
                }
                for cap in pat.md_link.captures_iter(raw_line) {
                    if let Some(t) = resolve_md(f, &cap[1], &set) {
                        add(t, "link", &mut outgoing, &mut seen_tgt);
                    }
                }
                for cap in pat.wikilink.captures_iter(raw_line) {
                    if let Some(t) = by_stem.get(&cap[1].trim().to_lowercase()) {
                        add(t.clone(), "wikilink", &mut outgoing, &mut seen_tgt);
                    }
                }
            } else if is_rs {
                for cap in pat.rs_mod.captures_iter(raw_line) {
                    if let Some(t) = resolve_rust_mod(f, &cap[1], &set) {
                        add(t, "import", &mut outgoing, &mut seen_tgt);
                    }
                }
            } else {
                for re in [&pat.js_import, &pat.js_from, &pat.js_call] {
                    for cap in re.captures_iter(raw_line) {
                        if let Some(t) = resolve_js(f, &cap[1], &set) {
                            add(t, "import", &mut outgoing, &mut seen_tgt);
                        }
                    }
                }
            }
        }

        out.push(KnowledgeFile {
            path: f.to_string_lossy().to_string(),
            name: f
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            rel,
            kind: kind.to_string(),
            outgoing,
            tags,
            headings,
        });
    }

    Ok(KnowledgeIndex { files: out })
}

/// Builds the richer knowledge index from a streamed remote file set — the SSH
/// twin of {@link build_knowledge_index}, on POSIX paths. Backs the backlinks
/// panel (and, later, the RAG bundle) for remote workspaces.
pub fn build_knowledge_index_from_files(root: &str, files: Vec<RawFile>) -> KnowledgeIndex {
    let root = root.trim_end_matches('/');
    let mut rels: Vec<String> = Vec::new();
    let mut content_by_rel: HashMap<String, String> = HashMap::new();
    for f in files {
        let rel = posix_normalize(&f.rel);
        if rel.is_empty() {
            continue;
        }
        let ext = posix_ext(posix_basename(&rel));
        if !(is_markdown_ext(ext) || is_code_ext(ext)) {
            continue;
        }
        if !content_by_rel.contains_key(&rel) {
            if rels.len() >= MAX_NODES {
                break;
            }
            rels.push(rel.clone());
        }
        content_by_rel.insert(rel, f.content);
    }

    let set: HashSet<String> = rels.iter().cloned().collect();
    let mut by_stem: HashMap<String, String> = HashMap::new();
    for rel in &rels {
        let name = posix_basename(rel);
        if is_markdown_ext(posix_ext(name)) {
            by_stem
                .entry(posix_stem(name).to_lowercase())
                .or_insert_with(|| rel.clone());
        }
    }

    let pat = patterns();
    let id_of = |rel: &str| format!("{root}/{rel}");
    let mut out: Vec<KnowledgeFile> = Vec::with_capacity(rels.len());

    for rel in &rels {
        let name = posix_basename(rel).to_string();
        let ext = posix_ext(&name);
        let is_md = is_markdown_ext(ext);
        let is_rs = ext.eq_ignore_ascii_case("rs");
        let self_id = id_of(rel);
        let content = content_by_rel.get(rel).cloned().unwrap_or_default();
        let content = if content.len() as u64 > MAX_PARSE_SIZE {
            String::new()
        } else {
            content
        };

        let mut outgoing: Vec<IndexLink> = Vec::new();
        let mut tags: Vec<String> = Vec::new();
        let mut headings: Vec<Heading> = Vec::new();
        let mut seen_tgt: HashSet<(String, String)> = HashSet::new();
        let mut seen_tag: HashSet<String> = HashSet::new();

        for (i, raw_line) in content.lines().enumerate() {
            let line_no = i + 1;
            let mut add = |target_rel: &str, relation: &str| {
                let tp = id_of(target_rel);
                if tp == self_id {
                    return;
                }
                if seen_tgt.insert((tp.clone(), relation.to_string())) {
                    outgoing.push(IndexLink {
                        target: tp,
                        relation: relation.to_string(),
                        line: line_no,
                        snippet: snippet_of(raw_line),
                    });
                }
            };

            if is_md {
                for cap in pat.heading.captures_iter(raw_line) {
                    headings.push(Heading {
                        level: cap[1].len(),
                        text: cap[2].trim().to_string(),
                        line: line_no,
                    });
                }
                for cap in pat.tag.captures_iter(raw_line) {
                    let t = cap[1].to_string();
                    if seen_tag.insert(t.clone()) {
                        tags.push(t);
                    }
                }
                for cap in pat.md_link.captures_iter(raw_line) {
                    if let Some(t) = resolve_md_posix(rel, &cap[1], &set) {
                        add(&t, "link");
                    }
                }
                for cap in pat.wikilink.captures_iter(raw_line) {
                    if let Some(t) = by_stem.get(&cap[1].trim().to_lowercase()) {
                        add(t, "wikilink");
                    }
                }
            } else if is_rs {
                for cap in pat.rs_mod.captures_iter(raw_line) {
                    if let Some(t) = resolve_rust_mod_posix(rel, &cap[1], &set) {
                        add(&t, "import");
                    }
                }
            } else {
                for re in [&pat.js_import, &pat.js_from, &pat.js_call] {
                    for cap in re.captures_iter(raw_line) {
                        if let Some(t) = resolve_js_posix(rel, &cap[1], &set) {
                            add(&t, "import");
                        }
                    }
                }
            }
        }

        out.push(KnowledgeFile {
            path: self_id,
            name,
            rel: rel.clone(),
            kind: if is_md { "markdown" } else { "code" }.to_string(),
            outgoing,
            tags,
            headings,
        });
    }

    KnowledgeIndex { files: out }
}

// ---- Phase 4: context bundle (RAG-lite) — the seed file + its neighbours ----

/// Finds a file in the index by absolute path, relative path, or path suffix
/// (so callers can pass `src/a.ts`, `/abs/src/a.ts`, or `a.ts`).
pub(crate) fn find_file<'a>(idx: &'a KnowledgeIndex, q: &str) -> Option<&'a KnowledgeFile> {
    let qn = q.replace('\\', "/");
    idx.files
        .iter()
        .find(|f| f.path == q || f.rel == qn)
        .or_else(|| {
            idx.files
                .iter()
                .find(|f| f.path.replace('\\', "/").ends_with(&qn))
        })
}

/// A fenced-code language hint for a file (drives the bundle's markdown fences).
fn lang_of(f: &KnowledgeFile) -> &'static str {
    match Path::new(&f.path).extension().and_then(|e| e.to_str()) {
        Some("ts") => "ts",
        Some("tsx") => "tsx",
        Some("js") | Some("mjs") | Some("cjs") => "js",
        Some("jsx") => "jsx",
        Some("rs") => "rust",
        Some("md") | Some("markdown") | Some("mdx") => "markdown",
        _ => "",
    }
}

/// BFS over the (undirected) link graph from `seed`, returning paths in visit
/// order (seed first) up to `depth` hops.
fn bfs_neighbours(index: &KnowledgeIndex, seed: &str, depth: usize) -> Vec<String> {
    use std::collections::VecDeque;
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for f in &index.files {
        for l in &f.outgoing {
            adj.entry(f.path.as_str())
                .or_default()
                .push(l.target.as_str());
            adj.entry(l.target.as_str())
                .or_default()
                .push(f.path.as_str());
        }
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut order: Vec<String> = Vec::new();
    let mut q: VecDeque<(&str, usize)> = VecDeque::new();
    seen.insert(seed);
    q.push_back((seed, 0));
    while let Some((p, d)) = q.pop_front() {
        order.push(p.to_string());
        if d >= depth {
            continue;
        }
        if let Some(ns) = adj.get(p) {
            for &n in ns {
                if seen.insert(n) {
                    q.push_back((n, d + 1));
                }
            }
        }
    }
    order
}

/// Truncates `s` to at most `max` chars (UTF-8 safe), flagging the cut.
fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        s.chars().take(max).collect::<String>() + "\n…(truncado)"
    } else {
        s.to_string()
    }
}

/// Assembles a markdown "context bundle": the seed file + its graph neighbours
/// (up to `depth` hops), each as a fenced section, capped to `max_chars` total.
pub(crate) fn context_bundle_from(
    index: &KnowledgeIndex,
    seed_q: &str,
    depth: usize,
    max_chars: usize,
    read: &dyn Fn(&str) -> String,
) -> Result<String, String> {
    let seed = find_file(index, seed_q).ok_or("arquivo não encontrado no índice")?;
    let order = bfs_neighbours(index, &seed.path, depth.min(3));
    let by_path: HashMap<&str, &KnowledgeFile> =
        index.files.iter().map(|f| (f.path.as_str(), f)).collect();

    let rels: Vec<String> = order
        .iter()
        .filter_map(|p| by_path.get(p.as_str()).map(|f| f.rel.clone()))
        .collect();
    let mut out = format!(
        "# Pacote de contexto: {}\nProfundidade {depth} · {} arquivo(s): {}\n\n",
        seed.rel,
        rels.len(),
        rels.join(", ")
    );
    let per_file = 8000usize;
    for p in &order {
        if out.chars().count() >= max_chars {
            out.push_str("\n…(pacote truncado no limite de tamanho)\n");
            break;
        }
        let f = match by_path.get(p.as_str()) {
            Some(f) => f,
            None => continue,
        };
        let content = read(p);
        out.push_str(&format!(
            "## {}\n```{}\n{}\n```\n\n",
            f.rel,
            lang_of(f),
            cap_chars(&content, per_file)
        ));
    }
    Ok(out)
}

/// Builds a context bundle for `path` (the seed) — the file plus its link/import
/// neighbours up to `depth` hops — as one markdown blob to feed an agent.
#[tauri::command]
pub fn build_context_bundle(root: String, path: String, depth: usize) -> Result<String, String> {
    let index = build_knowledge_index(root)?;
    context_bundle_from(&index, &path, depth, 60_000, &|p| {
        std::fs::read_to_string(p).unwrap_or_default()
    })
}

/// Remote (SSH) twin of `build_context_bundle`: builds the index + bundle from a
/// streamed file set, reading neighbour contents from memory (no disk).
pub fn context_bundle_from_files(
    root: &str,
    files: Vec<RawFile>,
    seed_q: &str,
    depth: usize,
    max_chars: usize,
) -> Result<String, String> {
    let root = root.trim_end_matches('/');
    // Content keyed by absolute id (`<root>/<rel>`), the same id the index uses.
    let mut content_by_id: HashMap<String, String> = HashMap::new();
    let mut for_index: Vec<RawFile> = Vec::with_capacity(files.len());
    for f in files {
        let rel = posix_normalize(&f.rel);
        if rel.is_empty() {
            continue;
        }
        content_by_id.insert(format!("{root}/{rel}"), f.content.clone());
        for_index.push(RawFile {
            rel,
            content: f.content,
        });
    }
    let index = build_knowledge_index_from_files(root, for_index);
    context_bundle_from(&index, seed_q, depth, max_chars, &|p| {
        content_by_id.get(p).cloned().unwrap_or_default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_js_tries_extensions_and_index() {
        let root = Path::new("/proj");
        let from = root.join("src").join("a.ts");
        let b = normalize(&root.join("src").join("b.ts"));
        let idx = normalize(&root.join("src").join("util").join("index.tsx"));
        let set: HashSet<PathBuf> = [b.clone(), idx.clone()].into_iter().collect();
        // `./b` → ./b.ts ; `./util` → ./util/index.tsx ; bare → None.
        assert_eq!(resolve_js(&from, "./b", &set), Some(b));
        assert_eq!(resolve_js(&from, "./util", &set), Some(idx));
        assert_eq!(resolve_js(&from, "react", &set), None);
        assert_eq!(resolve_js(&from, "./missing", &set), None);
    }

    #[test]
    fn rust_mod_resolves_sibling_and_nested() {
        let root = Path::new("/proj").join("src");
        // From lib.rs, `mod foo;` → src/foo.rs.
        let lib = root.join("lib.rs");
        let foo = normalize(&root.join("foo.rs"));
        let set: HashSet<PathBuf> = [foo.clone()].into_iter().collect();
        assert_eq!(resolve_rust_mod(&lib, "foo", &set), Some(foo));
        // From a.rs, `mod bar;` → src/a/bar.rs (2018 edition).
        let a = root.join("a.rs");
        let bar = normalize(&root.join("a").join("bar.rs"));
        let set2: HashSet<PathBuf> = [bar.clone()].into_iter().collect();
        assert_eq!(resolve_rust_mod(&a, "bar", &set2), Some(bar));
    }

    #[test]
    fn tag_matches_inline_not_headings() {
        let p = patterns();
        assert!(p.tag.is_match("veja #fluent aqui"));
        assert_eq!(&p.tag.captures("a #tag-1/x b").unwrap()[1], "tag-1/x");
        assert!(!p.tag.is_match("# Heading"));
        assert!(!p.tag.is_match("## Sub heading"));
    }

    #[test]
    fn remote_graph_resolves_imports_and_links() {
        let files = vec![
            RawFile {
                rel: "src/a.ts".into(),
                content: "import { x } from './b';\n".into(),
            },
            RawFile {
                rel: "src/b.ts".into(),
                content: "export const x = 1;\n".into(),
            },
            RawFile {
                rel: "docs/index.md".into(),
                content: "See [other](./other.md) and [[note]] and react import none.\n".into(),
            },
            RawFile {
                rel: "docs/other.md".into(),
                content: "# Other\n".into(),
            },
            RawFile {
                rel: "docs/note.md".into(),
                content: "# Note\n".into(),
            },
            RawFile {
                rel: "src/main.rs".into(),
                content: "mod foo;\n".into(),
            },
            RawFile {
                rel: "src/foo.rs".into(),
                content: "pub fn f() {}\n".into(),
            },
        ];
        // Trailing slash on root must not double up in node ids.
        let g = build_context_graph_from_files("/home/proj/", files);

        assert_eq!(g.nodes.len(), 7);
        assert!(g
            .nodes
            .iter()
            .any(|n| n.id == "/home/proj/src/a.ts" && n.rel == "src/a.ts" && n.kind == "code"));
        assert!(g
            .nodes
            .iter()
            .any(|n| n.id == "/home/proj/docs/index.md" && n.kind == "markdown"));

        let has = |s: &str, t: &str, k: &str| {
            g.edges
                .iter()
                .any(|e| e.source == s && e.target == t && e.kind == k)
        };
        assert!(has("/home/proj/src/a.ts", "/home/proj/src/b.ts", "import"));
        assert!(has(
            "/home/proj/docs/index.md",
            "/home/proj/docs/other.md",
            "link"
        ));
        assert!(has(
            "/home/proj/docs/index.md",
            "/home/proj/docs/note.md",
            "wikilink"
        ));
        assert!(has(
            "/home/proj/src/main.rs",
            "/home/proj/src/foo.rs",
            "import"
        ));
        // Bare package specifiers never produce an edge.
        assert!(!g.edges.iter().any(|e| e.target.contains("react")));
    }

    #[test]
    fn heading_captures_level_and_text() {
        let p = patterns();
        let c = p.heading.captures("### Título aqui ###").unwrap();
        assert_eq!(c[1].len(), 3);
        assert_eq!(&c[2], "Título aqui");
        assert!(p.heading.captures("not a heading").is_none());
    }
}
