//! Varredura estática do código Node de uma extensão (`vscode.<api>`
//! referenciados) para o classificador de compatibilidade
//! (`src/extensions/compatibility.ts`).
//!
//! Espelho EXATO de `tools/ext-host/discovery/api-scan.js` (o JS serve os
//! scripts headless e a matriz de compatibilidade). Os dois passam pelos
//! MESMOS fixtures com saída dourada (`tools/ext-host/test/fixtures/api-scan/`):
//! mudou um, mude o outro e regenere o `expected.json`.
//!
//! Reconhece: `x = require("vscode")` (com embrulho `__importStar(…)`),
//! desestruturação, `import … from "vscode"`, módulos do webpack
//! (`1398(e){e.exports=require("vscode")}` → `i=r(1398)`) e
//! `require("vscode").a.b`. Só conta como API o que está no universo
//! (`src/extensions/vscode-api-surface.json`, gerado do vscode.d.ts): ruído de
//! minificação e ids de comando em strings ficam em `ignored`. Cada
//! `require("vscode")` que não foi ligado a nada conta em `unresolved` — o
//! classificador trata o código como NÃO analisado (nunca positivo por omissão).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::bytes::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::vsix;

/// Mudou o algoritmo → suba (invalida caches de varredura e da pré-avaliação).
/// Igual a `SCANNER_VERSION` em api-scan.js.
pub const SCANNER_VERSION: u32 = 2;
pub const MAX_SCAN_BYTES: u64 = 64 << 20;
pub const MAX_SCAN_FILE: u64 = 16 << 20;

/// Pastas puladas na varredura (sem código da extensão que fale com `vscode`).
const SKIP_DIRS: [&str; 6] = ["@types", "typescript", ".git", "webview", "webview-ui", "media"];

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiScan {
    pub scanner_version: u32,
    /// Arquivo `main` (relativo à extensão); None = sem `main`.
    pub file: Option<String>,
    /// Arquivos analisados que fazem `require("vscode")`.
    pub files_with_api: usize,
    /// Identificadores ligados ao namespace `vscode` (variáveis + apelidos).
    pub bindings: usize,
    /// `require("vscode")` / `from "vscode"` encontrados.
    pub sites: usize,
    /// Sítios que não foram ligados a nada (bundle com indireção).
    pub unresolved: usize,
    /// Acessos descartados por estarem fora do universo da API.
    pub ignored: usize,
    /// `commands.registerCommand("type", …)`.
    pub type_command: bool,
    pub paths: Vec<(String, u32)>,
    /// Caminhos vistos sendo CHAMADOS (`x.y(`): ausente + chamado = erro certo.
    pub called: Vec<String>,
    /// A varredura parou no teto de bytes (resultado incompleto).
    pub truncated: bool,
    /// Não foi possível ler/analisar (motivo).
    pub error: Option<String>,
}

// ------------------------------------------------------------------ universo

struct Surface {
    namespaces: HashMap<String, HashSet<String>>,
    top: HashSet<String>,
}

fn surface() -> &'static Surface {
    static S: OnceLock<Surface> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../src/extensions/vscode-api-surface.json")).expect("vscode-api-surface.json válido");
        let mut namespaces: HashMap<String, HashSet<String>> = HashMap::new();
        let mut top: HashSet<String> = HashSet::new();
        for src in [&v, &v["proposed"]] {
            if let Some(ns) = src.get("namespaces").and_then(Value::as_object) {
                for (k, members) in ns {
                    let set = namespaces.entry(k.clone()).or_default();
                    for m in members.as_array().into_iter().flatten().filter_map(Value::as_str) {
                        set.insert(m.to_string());
                    }
                }
            }
            for t in src.get("top").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                top.insert(t.to_string());
            }
        }
        Surface { namespaces, top }
    })
}

/// O caminho `a.b` está no universo da API? (namespace + membro, ou topo).
pub fn in_surface(first: &str, second: Option<&str>) -> bool {
    let s = surface();
    match s.namespaces.get(first) {
        Some(members) => second.map(|m| members.contains(m)).unwrap_or(true),
        None => s.top.contains(first),
    }
}

