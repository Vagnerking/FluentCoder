//! Pasta de extensões GERENCIADA pelo app e o índice `extensions.json`.
//!
//! ```text
//! <app_data>/extensions/
//!   extensions.json                       ← índice (único escritor: este módulo)
//!   sources.json                          ← fontes de catálogo (openvsx.rs)
//!   <publisher>.<name>-<version>[-<plataforma>]/   ← payload `extension/` do VSIX
//!   .staging/<uuid>/                      ← download + extração em andamento
//!   .trash/<uuid>/                        ← versão substituída (rollback)
//! ```
//!
//! `~/.vscode/extensions` é SOMENTE LEITURA: listada como origem "vscode",
//! nunca escrita. Habilitar/desabilitar uma extensão de lá grava só um
//! override no índice do app.
//!
//! O host Node (`tools/ext-host/src/installed.js`) lê o MESMO índice; o formato
//! é contrato (docs/context/extensoes-vscode.md → "Pasta gerenciada").

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::semver;
use super::vsix;

pub const INDEX_FILE: &str = "extensions.json";
const STAGING: &str = ".staging";
const TRASH: &str = ".trash";

/// Serializa as escritas no índice (várias janelas = mesmo processo Rust).
pub static INDEX_LOCK: Mutex<()> = Mutex::new(());

/// Veredito do portão de compatibilidade (o app classifica, o host obedece).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    /// "compatible" | "partial" | "incompatible" | "unknown".
    pub verdict: String,
    /// Versão da extensão classificada (atualizar invalida o veredito).
    pub version: String,
    /// Versão da API do shim (`VSCODE_VERSION`) usada na classificação.
    pub host_version: String,
    #[serde(default)]
    pub evaluated_at: u64,
}

pub const VERDICTS: [&str; 4] = ["compatible", "partial", "incompatible", "unknown"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum InstallSource {
    /// Catálogo compatível com Open VSX.
    #[serde(rename_all = "camelCase")]
    Registry { registry: String, namespace: String, name: String },
    /// Copiada (somente leitura) de `~/.vscode/extensions`.
    #[serde(rename_all = "camelCase")]
    VscodeImport { from: String },
    /// Arquivo .vsix local escolhido pelo usuário.
    Vsix,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedEntry {
    pub id: String,
    pub version: String,
    /// Nome da pasta dentro da pasta gerenciada.
    pub dir: String,
    /// "universal" ou a plataforma do pacote (linux-x64…).
    pub target_platform: String,
    pub source: InstallSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: u64,
    /// O hash do registro foi conferido no download.
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub pre_release: bool,
    pub installed_at: u64,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<Gate>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VscodeOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<Gate>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Index {
    pub version: u32,
    #[serde(default)]
    pub extensions: BTreeMap<String, ManagedEntry>,
    #[serde(default)]
    pub vscode: BTreeMap<String, VscodeOverride>,
}

impl Default for Index {
    fn default() -> Self {
        Self { version: 1, extensions: BTreeMap::new(), vscode: BTreeMap::new() }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Extensões embutidas (validadas no shim, liberadas por padrão).
pub const BUILTIN_IDS: [&str; 2] = ["anthropic.claude-code", "openai.chatgpt"];

pub fn is_builtin(id: &str) -> bool {
    BUILTIN_IDS.contains(&id)
}

/// Plataforma deste processo no formato do VS Code (`linux-x64`, `darwin-arm64`…).
pub fn host_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "win32-x64",
        ("windows", "aarch64") => "win32-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", "arm") => "linux-armhf",
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        _ => "unknown",
    }
}

/// O pacote roda nesta plataforma? (`web` = só navegador: não.)
pub fn platform_matches(target: Option<&str>, host: &str) -> bool {
    match target {
        None | Some("universal") => true,
        Some(t) => t == host,
    }
}

/// Pasta do VS Code do usuário (somente leitura).
pub fn vscode_extensions_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FLUENT_VSCODE_EXTENSIONS_DIR") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".vscode").join("extensions"))
}

pub fn read_index(dir: &Path) -> Index {
    std::fs::read(dir.join(INDEX_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Index>(&b).ok())
        .unwrap_or_default()
}

/// Escreve o índice de forma atômica (arquivo temporário + rename).
pub fn write_index(dir: &Path, index: &Index) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{INDEX_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let data = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, data).map_err(|e| format!("falha ao gravar o índice: {e}"))?;
    std::fs::rename(&tmp, dir.join(INDEX_FILE)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("falha ao gravar o índice: {e}")
    })
}

