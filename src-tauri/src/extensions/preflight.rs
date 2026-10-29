//! Pré-avaliação da loja: veredito ANTES de instalar.
//!
//! ```text
//! extensions_preflight(fonte, ns, nome, versão?, includeCode)
//!   1. metadados (versão + plataforma)                → chave do cache
//!   2. cache <app_data>/extensions/.preflight/<ns>.<nome>@<versão>-<plataforma>.json
//!      (TTL 30 dias; SCANNER_VERSION diferente = refaz) — guarda a VARREDURA
//!      e o manifesto traduzido, nunca o código
//!   3. manifesto (+ cadeia NLS)                        → fase 1 (rápida)
//!   4. includeCode: bundle `main` pelos arquivos do pacote do Open VSX,
//!      seguindo `require("./…")` (profundidade ≤ 8, ≤ 40 arquivos, ≤ 8 MB por
//!      arquivo, ≤ 24 MB no total), varrido EM MEMÓRIA (scan::scan_sources)
//! ```
//!
//! Segurança: rede só pelo `Registry` (HTTPS, allowlist inclusive nos
//! redirecionamentos, tetos), caminhos validados como no VSIX, nada é
//! executado nem gravado fora de `.preflight/` (só JSON com o resultado). O
//! veredito daqui é PRÉVIA (informativo): o portão continua sendo gravado só a
//! partir dos arquivos instalados, com o hash conferido.

use std::collections::{BTreeSet, VecDeque};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::openvsx::{FetchError, Registry};
use super::scan::{self, ApiScan, SCANNER_VERSION};
use super::{store, vsix};

pub const PREFLIGHT_DIR: &str = ".preflight";
pub const CACHE_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;
pub const CACHE_MAX_ENTRIES: usize = 500;
pub const MAX_FILE_BYTES: usize = 8 << 20;
pub const MAX_TOTAL_BYTES: usize = 24 << 20;
pub const MAX_FILES: usize = 40;
pub const MAX_DEPTH: usize = 8;
const MANIFEST_CAP: usize = 4 << 20;

/// Estado da análise do código.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CodeStatus {
    /// Só a fase 1 (manifesto) foi pedida.
    NotRequested,
    /// Sem `main`: nada a varrer (declarativa).
    NoMain,
    /// Varrido (a varredura pode estar `truncated`).
    Scanned,
    /// O `main` passa do teto de download da prévia.
    TooLarge,
    /// A fonte não publica os arquivos do pacote, ou falhou.
    Unavailable,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub scanner_version: u32,
    pub id: String,
    pub version: String,
    pub target_platform: String,
    pub manifest: Option<Value>,
    pub code: CodeStatus,
    pub api_scan: Option<ApiScan>,
    pub code_error: Option<String>,
    /// O que ficou fora da prévia (varredura `truncated`).
    #[serde(default)]
    pub code_gaps: Vec<String>,
    pub saved_at: u64,
    /// Veio do cache em disco.
    #[serde(default)]
    pub cached: bool,
}

/// Nome do arquivo de cache (partes já validadas: `[a-z0-9-_.]`).
pub fn cache_file(dir: &Path, ns: &str, name: &str, version: &str, tp: &str) -> Option<PathBuf> {
    let ok = |s: &str| !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.+".contains(&b)) && !s.contains("..");
    let (ns, name, version, tp) = (ns.to_lowercase(), name.to_lowercase(), version.to_lowercase(), tp.to_lowercase());
    (ok(&ns) && ok(&name) && ok(&version) && ok(&tp)).then(|| dir.join(PREFLIGHT_DIR).join(format!("{ns}.{name}@{version}-{tp}.json")))
}

