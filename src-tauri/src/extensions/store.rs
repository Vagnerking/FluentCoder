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

/// Liberação EXPLÍCITA do usuário para rodar uma versão "Não avaliada"
/// (código que a varredura não conseguiu seguir). Vale só para a MESMA versão
/// da extensão e a MESMA API do shim; atualizar a extensão a descarta. Nunca
/// libera Incompatível (o host confere: só com `gate.verdict == "unknown"`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trust {
    pub version: String,
    pub host_version: String,
    #[serde(default)]
    pub granted_at: u64,
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<Trust>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VscodeOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<Gate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<Trust>,
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
    set_gates(dir, vec![(id.to_string(), gate)])
}

/// Vários vereditos numa ÚNICA escrita do índice (a view avalia em lote).
/// Só grava o que mudou; nada mudou → não escreve.
pub fn set_gates(dir: &Path, gates: Vec<(String, Gate)>) -> Result<(), String> {
    for (_, g) in &gates {
        if !VERDICTS.contains(&g.verdict.as_str()) {
            return Err(format!("veredito inválido: {}", g.verdict));
        }
    }
    let _guard = INDEX_LOCK.lock().map_err(|e| e.to_string())?;
    let mut index = read_index(dir);
    let mut changed = false;
    let same = |a: &Option<Gate>, b: &Gate| a.as_ref().map(|a| a.verdict == b.verdict && a.version == b.version && a.host_version == b.host_version).unwrap_or(false);
    for (id, gate) in gates {
        let slot = match index.extensions.get_mut(&id) {
            Some(e) => &mut e.gate,
            None => &mut index.vscode.entry(id).or_default().gate,
        };
        if !same(slot, &gate) {
            *slot = Some(gate);
            changed = true;
        }
    }
    if changed {
        write_index(dir, &index)
    } else {
        Ok(())
    }
}