/// Nome da pasta: `<publisher>.<name>-<version>[-<plataforma>]` (minúsculo).
pub fn folder_name(id: &str, version: &str, target_platform: Option<&str>) -> String {
    let base = format!("{id}-{version}").to_lowercase();
    match target_platform {
        Some(tp) if tp != "universal" => format!("{base}-{tp}"),
        _ => base,
    }
}

pub fn new_staging(dir: &Path) -> Result<PathBuf, String> {
    let p = dir.join(STAGING).join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&p).map_err(|e| format!("falha ao criar a pasta temporária: {e}"))?;
    Ok(p)
}

/// Limpa sobras de instalações interrompidas (app fechado no meio).
pub fn cleanup_leftovers(dir: &Path) {
    for sub in [STAGING, TRASH] {
        let _ = std::fs::remove_dir_all(dir.join(sub));
    }
}

/// Instala a pasta já extraída/copiada (`staged`) como `entry`, de forma
/// atômica: a versão anterior vai para `.trash` e só é apagada depois que o
/// índice novo foi gravado; qualquer falha devolve tudo como estava.
pub fn commit_install(dir: &Path, staged: &Path, mut entry: ManagedEntry) -> Result<ManagedEntry, String> {
    let _guard = INDEX_LOCK.lock().map_err(|e| e.to_string())?;
    let mut index = read_index(dir);
    let previous = index.extensions.get(&entry.id).cloned();
    // Preserva habilitação e o override de quem foi atualizado.
    if let Some(prev) = &previous {
        entry.enabled = prev.enabled;
    }
    let final_dir = dir.join(&entry.dir);
    let trash_root = dir.join(TRASH).join(uuid::Uuid::new_v4().to_string());
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new(); // (original, lixeira)
    let rollback = |moved: &Vec<(PathBuf, PathBuf)>, final_dir: &Path, installed_new: bool| {
        if installed_new {
            let _ = std::fs::remove_dir_all(final_dir);
        }
        for (orig, trash) in moved.iter().rev() {
            let _ = std::fs::rename(trash, orig);
        }
    };
    std::fs::create_dir_all(&trash_root).map_err(|e| e.to_string())?;
    // Pasta de destino ocupada (reinstalar a mesma versão) e pasta da versão anterior.
    let mut to_move = vec![final_dir.clone()];
    if let Some(prev) = &previous {
        let p = dir.join(&prev.dir);
        if p != final_dir {
            to_move.push(p);
        }
    }
    for (i, p) in to_move.iter().enumerate() {
        if p.exists() {
            let t = trash_root.join(i.to_string());
            if let Err(e) = std::fs::rename(p, &t) {
                rollback(&moved, &final_dir, false);
                return Err(format!("falha ao preparar a substituição: {e}"));
            }
            moved.push((p.clone(), t));
        }
    }
    if let Err(e) = std::fs::rename(staged, &final_dir) {
        rollback(&moved, &final_dir, false);
        return Err(format!("falha ao mover a extensão para a pasta final: {e}"));
    }
    index.extensions.insert(entry.id.clone(), entry.clone());
    if let Err(e) = write_index(dir, &index) {
        rollback(&moved, &final_dir, true);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(&trash_root);
    Ok(entry)
}

pub fn uninstall(dir: &Path, id: &str) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock().map_err(|e| e.to_string())?;
    let mut index = read_index(dir);
    let Some(entry) = index.extensions.remove(id) else {
        return Err(if vscode_has(id) {
            "Esta extensão é do VS Code (somente leitura): desinstale-a pelo VS Code ou apenas desabilite-a aqui.".into()
        } else {
            format!("Extensão não instalada no app: {id}")
        });
    };
    let path = dir.join(&entry.dir);
    let trash = dir.join(TRASH).join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(dir.join(TRASH)).map_err(|e| e.to_string())?;
    let moved = path.exists() && std::fs::rename(&path, &trash).is_ok();
    if let Err(e) = write_index(dir, &index) {
        if moved {
            let _ = std::fs::rename(&trash, &path);
        }
        return Err(e);
    }
    if moved {
        let _ = std::fs::remove_dir_all(&trash);
    }
    Ok(())
}