pub fn read_cache(file: &Path, now: u64, need_code: bool) -> Option<Preflight> {
    let m = std::fs::metadata(file).ok()?;
    if m.len() > 8 << 20 {
        return None;
    }
    let mut p: Preflight = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    if p.scanner_version != SCANNER_VERSION || now.saturating_sub(p.saved_at) > CACHE_TTL_MS {
        return None;
    }
    if need_code && p.code == CodeStatus::NotRequested {
        return None;
    }
    // Falha de rede não fica no cache como resposta definitiva.
    if need_code && p.code == CodeStatus::Unavailable {
        return None;
    }
    p.cached = true;
    Some(p)
}

/// Grava (atômico) e poda o cache para as `CACHE_MAX_ENTRIES` mais recentes.
pub fn write_cache(file: &Path, p: &Preflight) -> Result<(), String> {
    let dir = file.parent().ok_or("cache sem pasta")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, serde_json::to_vec(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    prune(dir, CACHE_MAX_ENTRIES);
    Ok(())
}

fn prune(dir: &Path, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort();
    for (_, p) in files.iter().take(files.len() - keep) {
        let _ = std::fs::remove_file(p);
    }
}

// ------------------------------------------------------------ código remoto

/// Módulos embutidos do Node (require sem caminho que NÃO deixa a varredura incompleta).
const NODE_BUILTINS: [&str; 40] = [
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs",
    "fs/promises", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
    "stream", "string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
];

fn is_builtin_module(spec: &str) -> bool {
    let s = spec.strip_prefix("node:").unwrap_or(spec);
    s == "vscode" || NODE_BUILTINS.contains(&s) || NODE_BUILTINS.iter().any(|b| s.starts_with(&format!("{b}/")))
}

/// Normaliza `dir/./x/../y` (sem sair da raiz). None = escapa da extensão.
fn join_rel(base_dir: &str, spec: &str) -> Option<String> {
    let mut parts: Vec<&str> = if base_dir.is_empty() { Vec::new() } else { base_dir.split('/').collect() };
    for seg in spec.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    let out = parts.join("/");
    vsix::safe_relative(&out).ok().map(|_| out)
}

fn candidates(rel: &str) -> Vec<String> {
    if rel.ends_with(".js") || rel.ends_with(".cjs") {
        vec![rel.to_string()]
    } else {
        vec![format!("{rel}.js"), format!("{rel}/index.js"), rel.to_string()]
    }
}

/// Resultado da coleta do código (para a varredura em memória).
pub struct Collected {
    pub files: Vec<(String, Vec<u8>)>,
    pub status: CodeStatus,
    /// Ficou código de fora (tetos, profundidade, módulos de `node_modules`).
    pub incomplete: bool,
    /// O que ficou de fora (para o motivo na UI).
    pub gaps: Vec<String>,
    pub error: Option<String>,
}

/// Baixa o `main` e os `require("./…")` relativos. `fetch(caminho)` busca um
/// arquivo do pacote (abstraído para os testes).
pub async fn collect<F, Fut>(main: &str, mut fetch: F) -> Collected
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u8>, FetchError>>,
{
    let req = regex::Regex::new(r#"\brequire\(\s*["']([^"'\s]{1,300})["']\s*\)"#).unwrap();
    let Some(main_rel) = join_rel("", main.trim_start_matches("./")) else {
        return Collected { files: Vec::new(), status: CodeStatus::Unavailable, incomplete: true, gaps: Vec::new(), error: Some("`main` com caminho inválido".into()) };
    };
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue: VecDeque<(String, usize)> = VecDeque::from([(main_rel, 0)]);
    let mut total = 0usize;
    let mut incomplete = false;
    let mut gaps: Vec<String> = Vec::new();
    let mut first = true;
    while let Some((rel, depth)) = queue.pop_front() {
        if !seen.insert(rel.clone()) {
            continue;
        }
        if files.len() >= MAX_FILES {
            incomplete = true;
            gaps.push(format!("mais de {MAX_FILES} arquivos"));
            break;
        }
        let mut got: Option<(String, Vec<u8>)> = None;
        let mut too_large = false;
        let mut last_err: Option<String> = None;
        for c in candidates(&rel) {
            match fetch(c.clone()).await {
                Ok(b) => {
                    got = Some((c, b));
                    break;
                }
                Err(FetchError::NotFound) => {}
                Err(FetchError::Other(e)) => {
                    if e.contains("grande demais") {
                        too_large = true;
                        break;
                    }
                    last_err = Some(e);
                    break;
                }
            }
        }
        let Some((path, bytes)) = got else {
            if first {
                let status = if too_large { CodeStatus::TooLarge } else { CodeStatus::Unavailable };
                let error = if too_large { Some(format!("o arquivo principal passa de {} MB", MAX_FILE_BYTES >> 20)) } else { last_err.or(Some("arquivo principal não encontrado no catálogo".into())) };
                return Collected { files, status, incomplete: true, gaps, error };
            }
            incomplete = true;
            gaps.push(format!("{rel}: não encontrado no catálogo"));
            continue;
        };
        first = false;
        if total + bytes.len() > MAX_TOTAL_BYTES {
            incomplete = true;
            gaps.push(format!("mais de {} MB de código", MAX_TOTAL_BYTES >> 20));
            break;
        }
        total += bytes.len();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let dir = path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
        for c in req.captures_iter(&text) {
            let spec = &c[1];
            if spec.starts_with("./") || spec.starts_with("../") {
                if depth >= MAX_DEPTH {
                    incomplete = true;
                    gaps.push(format!("{spec}: além da profundidade {MAX_DEPTH}"));
                    continue;
                }
                match join_rel(&dir, spec) {
                    Some(r) => queue.push_back((r, depth + 1)),
                    None => {
                        incomplete = true;
                        gaps.push(format!("{spec}: fora da extensão"));
                    }
                }
            } else if !is_builtin_module(spec) && spec.contains("vscode") {
                // Dependência de node_modules que fala com a API (`vscode-languageclient`,
                // `@vscode/…`): não é baixada aqui → a prévia não afirma nada. As
                // demais (iconv-lite, lodash…) não carregam `vscode`; a instalada
                // é varrida inteira de qualquer forma antes do portão.
                incomplete = true;
                gaps.push(format!("{spec}: dependência de node_modules não baixada"));
            }
        }
        files.push((path, bytes));
    }
    gaps.truncate(8);
    Collected { files, status: CodeStatus::Scanned, incomplete, gaps, error: None }
}

/// Varredura dos arquivos coletados (o `main` primeiro).
pub fn scan_collected(c: &Collected) -> Option<ApiScan> {
    if c.status != CodeStatus::Scanned {
        return None;
    }
    let file = c.files.first().map(|(p, _)| p.clone());
    Some(scan::scan_sources(c.files.iter().map(|(p, b)| (p.as_str(), b.as_slice())), file, c.incomplete))
}

/// Pré-avaliação completa (rede + cache). `dir` = pasta gerenciada.
pub async fn preflight(dir: &Path, reg: &Registry, ns: &str, name: &str, version: Option<&str>, include_code: bool) -> Result<Preflight, String> {
    vsix::validate_id_part(ns)?;
    vsix::validate_id_part(name)?;
    let platform = store::host_platform();
    let meta = match version {
        Some(v) => reg.metadata(ns, name, Some(v), platform).await?,
        None => reg.latest_stable(ns, name, platform, false).await?,
    };
    let ver = meta.get("version").and_then(Value::as_str).ok_or("metadados sem versão")?.to_string();
    let tp = meta.get("targetPlatform").and_then(Value::as_str).unwrap_or("universal").to_string();
    let id = format!("{ns}.{name}").to_lowercase();
    let now = store::now_ms();
    let cache = cache_file(dir, ns, name, &ver, &tp);
    if let Some(c) = cache.as_deref().and_then(|f| read_cache(f, now, include_code)) {
        return Ok(c);
    }
    // Fase 1: manifesto (+ NLS) — os do cache servem se só o código faltar.
    let manifest = match cache.as_deref().and_then(|f| read_cache(f, now, false)).and_then(|c| c.manifest) {
        Some(m) => Some(m),
        None => match meta.get("files").and_then(|f| f.get("manifest")).and_then(Value::as_str) {
            Some(u) => match reg.text(u).await.ok().and_then(|t| (t.len() <= MANIFEST_CAP).then_some(t)).and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                Some(m) => Some(super::localize_remote_manifest(reg, &meta, m).await),
                None => None,
            },
            None => None,
        },
    };
    let main = manifest.as_ref().and_then(|m| m.get("main")).and_then(Value::as_str).map(str::to_string);
    let (code, api_scan, code_error, code_gaps) = match (&main, include_code) {
        (None, _) if manifest.is_some() => (CodeStatus::NoMain, None, None, Vec::new()),
        (None, _) => (CodeStatus::Unavailable, None, Some("manifesto indisponível no catálogo".to_string()), Vec::new()),
        (Some(_), false) => (CodeStatus::NotRequested, None, None, Vec::new()),
        (Some(main), true) => {
            if reg.package_file_base(ns, name, &ver).is_none() {
                (CodeStatus::Unavailable, None, Some("a fonte não publica os arquivos do pacote".to_string()), Vec::new())
            } else {
                let collected = collect(main, |rel| {
                    let (ns, name, ver) = (ns.to_string(), name.to_string(), ver.clone());
                    async move { reg.package_file(&ns, &name, &ver, &rel, MAX_FILE_BYTES).await }
                })
                .await;
                let scan = scan_collected(&collected);
                (collected.status, scan, collected.error, collected.gaps)
            }
        }
    };
    let out = Preflight { scanner_version: SCANNER_VERSION, id, version: ver, target_platform: tp, manifest, code, api_scan, code_error, code_gaps, saved_at: now, cached: false };
    if let Some(f) = &cache {
        let _ = write_cache(f, &out);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::vsix::tests::tmpdir;
    use std::collections::HashMap;

    fn files(list: &[(&str, &str)]) -> HashMap<String, Vec<u8>> {
        list.iter().map(|(k, v)| (k.to_string(), v.as_bytes().to_vec())).collect()
    }

    async fn run(main: &str, fs: &HashMap<String, Vec<u8>>) -> Collected {
        collect(main, |rel| {
            let r = fs.get(&rel).cloned();
            async move {
                match r {
                    Some(b) if b.len() > MAX_FILE_BYTES => Err(FetchError::Other("resposta grande demais".into())),
                    Some(b) => Ok(b),
                    None => Err(FetchError::NotFound),
                }
            }
        })
        .await
    }

    #[tokio::test]
    async fn collects_main_and_relative_requires_in_memory() {
        let fs = files(&[
            ("out/extension.js", r#"const vscode=require("vscode");const u=require("./util");const fs=require("fs");vscode.commands.registerCommand("a",()=>u.x());"#),
            ("out/util.js", r#"const vscode=require('vscode');exports.x=()=>vscode.window.showInformationMessage("oi");require("../escape/../out/util")"#),
        ]);
        let c = run("./out/extension", &fs).await;
        assert_eq!(c.status, CodeStatus::Scanned);
        assert!(!c.incomplete, "só builtins e relativos");
        assert_eq!(c.files.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), vec!["out/extension.js", "out/util.js"]);
        let s = scan_collected(&c).unwrap();
        let paths: Vec<_> = s.paths.iter().map(|(p, _)| p.as_str()).collect();
        assert!(paths.contains(&"commands.registerCommand") && paths.contains(&"window.showInformationMessage"));
        assert!(!s.truncated);
    }

    #[tokio::test]
    async fn incomplete_when_node_modules_or_limits_and_too_large_main() {
        let fs = files(&[("main.js", r#"const lc=require("vscode-languageclient/node");require("../../etc/passwd")"#)]);
        let c = run("main.js", &fs).await;
        assert!(c.incomplete, "dependência de node_modules não baixada → prévia incompleta");
        assert!(scan_collected(&c).unwrap().truncated);
        let big = "x".repeat(MAX_FILE_BYTES + 1);
        let c = run("main.js", &files(&[("main.js", big.as_str())])).await;
        assert_eq!(c.status, CodeStatus::TooLarge);
        assert!(scan_collected(&c).is_none());
        let c = run("nao/existe", &HashMap::new()).await;
        assert_eq!(c.status, CodeStatus::Unavailable);
        let c = run("../fora.js", &HashMap::new()).await;
        assert_eq!(c.status, CodeStatus::Unavailable);
    }

    #[test]
    fn cache_roundtrip_ttl_scanner_version_and_prune() {
        let dir = tmpdir("preflight");
        assert!(cache_file(&dir, "a/b", "x", "1", "universal").is_none());
        assert!(cache_file(&dir, "acme", "x", "..", "universal").is_none());
        let f = cache_file(&dir, "Acme", "Tool", "1.0.0", "linux-x64").unwrap();
        assert!(f.ends_with(".preflight/acme.tool@1.0.0-linux-x64.json"));
        let p = Preflight { scanner_version: SCANNER_VERSION, id: "acme.tool".into(), version: "1.0.0".into(), target_platform: "linux-x64".into(), manifest: Some(serde_json::json!({"main": "a.js"})), code: CodeStatus::NotRequested, api_scan: None, code_error: None, code_gaps: Vec::new(), saved_at: 1_000, cached: false };
        write_cache(&f, &p).unwrap();
        assert!(read_cache(&f, 2_000, false).unwrap().cached);
        assert!(read_cache(&f, 2_000, true).is_none(), "só o manifesto no cache: o código ainda falta");
        assert!(read_cache(&f, 1_000 + CACHE_TTL_MS + 1, false).is_none(), "TTL");
        write_cache(&f, &Preflight { scanner_version: SCANNER_VERSION - 1, ..p.clone() }).unwrap();
        assert!(read_cache(&f, 2_000, false).is_none(), "varredura de outra versão do scanner");
        for i in 0..5 {
            let g = cache_file(&dir, "acme", &format!("t{i}"), "1.0.0", "universal").unwrap();
            std::fs::create_dir_all(g.parent().unwrap()).unwrap();
            std::fs::write(&g, "{}").unwrap();
        }
        prune(&dir.join(PREFLIGHT_DIR), 3);
        assert_eq!(std::fs::read_dir(dir.join(PREFLIGHT_DIR)).unwrap().count(), 3);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Pré-avaliação REAL (rede, só leitura): o veredito sai antes de instalar.
    /// `cargo test --lib real_openvsx_preflight -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_openvsx_preflight() {
        let dir = tmpdir("preflight-real");
        let reg = Registry::new(super::super::openvsx::default_sources().remove(0)).unwrap();
        for (ns, name) in [("usernamehw", "errorlens"), ("mhutchie", "git-graph"), ("eamodio", "gitlens"), ("dracula-theme", "theme-dracula")] {
            let t = std::time::Instant::now();
            let p = preflight(&dir, &reg, ns, name, None, true).await.unwrap();
            let s = p.api_scan.as_ref();
            println!(
                "{} {} {:?} · {} caminho(s), unresolved {}, truncated {} {:?} · {} ms",
                p.id,
                p.version,
                p.code,
                s.map(|s| s.paths.len()).unwrap_or(0),
                s.map(|s| s.unresolved).unwrap_or(0),
                s.map(|s| s.truncated).unwrap_or(false),
                p.code_gaps,
                t.elapsed().as_millis()
            );
            let again = preflight(&dir, &reg, ns, name, None, true).await.unwrap();
            assert!(again.cached, "2ª vez vem do cache");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