/// Liga/desliga a liberação explícita de uma versão "Não avaliada".
pub fn set_trust(dir: &Path, id: &str, trust: Option<Trust>) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock().map_err(|e| e.to_string())?;
    let mut index = read_index(dir);
    if let Some(e) = index.extensions.get_mut(id) {
        e.trust = trust;
    } else {
        index.vscode.entry(id.to_string()).or_default().trust = trust;
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
    /// Liberação explícita de uma versão "Não avaliada" (ver `Trust`).
    pub trust: Option<Trust>,
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

// ------------------------------------------------------------------ NLS

/// Locale do app (o host recebe o mesmo em `initialize.language`).
pub const DEFAULT_LOCALE: &str = "pt-br";
const NLS_MAX_BYTES: u64 = 4 << 20;
const NLS_MAX_DEPTH: usize = 32;
const NLS_MAX_NODES: usize = 50_000;

/// Arquivos de mensagens, do mais genérico ao mais específico:
/// `package.nls.json` → `package.nls.pt.json` → `package.nls.pt-br.json`.
/// Espelho de `nlsChain` em tools/ext-host/src/contributions.js.
pub fn nls_chain(locale: &str) -> Vec<String> {
    let loc = locale.to_ascii_lowercase().replace('_', "-");
    let mut out = vec!["package.nls.json".to_string()];
    let lang = loc.split('-').next().unwrap_or("");
    let is_lang = |s: &str| (2..=3).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase());
    if is_lang(lang) {
        out.push(format!("package.nls.{lang}.json"));
    }
    let parts: Vec<&str> = loc.split('-').collect();
    let region_ok = parts.len() > 1 && parts[1..].iter().all(|p| (2..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    if loc != lang && is_lang(lang) && region_ok {
        out.push(format!("package.nls.{loc}.json"));
    }
    out
}

/// Mensagens mescladas pela cadeia (o mais específico vence). `fetch` lê um
/// arquivo pelo nome (disco ou rede) e devolve o JSON já com o teto aplicado.
pub fn merge_nls(locale: &str, mut fetch: impl FnMut(&str) -> Option<Value>) -> serde_json::Map<String, Value> {
    let mut nls = serde_json::Map::new();
    for f in nls_chain(locale) {
        if let Some(Value::Object(m)) = fetch(&f) {
            nls.extend(m);
        }
    }
    nls
}

pub fn load_nls(ext_dir: &Path, locale: &str) -> serde_json::Map<String, Value> {
    merge_nls(locale, |f| {
        let p = ext_dir.join(f);
        let m = std::fs::metadata(&p).ok()?;
        if !m.is_file() || m.len() > NLS_MAX_BYTES {
            return None;
        }
        serde_json::from_slice(&std::fs::read(&p).ok()?).ok()
    })
}

fn placeholder_key(s: &str) -> Option<&str> {
    let k = s.strip_prefix('%')?.strip_suffix('%')?;
    (!k.is_empty() && !k.contains('%')).then_some(k)
}

pub fn is_placeholder(s: &str) -> bool {
    placeholder_key(s).is_some()
}

/// Texto de uma mensagem: `"texto"` ou `{ message, comment }`.
fn nls_message(v: &Value) -> Option<&str> {
    match v {
        Value::String(s) => Some(s),
        Value::Object(o) => o.get("message").and_then(Value::as_str),
        _ => None,
    }
}

/// Manifesto traduzido com as mensagens dadas: toda string que seja
/// exatamente `%chave%` vira a mensagem (travessia limitada: profundidade ≤ 32,
/// ≤ 50 000 nós). Chave ausente: fica `%chave%`. Espelho de `localizeManifest`.
pub fn localize_with(pkg: &Value, nls: &serde_json::Map<String, Value>) -> Value {
    fn walk(v: &Value, depth: usize, nodes: &mut usize, nls: &serde_json::Map<String, Value>) -> Value {
        *nodes += 1;
        if *nodes > NLS_MAX_NODES || depth > NLS_MAX_DEPTH {
            return v.clone();
        }
        match v {
            Value::String(s) => match placeholder_key(s).and_then(|k| nls.get(k)).and_then(nls_message) {
                Some(m) => Value::String(m.to_string()),
                None => v.clone(),
            },
            Value::Array(a) => Value::Array(a.iter().map(|x| walk(x, depth + 1, nodes, nls)).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), walk(x, depth + 1, nodes, nls))).collect()),
            _ => v.clone(),
        }
    }
    let mut nodes = 0;
    walk(pkg, 0, &mut nodes, nls)
}

/// O manifesto lido do disco, traduzido pela cadeia de `package.nls*.json` da pasta.
pub fn localize_manifest(pkg: &Value, ext_dir: &Path, locale: &str) -> Value {
    let nls = load_nls(ext_dir, locale);
    if nls.is_empty() {
        return pkg.clone();
    }
    localize_with(pkg, &nls)
}

/// O manifesto ainda tem algum `%chave%` (vale buscar o NLS)?
pub fn has_placeholders(v: &Value) -> bool {
    match v {
        Value::String(s) => is_placeholder(s),
        Value::Array(a) => a.iter().any(has_placeholders),
        Value::Object(o) => o.values().any(has_placeholders),
        _ => false,
    }
}

/// Nome para exibição: `displayName` traduzido; placeholder sem tradução → `name`.
pub fn display_name_of(pkg: &Value) -> String {
    match pkg.get("displayName").and_then(Value::as_str) {
        Some(d) if !d.is_empty() && !is_placeholder(d) => d.to_string(),
        _ => str_of(pkg, "name"),
    }
}