fn vscode_has(id: &str) -> bool {
    vscode_extensions_dir()
        .map(|d| scan_vscode(&d, host_platform()).iter().any(|e| e.id == id))
        .unwrap_or(false)
}

/// Habilita/desabilita (gerenciada → no registro; VS Code → override).
pub fn set_enabled(dir: &Path, id: &str, enabled: bool) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock().map_err(|e| e.to_string())?;
    let mut index = read_index(dir);
    if let Some(e) = index.extensions.get_mut(id) {
        e.enabled = enabled;
    } else {
        index.vscode.entry(id.to_string()).or_default().enabled = Some(enabled);
    }
    write_index(dir, &index)
}

pub fn set_gate(dir: &Path, id: &str, gate: Gate) -> Result<(), String> {
    if !VERDICTS.contains(&gate.verdict.as_str()) {
        return Err(format!("veredito inválido: {}", gate.verdict));
    }
    let _guard = INDEX_LOCK.lock().map_err(|e| e.to_string())?;
    let mut index = read_index(dir);
    if let Some(e) = index.extensions.get_mut(id) {
        e.gate = Some(gate);
    } else {
        index.vscode.entry(id.to_string()).or_default().gate = Some(gate);
    }
    write_index(dir, &index)
}

// ------------------------------------------------------------------ descoberta

/// Uma extensão encontrada (gerenciada ou do VS Code), como a UI a vê.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledInfo {
    pub id: String,
    pub publisher: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    /// "app" (pasta gerenciada) | "vscode" (somente leitura).
    pub location: &'static str,
    pub path: String,
    pub target_platform: String,
    pub builtin: bool,
    pub enabled: bool,
    pub gate: Option<Gate>,
    pub source: Option<InstallSource>,
    pub verified: bool,
    pub pre_release: bool,
    pub installed_at: Option<u64>,
    /// Mesma extensão também existe na outra origem (versão de lá).
    pub shadowed_version: Option<String>,
    pub manifest: Value,
}

struct Found {
    id: String,
    path: PathBuf,
    pkg: Value,
    target_platform: Option<String>,
}

fn read_pkg(path: &Path) -> Option<Value> {
    let meta = std::fs::metadata(path.join("package.json")).ok()?;
    if meta.len() > 4 << 20 {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path.join("package.json")).ok()?).ok()
}

fn pkg_id(pkg: &Value) -> Option<String> {
    let p = pkg.get("publisher")?.as_str()?;
    let n = pkg.get("name")?.as_str()?;
    Some(format!("{p}.{n}").to_lowercase())
}