fn is_namespace(name: &str) -> bool {
    surface().namespaces.contains_key(name)
}

// ------------------------------------------------------------------ regex

const ID: &str = r"[A-Za-z_$][\w$]*";
const REQ: &str = r#"require\(\s*["']vscode["']\s*\)"#;

fn rx(p: &str) -> Regex {
    RegexBuilder::new(p).unicode(false).build().expect("regex da varredura")
}

struct Rx {
    req: Regex,
    esm: Regex,
    type_cmd: Regex,
    direct: Regex,
    destruct: Regex,
    inline: Regex,
    star: Regex,
    named: Regex,
    default_import: Regex,
    module_def: Regex,
    module_def_array: Regex,
    part: Regex,
    call_open: Regex,
    call_paren: Regex,
    zero_comma: Regex,
}

fn rxs() -> &'static Rx {
    static R: OnceLock<Rx> = OnceLock::new();
    R.get_or_init(|| {
        let params = format!(r"\(?\s*(?:{ID}(?:\s*,\s*{ID})*)?\s*\)?");
        Rx {
            req: rx(REQ),
            esm: rx(r#"\bimport\s+([^;'"`]{1,2000}?)\s+from\s*["']vscode["']"#),
            type_cmd: rx(r#"registerCommand\(\s*["']type["']"#),
            direct: rx(&format!(r"(?:^|[^\w$.])({ID})\s*=\s*(?:{ID}\()?({REQ})")),
            destruct: rx(&format!(r"\{{([^{{}}]{{1,2000}})\}}\s*=\s*(?:{ID}\()?({REQ})")),
            inline: rx(&format!(r"({REQ})\.({ID})(?:\.({ID}))?")),
            star: rx(&format!(r"^(?:({ID})\s*,\s*)?\*\s*as\s+({ID})$")),
            named: rx(r"\{([^}]*)\}"),
            default_import: rx(&format!(r"^({ID})(?:\s*,|$)")),
            module_def: rx(&format!(
                r#"(?:^|[{{,\s])(\d+|"[^"\n]{{1,200}}"|'[^'\n]{{1,200}}')\s*(?::\s*(?:/\*(?:[^*]|\*[^/])*\*/\s*)*\(?\s*(?:function\s*)?{params}\s*(?:=>\s*)?|\(\s*(?:{ID}(?:\s*,\s*{ID})*)?\s*\)\s*)\{{\s*(?:(?:"use strict"|'use strict');?\s*)?{ID}\.exports\s*=\s*$"#
            )),
            module_def_array: rx(&format!(
                r#"/\*\s*(\d+)\s*\*/\s*(?:/\*+/\s*)*\(?\s*(?:function\s*)?{params}\s*(?:=>\s*)?\{{\s*(?:(?:"use strict"|'use strict');?\s*)?{ID}\.exports\s*=\s*$"#
            )),
            part: rx(&format!(r"^\s*({ID})\s*(?:(?::|\bas\b)\s*({ID}))?\s*(?:=[^,]*)?$")),
            call_open: rx(r"^\s*\("),
            call_paren: rx(r"^\s*\)\s*\("),
            zero_comma: rx(r"\(\s*0\s*,\s*$"),
        }
    })
}

fn esc(s: &str) -> String {
    regex::escape(s)
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// `window, Uri: U, workspace = x` / `commands as c` → [(chave, apelido)].
fn destructured(body: &[u8]) -> Vec<(String, String)> {
    let r = rxs();
    body.split(|&c| c == b',')
        .filter_map(|part| {
            let c = r.part.captures(part)?;
            let k = text(&c[1]);
            let a = c.get(2).map(|m| text(m.as_bytes())).unwrap_or_else(|| k.clone());
            Some((k, a))
        })
        .collect()
}

// ------------------------------------------------------------------ acumulador

#[derive(Default)]
struct Acc {
    files: usize,
    bindings: usize,
    sites: usize,
    unresolved: usize,
    ignored: usize,
    type_command: bool,
    paths: BTreeMap<String, u32>,
    writes: BTreeSet<String>,
    called: BTreeSet<String>,
}

impl Acc {
    fn add_path(&mut self, first: &str, second: Option<&str>, called: bool) {
        if !in_surface(first, second) {
            self.ignored += 1;
            return;
        }
        let key = match second {
            Some(s) if is_namespace(first) => format!("{first}.{s}"),
            _ => first.to_string(),
        };
        *self.paths.entry(key.clone()).or_insert(0) += 1;
        if called {
            self.called.insert(key);
        }
    }
}

/// Mapa com a semântica do `Map` do JS (ordem de inserção; `set` numa chave
/// existente troca o valor sem mudar a posição).
#[derive(Default)]
struct OrderedMap(Vec<(String, String)>);

impl OrderedMap {
    fn set(&mut self, k: String, v: String) {
        match self.0.iter_mut().find(|(a, _)| *a == k) {
            Some(e) => e.1 = v,
            None => self.0.push((k, v)),
        }
    }
    fn len(&self) -> usize {
        self.0.len()
    }
}

/// Próximo caractere útil é `(` → chamada; `(0,x.y)(` (estilo webpack) também.
fn is_call(src: &[u8], start: usize, end: usize) -> bool {
    let r = rxs();
    let after = &src[end.min(src.len())..(end + 64).min(src.len())];
    if r.call_open.is_match(after) {
        return true;
    }
    r.call_paren.is_match(after) && r.zero_comma.is_match(&src[start.saturating_sub(8)..start])
}

fn scan_into(src: &[u8], acc: &mut Acc) {
    let r = rxs();
    let sites: Vec<usize> = r.req.find_iter(src).map(|m| m.start()).collect();
    let esm: Vec<Vec<u8>> = r.esm.captures_iter(src).map(|c| c[1].to_vec()).collect();
    if sites.is_empty() && esm.is_empty() {
        return;
    }
    acc.files += 1;
    acc.sites += sites.len() + esm.len();
    if r.type_cmd.is_match(src) {
        acc.type_command = true;
    }
    let mut resolved: HashSet<usize> = HashSet::new();
    let mut names: Vec<String> = Vec::new();
    let add_name = |names: &mut Vec<String>, n: String| {
        if !names.contains(&n) {
            names.push(n);
        }
    };
    let mut ns_alias = OrderedMap::default();
    let mut top_alias = OrderedMap::default();
    let bind_key = |acc: &mut Acc, ns_alias: &mut OrderedMap, top_alias: &mut OrderedMap, key: String, alias: String| {
        if is_namespace(&key) {
            ns_alias.set(alias, key.clone());
        } else {
            top_alias.set(alias, key.clone());
        }
        acc.add_path(&key, None, false);
    };

    // 1. diretos
    for c in r.direct.captures_iter(src) {
        add_name(&mut names, text(&c[1]));
        resolved.insert(c.get(2).unwrap().start());
    }
    for c in r.destruct.captures_iter(src) {
        for (k, a) in destructured(&c[1]) {
            bind_key(acc, &mut ns_alias, &mut top_alias, k, a);
        }
        resolved.insert(c.get(2).unwrap().start());
    }
    for c in r.inline.captures_iter(src) {
        let m0 = c.get(0).unwrap();
        let first = text(&c[2]);
        let second = c.get(3).map(|m| text(m.as_bytes()));
        acc.add_path(&first, second.as_deref(), is_call(src, m0.start(), m0.end()));
        resolved.insert(m0.start());
    }
    for clause in &esm {
        let clause = clause.trim_ascii();
        let star = r.star.captures(clause);
        let named = r.named.captures(clause);
        let def = r.default_import.captures(clause);
        if let Some(s) = &star {
            add_name(&mut names, text(&s[2]));
        }
        if let Some(n) = &named {
            for (k, a) in destructured(&n[1]) {
                bind_key(acc, &mut ns_alias, &mut top_alias, k, a);
            }
        }
        if let (Some(d), None) = (&def, &star) {
            add_name(&mut names, text(&d[1]));
        }
        if star.is_none() && named.is_none() && def.is_none() {
            acc.unresolved += 1;
        }
    }

    // 2. módulos do webpack
    let mut mod_ids: Vec<(String, Vec<usize>)> = Vec::new();
    for &pos in &sites {
        if resolved.contains(&pos) {
            continue;
        }
        let win = &src[pos.saturating_sub(400)..pos];
        let Some(def) = r.module_def.captures(win).or_else(|| r.module_def_array.captures(win)) else { continue };
        let raw = text(&def[1]);
        let key = if raw.bytes().all(|b| b.is_ascii_digit()) { raw } else { raw[1..raw.len() - 1].to_string() };
        match mod_ids.iter_mut().find(|(k, _)| *k == key) {
            Some(e) => e.1.push(pos),
            None => mod_ids.push((key, vec![pos])),
        }
    }
    for (module, positions) in &mod_ids {
        let arg = if module.bytes().all(|b| b.is_ascii_digit()) { esc(module) } else { format!(r#"["']{}["']"#, esc(module)) };
        let call = format!(r"{ID}\(\s*(?:/\*[^*]*\*/\s*)?{arg}\s*\)");
        let mut used = false;
        for c in rx(&format!(r"(?:^|[^\w$.])({ID})\s*=\s*(?:{ID}\()?{call}")).captures_iter(src) {
            add_name(&mut names, text(&c[1]));
            used = true;
        }
        for c in rx(&format!(r"\{{([^{{}}]{{1,2000}})\}}\s*=\s*(?:{ID}\()?{call}")).captures_iter(src) {
            for (k, a) in destructured(&c[1]) {
                bind_key(acc, &mut ns_alias, &mut top_alias, k, a);
            }
            used = true;
        }
        for c in rx(&format!(r"(?:^|[^\w$.]){call}\.({ID})(?:\.({ID}))?")).captures_iter(src) {
            let m0 = c.get(0).unwrap();
            let first = text(&c[1]);
            let second = c.get(2).map(|m| text(m.as_bytes()));
            acc.add_path(&first, second.as_deref(), is_call(src, m0.start(), m0.end()));
            used = true;
        }
        if used {
            resolved.extend(positions.iter().copied());
        }
    }
    acc.unresolved += sites.iter().filter(|p| !resolved.contains(p)).count();
    acc.bindings += names.len() + ns_alias.len() + top_alias.len();

    // 3. apelidos de namespace: `X = vscode.window`
    for n in &names {
        for c in rx(&format!(r"(?:^|[^\w$.])({ID})\s*=\s*{}\.([a-z][\w$]*)\s*[;,)\n]", esc(n))).captures_iter(src) {
            let ns = text(&c[2]);
            if is_namespace(&ns) {
                ns_alias.set(text(&c[1]), ns);
            }
        }
    }

    // 4. acessos (prefixo sem `.`/aspa/crase)
    let mut lookups: Vec<(String, Option<String>, bool)> = names.iter().map(|n| (n.clone(), None, false)).collect();
    lookups.extend(ns_alias.0.iter().map(|(a, ns)| (a.clone(), Some(ns.clone()), false)));
    lookups.extend(top_alias.0.iter().map(|(a, t)| (a.clone(), Some(t.clone()), true)));
    for (n, base, is_top) in lookups {
        let re = rx(&format!(r#"(?:^|[^\w$.'"`])({})\.({ID})(?:\.({ID}))?(\s*=)?"#, esc(&n)));
        for c in re.captures_iter(src) {
            let m0 = c.get(0).unwrap();
            let start = c.get(1).unwrap().start();
            let after = src.get(m0.end()).copied();
            let assigned = c.get(4).is_some() && after != Some(b'=') && after != Some(b'>');
            let seg2 = text(&c[2]);
            let seg3 = c.get(3).map(|m| text(m.as_bytes()));
            let (first, second): (String, Option<String>) = match (&base, is_top) {
                (Some(b), false) => (b.clone(), Some(seg2.clone())),
                (Some(b), true) => (b.clone(), None),
                (None, _) => (seg2.clone(), seg3.clone()),
            };
            if assigned && is_top {
                continue;
            }
            if assigned && (base.is_some() || seg3.is_some()) {
                if in_surface(&first, second.as_deref()) {
                    acc.writes.insert(match &second {
                        Some(s) if is_namespace(&first) => format!("{first}.{s}"),
                        _ => first.clone(),
                    });
                }
                continue;
            }
            let end = match (c.get(3), &base) {
                (Some(m3), None) => m3.end(),
                _ => c.get(2).unwrap().end(),
            };
            acc.add_path(&first, second.as_deref(), is_call(src, start, end));
        }
    }
}

fn finish(acc: Acc, file: Option<String>, truncated: bool) -> ApiScan {
    let writes = acc.writes;
    ApiScan {
        scanner_version: SCANNER_VERSION,
        file,
        files_with_api: acc.files,
        bindings: acc.bindings,
        sites: acc.sites,
        unresolved: acc.unresolved,
        ignored: acc.ignored,
        type_command: acc.type_command,
        called: acc.called.into_iter().filter(|k| !writes.contains(k)).collect(),
        paths: acc.paths.into_iter().filter(|(k, _)| !writes.contains(k)).collect(),
        truncated,
        error: None,
    }
}

/// Varre fontes em memória (`(nome, bytes)`), na ordem dada (o `main` primeiro).
/// Usado pela pré-avaliação da loja (arquivos baixados, nunca gravados).
pub fn scan_sources<'a>(entries: impl IntoIterator<Item = (&'a str, &'a [u8])>, file: Option<String>, truncated: bool) -> ApiScan {
    let mut acc = Acc::default();
    for (_, bytes) in entries {
        scan_into(bytes, &mut acc);
    }
    finish(acc, file, truncated)
}

fn resolve_entry(ext_dir: &Path, raw: &str) -> Option<PathBuf> {
    let rel = vsix::safe_relative(raw.trim_start_matches("./")).ok()?;
    let mut file = ext_dir.join(&rel);
    if !file.is_file() {
        file = ext_dir.join(format!("{}.js", rel.display()));
    }
    let (f, root) = (std::fs::canonicalize(&file).ok()?, std::fs::canonicalize(ext_dir).ok()?);
    f.starts_with(&root).then_some(f)
}

pub fn scan_extension(ext_dir: &Path, pkg: &Value) -> ApiScan {
    let Some(main) = pkg.get("main").and_then(Value::as_str) else {
        return ApiScan { scanner_version: SCANNER_VERSION, ..Default::default() };
    };
    let Some(main_file) = resolve_entry(ext_dir, main) else {
        return ApiScan { scanner_version: SCANNER_VERSION, error: Some("arquivo `main` não encontrado dentro da extensão".into()), ..Default::default() };
    };
    let shown = std::fs::canonicalize(ext_dir)
        .ok()
        .and_then(|r| main_file.strip_prefix(r).ok().map(|p| p.to_string_lossy().replace('\\', "/")));
    // O bundle do navegador não roda neste host — a não ser que seja o próprio `main` (ex.: ErrorLens).
    let browser = pkg.get("browser").and_then(Value::as_str).and_then(|b| resolve_entry(ext_dir, b)).filter(|b| *b != main_file);
    // Ordem determinística (o `main` primeiro, depois os demais em ordem de
    // caminho): o teto de bytes corta sempre no mesmo ponto.
    let mut rest: Vec<PathBuf> = Vec::new();
    let mut stack = vec![ext_dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(e.path());
                }
            } else if ft.is_file() && (name.ends_with(".js") || name.ends_with(".cjs")) && !name.ends_with(".min.js") {
                rest.push(e.path());
            }
        }
    }
    rest.sort();
    let mut acc = Acc::default();
    let mut budget = MAX_SCAN_BYTES;
    let mut truncated = false;
    let mut seen = BTreeSet::new();
    for f in std::iter::once(main_file.clone()).chain(rest) {
        let canon = std::fs::canonicalize(&f).unwrap_or(f.clone());
        if !seen.insert(canon.clone()) || Some(&canon) == browser.as_ref() {
            continue;
        }
        let Ok(m) = std::fs::metadata(&canon) else { continue };
        if m.len() > MAX_SCAN_FILE && canon != main_file {
            continue;
        }
        if m.len() > budget {
            truncated = true;
            break;
        }
        budget -= m.len();
        if let Ok(bytes) = std::fs::read(&canon) {
            scan_into(&bytes, &mut acc);
        }
    }
    finish(acc, shown, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/ext-host/test/fixtures/api-scan");

    /// Paridade com o api-scan.js: a MESMA saída dourada para os mesmos fixtures.
    #[test]
    fn golden_fixtures_match_js_scanner() {
        let expected: BTreeMap<String, ApiScan> = serde_json::from_slice(&std::fs::read(format!("{FIXTURES}/expected.json")).unwrap()).unwrap();
        assert!(expected.len() >= 7);
        for (name, want) in expected {
            let src = std::fs::read(format!("{FIXTURES}/{name}")).unwrap();
            let got = scan_sources([(name.as_str(), src.as_slice())], Some(name.clone()), false);
            assert_eq!(got, want, "fixture {name}");
        }
    }

    /// Paridade sobre extensões REAIS (pasta no formato da matriz:
    /// `<pasta>/<id>/ext/package.json`): grava o JSON do Rust para comparar com
    /// o do api-scan.js. `FLUENT_SCAN_PARITY_DIR=… FLUENT_SCAN_PARITY_OUT=… cargo test --lib real_dir_parity -- --ignored`
    #[test]
    #[ignore]
    fn real_dir_parity() {
        let dir = std::env::var("FLUENT_SCAN_PARITY_DIR").expect("FLUENT_SCAN_PARITY_DIR");
        let mut out = BTreeMap::new();
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let ext = e.path().join("ext");
            let Ok(raw) = std::fs::read(ext.join("package.json")) else { continue };
            let Ok(pkg) = serde_json::from_slice::<Value>(&raw) else { continue };
            if pkg.get("main").is_none() {
                continue;
            }
            out.insert(e.file_name().to_string_lossy().into_owned(), scan_extension(&ext, &pkg));
        }
        std::fs::write(std::env::var("FLUENT_SCAN_PARITY_OUT").expect("FLUENT_SCAN_PARITY_OUT"), serde_json::to_vec_pretty(&out).unwrap()).unwrap();
    }

    #[test]
    fn webpack_bundle_is_resolved_and_noise_ignored() {
        let src = br#"(()=>{var e={1(e,t,r){var i=r(1398);i.window.showInformationMessage("x");i.length;i._},1398(e){e.exports=require("vscode")}}})();"#;
        let s = scan_sources([("a.js", &src[..])], None, false);
        assert_eq!(s.unresolved, 0);
        assert_eq!(s.bindings, 1);
        assert_eq!(s.paths, vec![("window.showInformationMessage".to_string(), 1)]);
        assert_eq!(s.ignored, 2);
        // `"vscode.diff"` numa string não é a API `diff`
        let s = scan_sources([("b.js", &br#"const vscode=require("vscode");vscode.commands.executeCommand("vscode.diff",a,b)"#[..])], None, false);
        assert_eq!(s.paths, vec![("commands.executeCommand".to_string(), 1)]);
        // `require("vscode")` sem ligação → unresolved
        let s = scan_sources([("c.js", &br#"f(require("vscode"))"#[..])], None, false);
        assert_eq!((s.sites, s.unresolved), (1, 1));
    }
}