/// Descrição para exibição (placeholder sem tradução → vazio).
pub fn description_of(pkg: &Value) -> String {
    match pkg.get("description").and_then(Value::as_str) {
        Some(d) if !is_placeholder(d) => d.to_string(),
        _ => String::new(),
    }
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
        let pkg = localize_manifest(&pkg, &path, DEFAULT_LOCALE);
        if !platform_matches(Some(entry.target_platform.as_str()), host) {
            continue;
        }
        out.insert(
            id.clone(),
            InstalledInfo {
                id: id.clone(),
                publisher: str_of(&pkg, "publisher"),
                name: str_of(&pkg, "name"),
                display_name: display_name_of(&pkg),
                description: description_of(&pkg),
                version: str_of(&pkg, "version"),
                location: "app",
                path: path.to_string_lossy().into_owned(),
                target_platform: entry.target_platform.clone(),
                builtin: is_builtin(id),
                enabled: entry.enabled,
                gate: entry.gate.clone(),
                trust: entry.trust.clone(),
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
            let pkg = localize_manifest(&f.pkg, &f.path, DEFAULT_LOCALE);
            out.insert(
                f.id.clone(),
                InstalledInfo {
                    id: f.id.clone(),
                    publisher: str_of(&pkg, "publisher"),
                    name: str_of(&pkg, "name"),
                    display_name: display_name_of(&pkg),
                    description: description_of(&pkg),
                    version: ver,
                    location: "vscode",
                    path: f.path.to_string_lossy().into_owned(),
                    target_platform: f.target_platform.unwrap_or_else(|| "universal".into()),
                    builtin: is_builtin(&f.id),
                    enabled: ov.enabled.unwrap_or(is_builtin(&f.id)),
                    gate: ov.gate,
                    trust: ov.trust,
                    source: None,
                    verified: false,
                    pre_release: false,
                    installed_at: None,
                    shadowed_version: None,
                    manifest: pkg,
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

/// A varredura mora em `scan.rs` (espelho do api-scan.js); reexportada aqui
/// para os chamadores antigos (`store::scan_extension`, `store::ApiScan`).
pub use super::scan::{scan_extension, ApiScan};

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
            trust: None,
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

    /// Paridade com `localizeManifest` (JS): a mesma saída dourada.
    #[test]
    fn nls_matches_js_golden_and_chain() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/ext-host/test/fixtures/nls");
        let expected: Value = serde_json::from_slice(&std::fs::read(root.join("expected.json")).unwrap()).unwrap();
        let pkg: Value = serde_json::from_slice(&std::fs::read(root.join("demo/package.json")).unwrap()).unwrap();
        for loc in ["pt-br", "en", "pt"] {
            assert_eq!(localize_manifest(&pkg, &root.join("demo"), loc), expected[loc], "locale {loc}");
        }
        assert_eq!(nls_chain("pt-BR"), vec!["package.nls.json", "package.nls.pt.json", "package.nls.pt-br.json"]);
        assert_eq!(nls_chain("en"), vec!["package.nls.json", "package.nls.en.json"]);
        assert_eq!(nls_chain("../x"), vec!["package.nls.json"]);
        let loc = localize_manifest(&pkg, &root.join("demo"), "pt-br");
        assert_eq!(display_name_of(&loc), "Demo NLS");
        // chave ausente: o nome de exibição cai para `name`
        let raw = serde_json::json!({"name": "x", "displayName": "%nao.existe%", "description": "%d%"});
        assert_eq!(display_name_of(&raw), "x");
        assert_eq!(description_of(&raw), "");
        assert!(has_placeholders(&raw));
    }

    #[test]
    fn discover_localizes_both_origins() {
        let dir = tmpdir("nlsdisc");
        let vdir = tmpdir("nlsv");
        let ext = vdir.join("acme.demo-nls-1.0.0");
        std::fs::create_dir_all(&ext).unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/ext-host/test/fixtures/nls/demo");
        for f in ["package.json", "package.nls.json", "package.nls.pt.json", "package.nls.pt-br.json"] {
            std::fs::copy(root.join(f), ext.join(f)).unwrap();
        }
        let found = discover(&dir, Some(&vdir));
        let d = found.iter().find(|f| f.id == "acme.demo-nls").unwrap();
        assert_eq!(d.display_name, "Demo NLS");
        assert_eq!(d.description, "Descrição em português genérico");
        assert_eq!(d.manifest["contributes"]["commands"][0]["title"], "Executar Demo");
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(vdir).unwrap();
    }

    #[test]
    fn gates_in_batch_and_trust_per_version() {
        let dir = tmpdir("trust");
        let s1 = stage(&dir, "1.0.0");
        commit_install(&dir, &s1, entry("acme.demo", "1.0.0")).unwrap();
        let g = |v: &str| Gate { verdict: v.into(), version: "1.0.0".into(), host_version: "1.108.2".into(), evaluated_at: 1 };
        // lote: uma escrita para a gerenciada + um override do VS Code
        set_gates(&dir, vec![("acme.demo".into(), g("unknown")), ("acme.vs".into(), g("partial"))]).unwrap();
        let idx = read_index(&dir);
        assert_eq!(idx.extensions["acme.demo"].gate.as_ref().unwrap().verdict, "unknown");
        assert_eq!(idx.vscode["acme.vs"].gate.as_ref().unwrap().verdict, "partial");
        // nada mudou → não reescreve (mtime igual)
        let before = std::fs::metadata(dir.join(INDEX_FILE)).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        set_gates(&dir, vec![("acme.demo".into(), g("unknown"))]).unwrap();
        assert_eq!(std::fs::metadata(dir.join(INDEX_FILE)).unwrap().modified().unwrap(), before);
        assert!(set_gates(&dir, vec![("acme.demo".into(), g("talvez"))]).is_err());
        // liberação explícita: gravada, aparece na descoberta e some ao atualizar
        set_trust(&dir, "acme.demo", Some(Trust { version: "1.0.0".into(), host_version: "1.108.2".into(), granted_at: 1 })).unwrap();
        assert_eq!(discover(&dir, None)[0].trust.as_ref().unwrap().version, "1.0.0");
        let s2 = stage(&dir, "1.1.0");
        commit_install(&dir, &s2, entry("acme.demo", "1.1.0")).unwrap();
        assert!(discover(&dir, None)[0].trust.is_none(), "versão nova = sem liberação");
        set_trust(&dir, "acme.demo", None).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
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
        use super::super::scan::scan_sources;
        let src = br#"var o=Object.create;const vs=__toESM(require("vscode"));vs.window.createWebviewPanel();vs.window.showInformationMessage('x');vs.Uri.file('a');x.vs.window.nope();"#;
        let s = scan_sources([("a.js", &src[..])], None, false);
        assert_eq!(s.bindings, 1);
        let m: BTreeMap<_, _> = s.paths.into_iter().collect();
        assert_eq!(m.get("window.createWebviewPanel"), Some(&1));
        assert_eq!(m.get("Uri"), Some(&1));
        assert!(!m.contains_key("window.nope"));
        // apelido de namespace + propriedade gravada pela própria extensão
        let src = b"var vscode = require('vscode');\nvar window = vscode.window;\nwindow.outputChannel = window.createOutputChannel('x');\nwindow.outputChannel.appendLine('a');\nvscode.window.statusBarItem = 1;";
        let s = scan_sources([("b.js", &src[..])], None, false);
        let m: BTreeMap<_, _> = s.paths.into_iter().collect();
        assert_eq!(m.get("window.createOutputChannel"), Some(&1));
        assert!(!m.contains_key("window.outputChannel"));
        assert!(!m.contains_key("window.statusBarItem"));
        let s = scan_sources([("c.js", &b"const v = require('vscode'); v.window.showErrorMessage ('a'); if (v.window.activeTextEditor) {}"[..])], None, false);
        assert!(s.called.contains(&"window.showErrorMessage".to_string()));
        assert!(!s.called.contains(&"window.activeTextEditor".to_string()));
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