fn scan_vscode(dir: &Path, host: &str) -> Vec<Found> {
    let obsolete: BTreeMap<String, Value> = std::fs::read(dir.join(".obsolete"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let re = regex::Regex::new(r"-(win32|linux|darwin|alpine)-(x64|arm64|armhf|ia32)$").unwrap();
    let mut best: BTreeMap<String, Found> = BTreeMap::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if obsolete.contains_key(&name) {
            continue;
        }
        let tp = re.captures(&name).map(|c| format!("{}-{}", &c[1], &c[2]));
        if let Some(t) = &tp {
            if t != host {
                continue;
            }
        }
        let path = e.path();
        let Some(pkg) = read_pkg(&path) else { continue };
        let Some(id) = pkg_id(&pkg) else { continue };
        let ver = pkg.get("version").and_then(Value::as_str).unwrap_or("0.0.0").to_string();
        if let Some(prev) = best.get(&id) {
            let pv = prev.pkg.get("version").and_then(Value::as_str).unwrap_or("0.0.0");
            if semver::compare(&ver, pv) != std::cmp::Ordering::Greater {
                continue;
            }
        }
        best.insert(id.clone(), Found { id, path, pkg, target_platform: tp });
    }
    best.into_values().collect()
}

fn str_of(pkg: &Value, k: &str) -> String {
    pkg.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Gerenciadas (pelo índice) + VS Code (somente leitura); mesmo id → a gerenciada vence.
pub fn discover(dir: &Path, vscode_dir: Option<&Path>) -> Vec<InstalledInfo> {
    let host = host_platform();
    let index = read_index(dir);
    let mut out: BTreeMap<String, InstalledInfo> = BTreeMap::new();
    for (id, entry) in &index.extensions {
        if vsix::safe_relative(&entry.dir).map(|p| p.components().count() != 1).unwrap_or(true) {
            continue;
        }
        let path = dir.join(&entry.dir);
        let Some(pkg) = read_pkg(&path) else { continue };
        if pkg_id(&pkg).as_deref() != Some(id.as_str()) {
            continue;
        }
        if !platform_matches(Some(entry.target_platform.as_str()), host) {
            continue;
        }
        out.insert(
            id.clone(),
            InstalledInfo {
                id: id.clone(),
                publisher: str_of(&pkg, "publisher"),
                name: str_of(&pkg, "name"),
                display_name: pkg.get("displayName").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| str_of(&pkg, "name")),
                description: str_of(&pkg, "description"),
                version: str_of(&pkg, "version"),
                location: "app",
                path: path.to_string_lossy().into_owned(),
                target_platform: entry.target_platform.clone(),
                builtin: is_builtin(id),
                enabled: entry.enabled,
                gate: entry.gate.clone(),
                source: Some(entry.source.clone()),
                verified: entry.verified,
                pre_release: entry.pre_release,
                installed_at: Some(entry.installed_at),
                shadowed_version: None,
                manifest: pkg,
            },
        );
    }
    if let Some(vdir) = vscode_dir {
        for f in scan_vscode(vdir, host) {
            let ver = str_of(&f.pkg, "version");
            if let Some(managed) = out.get_mut(&f.id) {
                managed.shadowed_version = Some(ver);
                continue;
            }
            let ov = index.vscode.get(&f.id).cloned().unwrap_or_default();
            out.insert(
                f.id.clone(),
                InstalledInfo {
                    id: f.id.clone(),
                    publisher: str_of(&f.pkg, "publisher"),
                    name: str_of(&f.pkg, "name"),
                    display_name: f.pkg.get("displayName").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| str_of(&f.pkg, "name")),
                    description: str_of(&f.pkg, "description"),
                    version: ver,
                    location: "vscode",
                    path: f.path.to_string_lossy().into_owned(),
                    target_platform: f.target_platform.unwrap_or_else(|| "universal".into()),
                    builtin: is_builtin(&f.id),
                    enabled: ov.enabled.unwrap_or(is_builtin(&f.id)),
                    gate: ov.gate,
                    source: None,
                    verified: false,
                    pre_release: false,
                    installed_at: None,
                    shadowed_version: None,
                    manifest: f.pkg,
                },
            );
        }
    }
    out.into_values().collect()
}

/// Pasta de uma extensão do VS Code pelo id (validada dentro de `vscode_dir`).
pub fn vscode_extension_path(vscode_dir: &Path, id: &str) -> Option<PathBuf> {
    scan_vscode(vscode_dir, host_platform()).into_iter().find(|f| f.id == id).map(|f| f.path)
}

/// Copia (somente leitura na origem) uma pasta de extensão para `dest`.
/// Symlinks são pulados (nunca seguidos); tetos de tamanho e de arquivos.
pub fn copy_tree(src: &Path, dest: &Path, limits: vsix::Limits) -> Result<u64, String> {
    let mut total = 0u64;
    let mut files = 0usize;
    fn walk(src: &Path, dest: &Path, limits: &vsix::Limits, total: &mut u64, files: &mut usize) -> Result<(), String> {
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            let ft = e.file_type().map_err(|e| e.to_string())?;
            let to = dest.join(e.file_name());
            if ft.is_symlink() {
                continue;
            } else if ft.is_dir() {
                walk(&e.path(), &to, limits, total, files)?;
            } else if ft.is_file() {
                *files += 1;
                if *files > limits.max_entries {
                    return Err("a extensão tem arquivos demais".into());
                }
                let len = e.metadata().map_err(|e| e.to_string())?.len();
                if len > limits.max_file_bytes || *total + len > limits.max_total_bytes {
                    return Err("a extensão passa do limite de tamanho".into());
                }
                std::fs::copy(e.path(), &to).map_err(|err| format!("falha ao copiar {}: {err}", e.path().display()))?;
                *total += len;
            }
        }
        Ok(())
    }
    if let Err(e) = walk(src, dest, &limits, &mut total, &mut files) {
        let _ = std::fs::remove_dir_all(dest);
        return Err(e);
    }
    Ok(total)
}

// ------------------------------------------------------------ análise do bundle

/// Caminhos `vscode.a.b` referenciados pelo código Node da extensão
/// (varredura estática). Mesma ideia de `tools/ext-host/discovery/static-scan.js`,
/// estendida para: vários arquivos (extensões sem bundle, `node_modules`),
/// apelidos de namespace (`const window = vscode.window`) e propriedades que a
/// própria extensão grava no namespace (`window.x = …`, que não são API).
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApiScan {
    /// Arquivo `main` (relativo à extensão); None = sem `main`.
    pub file: Option<String>,
    /// Arquivos analisados que fazem `require("vscode")`.
    pub files_with_api: usize,
    /// Identificadores ligados a `require("vscode")`.
    pub bindings: usize,
    pub paths: Vec<(String, u32)>,
    /// A varredura parou no teto de bytes (resultado incompleto).
    pub truncated: bool,
    /// Não foi possível ler/analisar (motivo).
    pub error: Option<String>,
}

const MAX_SCAN_BYTES: u64 = 64 << 20;
const MAX_SCAN_FILE: u64 = 16 << 20;

#[derive(Default)]
struct ScanAcc {
    bindings: usize,
    files: usize,
    paths: BTreeMap<String, u32>,
    writes: std::collections::BTreeSet<String>,
}

fn scan_into(src: &str, acc: &mut ScanAcc) {
    let bind = regex::Regex::new(r#"([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\()?require\(\s*["']vscode["']\s*\)"#).unwrap();
    let mut names: Vec<String> = bind.captures_iter(src).map(|c| c[1].to_string()).collect();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return;
    }
    acc.files += 1;
    acc.bindings += names.len();
    // Apelidos de namespace: `X = vscode.window` (sem acesso encadeado depois).
    let mut aliases: Vec<(String, String)> = Vec::new();
    for n in &names {
        let re = regex::Regex::new(&format!(r"([A-Za-z_$][\w$]*)\s*=\s*{}\.([a-z][\w$]*)\s*[;,)\n]", regex::escape(n))).unwrap();
        for c in re.captures_iter(src) {
            aliases.push((c[1].to_string(), c[2].to_string()));
        }
    }
    let lookups = names.iter().map(|n| (n.clone(), None)).chain(aliases.iter().map(|(a, ns)| (a.clone(), Some(ns.clone()))));
    for (n, ns) in lookups {
        let re = regex::Regex::new(&format!(
            r"(?:^|[^\w$.]){}\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?(\s*=)?",
            regex::escape(&n)
        ))
        .unwrap();
        for c in re.captures_iter(src) {
            let (first, second) = match &ns {
                Some(ns) => (ns.as_str(), Some(&c[1])),
                None => (&c[1], c.get(2).map(|m| m.as_str())),
            };
            let key = match second {
                Some(s) if first.starts_with(|ch: char| ch.is_ascii_lowercase()) => format!("{first}.{s}"),
                _ => first.to_string(),
            };
            // Escrita direta no membro (`window.minhaProp = …`): é da extensão, não da API.
            // `=` seguido de `=`/`>` é comparação/arrow, não atribuição.
            let assigned = c.get(3).map(|m| !matches!(src.as_bytes().get(m.end()), Some(b'=') | Some(b'>'))).unwrap_or(false);
            let is_write = assigned && (ns.is_some() || c.get(2).is_some());
            if is_write {
                acc.writes.insert(key);
            } else {
                *acc.paths.entry(key).or_insert(0) += 1;
            }
        }
    }
}

pub fn scan_source(src: &str) -> (usize, Vec<(String, u32)>) {
    let mut acc = ScanAcc::default();
    scan_into(src, &mut acc);
    let writes = acc.writes;
    (acc.bindings, acc.paths.into_iter().filter(|(k, _)| !writes.contains(k)).collect())
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

/// Pastas puladas na varredura (sem código da extensão que fale com `vscode`).
const SKIP_DIRS: [&str; 6] = ["@types", "typescript", ".git", "webview", "webview-ui", "media"];

pub fn scan_extension(ext_dir: &Path, pkg: &Value) -> ApiScan {
    let Some(main) = pkg.get("main").and_then(Value::as_str) else {
        return ApiScan::default();
    };
    let Some(main_file) = resolve_entry(ext_dir, main) else {
        return ApiScan { error: Some("arquivo `main` não encontrado dentro da extensão".into()), ..Default::default() };
    };
    let shown = std::fs::canonicalize(ext_dir).ok().and_then(|r| main_file.strip_prefix(r).ok().map(|p| p.to_string_lossy().into_owned()));
    // O bundle do navegador (`browser`) não roda neste host: fora da análise.
    let browser = pkg.get("browser").and_then(Value::as_str).and_then(|b| resolve_entry(ext_dir, b));
    let mut acc = ScanAcc::default();
    let mut budget = MAX_SCAN_BYTES;
    let mut truncated = false;
    let mut queue: Vec<PathBuf> = vec![main_file.clone()];
    // Demais .js/.cjs (extensões sem bundle repartem o código em vários arquivos).
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
                queue.push(e.path());
            }
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    for f in queue {
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
            scan_into(&String::from_utf8_lossy(&bytes), &mut acc);
        }
    }
    let writes = acc.writes;
    ApiScan {
        file: shown,
        files_with_api: acc.files,
        bindings: acc.bindings,
        paths: acc.paths.into_iter().filter(|(k, _)| !writes.contains(k)).collect(),
        truncated,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::vsix::tests::{fixture_vsix, tmpdir};
    use std::io::Cursor;

    fn entry(id: &str, version: &str) -> ManagedEntry {
        ManagedEntry {
            id: id.into(),
            version: version.into(),
            dir: folder_name(id, version, None),
            target_platform: "universal".into(),
            source: InstallSource::Vsix,
            sha256: None,
            size: 1,
            verified: false,
            pre_release: false,
            installed_at: 1,
            enabled: true,
            gate: None,
        }
    }

    fn stage(dir: &Path, version: &str) -> PathBuf {
        let staging = new_staging(dir).unwrap();
        let out = staging.join("extension");
        vsix::extract_payload(Cursor::new(fixture_vsix("acme", "demo", version, None)), &out, vsix::Limits::default()).unwrap();
        out
    }

    #[test]
    fn install_update_uninstall_roundtrip() {
        let dir = tmpdir("store");
        let s1 = stage(&dir, "1.0.0");
        commit_install(&dir, &s1, entry("acme.demo", "1.0.0")).unwrap();
        assert!(dir.join("acme.demo-1.0.0/package.json").is_file());
        let found = discover(&dir, None);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].location, "app");
        assert_eq!(found[0].version, "1.0.0");
        // desabilitar sobrevive ao update
        set_enabled(&dir, "acme.demo", false).unwrap();
        let s2 = stage(&dir, "1.1.0");
        commit_install(&dir, &s2, entry("acme.demo", "1.1.0")).unwrap();
        assert!(!dir.join("acme.demo-1.0.0").exists(), "versão antiga removida");
        let found = discover(&dir, None);
        assert_eq!(found[0].version, "1.1.0");
        assert!(!found[0].enabled);
        uninstall(&dir, "acme.demo").unwrap();
        assert!(discover(&dir, None).is_empty());
        assert!(!dir.join("acme.demo-1.1.0").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_commit_rolls_back() {
        let dir = tmpdir("rollback");
        let s1 = stage(&dir, "1.0.0");
        commit_install(&dir, &s1, entry("acme.demo", "1.0.0")).unwrap();
        // staged inexistente → falha ao mover; a 1.0.0 continua lá e no índice.
        let bogus = dir.join(".staging/nao-existe/extension");
        assert!(commit_install(&dir, &bogus, entry("acme.demo", "2.0.0")).is_err());
        assert!(dir.join("acme.demo-1.0.0/package.json").is_file());
        assert_eq!(read_index(&dir).extensions["acme.demo"].version, "1.0.0");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn managed_wins_over_vscode_and_overrides_apply() {
        let dir = tmpdir("disc");
        let vdir = tmpdir("vscode");
        // VS Code: demo 0.9.0 (perde para a gerenciada) + other 1.0.0 (+ pacote de outra plataforma ignorado)
        for (folder, ver, name) in [("acme.demo-0.9.0", "0.9.0", "demo"), ("acme.other-1.0.0", "1.0.0", "other"), ("acme.other-2.0.0-win32-arm64", "2.0.0", "other")] {
            vsix::extract_payload(Cursor::new(fixture_vsix("acme", name, ver, None)), &vdir.join(folder), vsix::Limits::default()).unwrap();
        }
        let s1 = stage(&dir, "1.0.0");
        commit_install(&dir, &s1, entry("acme.demo", "1.0.0")).unwrap();
        let found = discover(&dir, Some(&vdir));
        let demo = found.iter().find(|f| f.id == "acme.demo").unwrap();
        assert_eq!(demo.location, "app");
        assert_eq!(demo.shadowed_version.as_deref(), Some("0.9.0"));
        let other = found.iter().find(|f| f.id == "acme.other").unwrap();
        assert_eq!(other.location, "vscode");
        if host_platform() != "win32-arm64" {
            assert_eq!(other.version, "1.0.0");
        }
        assert!(!other.enabled, "do VS Code e não embutida: desabilitada por padrão");
        set_enabled(&dir, "acme.other", true).unwrap();
        set_gate(&dir, "acme.other", Gate { verdict: "partial".into(), version: "1.0.0".into(), host_version: "1.106.0".into(), evaluated_at: 1 }).unwrap();
        let other = discover(&dir, Some(&vdir)).into_iter().find(|f| f.id == "acme.other").unwrap();
        assert!(other.enabled);
        assert_eq!(other.gate.unwrap().verdict, "partial");
        assert!(set_gate(&dir, "acme.other", Gate { verdict: "ok".into(), version: "1".into(), host_version: "1".into(), evaluated_at: 0 }).is_err());
        // uninstall de extensão do VS Code: recusado (somente leitura)
        assert!(uninstall(&dir, "acme.other").is_err());
        assert!(vdir.join("acme.other-1.0.0/package.json").is_file());
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(vdir).unwrap();
    }

    #[test]
    fn copy_tree_skips_symlinks() {
        let src = tmpdir("copysrc");
        std::fs::write(src.join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("sub/a.js"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", src.join("evil")).unwrap();
        let dest = tmpdir("copydst").join("x");
        copy_tree(&src, &dest, vsix::Limits::default()).unwrap();
        assert!(dest.join("sub/a.js").is_file());
        assert!(!dest.join("evil").exists());
        std::fs::remove_dir_all(src).unwrap();
        std::fs::remove_dir_all(dest.parent().unwrap()).unwrap();
    }

    #[test]
    fn scans_vscode_api_paths() {
        let (b, paths) = scan_source(r#"var o=Object.create;const vs=__toESM(require("vscode"));vs.window.createWebviewPanel();vs.window.showInformationMessage('x');vs.Uri.file('a');x.vs.window.nope();"#);
        assert_eq!(b, 1);
        let m: BTreeMap<_, _> = paths.into_iter().collect();
        assert_eq!(m.get("window.createWebviewPanel"), Some(&1));
        assert_eq!(m.get("Uri"), Some(&1));
        assert!(!m.contains_key("window.nope"));
        // apelido de namespace + propriedade gravada pela própria extensão
        let (_, paths) = scan_source("var vscode = require('vscode');\nvar window = vscode.window;\nwindow.outputChannel = window.createOutputChannel('x');\nwindow.outputChannel.appendLine('a');\nvscode.window.statusBarItem = 1;");
        let m: BTreeMap<_, _> = paths.into_iter().collect();
        assert_eq!(m.get("window.createOutputChannel"), Some(&1));
        assert!(!m.contains_key("window.outputChannel"));
        assert!(!m.contains_key("window.statusBarItem"));
    }

    #[test]
    fn folder_names() {
        assert_eq!(folder_name("acme.demo", "1.0.0", None), "acme.demo-1.0.0");
        assert_eq!(folder_name("acme.demo", "1.0.0", Some("linux-x64")), "acme.demo-1.0.0-linux-x64");
        assert!(platform_matches(None, "linux-x64"));
        assert!(platform_matches(Some("linux-x64"), "linux-x64"));
        assert!(!platform_matches(Some("darwin-arm64"), "linux-x64"));
        assert!(!platform_matches(Some("web"), "linux-x64"));
    }
}
