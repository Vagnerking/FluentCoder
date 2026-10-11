//! Gerenciamento de extensões VS Code: catálogo (Open VSX e compatíveis),
//! instalação/atualização/remoção numa pasta PRÓPRIA do app e
//! habilitação/portão de compatibilidade lidos pelo host Node.
//!
//! - `store.rs`   — pasta gerenciada, índice `extensions.json`, descoberta
//!   (app + `~/.vscode/extensions` somente leitura), troca atômica + rollback;
//! - `vsix.rs`    — leitura/extração segura do VSIX;
//! - `openvsx.rs` — fontes de catálogo, cliente HTTP com allowlist;
//! - `semver.rs`  — comparação de versões.
//!
//! Contratos e regras de segurança: docs/context/extensoes-vscode.md.

pub mod openvsx;
pub mod scan;
pub mod semver;
pub mod store;
pub mod vsix;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use openvsx::{Registry, Source};
use store::{Gate, InstallSource, InstalledInfo, ManagedEntry};

pub const PROGRESS_EVENT: &str = "extensions://progress";
/// Teto do download de um VSIX (o do Codex 26.x tem ~300 MB).
pub const MAX_DOWNLOAD_BYTES: u64 = 1 << 30;

static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CLEANED: OnceLock<()> = OnceLock::new();

/// `<app_data>/extensions` (ou `FLUENT_APP_EXTENSIONS_DIR`, usado em testes).
pub fn managed_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match std::env::var("FLUENT_APP_EXTENSIONS_DIR") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Falha ao obter a pasta de dados do app: {e}"))?
            .join("extensions"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Falha ao criar {}: {e}", dir.display()))?;
    CLEANED.get_or_init(|| store::cleanup_leftovers(&dir));
    Ok(dir)
}

/// Id `publisher.nome` validado e em minúsculas.
pub fn normalize_id(id: &str) -> Result<String, String> {
    let id = id.trim().to_lowercase();
    let (p, n) = id.split_once('.').ok_or_else(|| format!("id de extensão inválido: {id}"))?;
    vsix::validate_id_part(p)?;
    vsix::validate_id_part(n)?;
    Ok(id)
}

fn source_by_id(dir: &Path, id: &str) -> Result<Source, String> {
    openvsx::read_sources(dir)
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("Fonte de catálogo desconhecida: {id}"))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    id: &'a str,
    phase: &'a str,
    received: u64,
    total: Option<u64>,
}

// ------------------------------------------------------------ instalação (núcleo)

/// Resultado de uma instalação, com o que foi verificado.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub entry: ManagedEntry,
    pub sha256: String,
    pub size: u64,
    /// O SHA-256 publicado pelo catálogo bateu (false = o catálogo não publica hash).
    pub hash_verified: bool,
}

/// Baixa, verifica, extrai e indexa (atômico). Nada da extensão é executado.
pub async fn install_from_registry(
    dir: &Path,
    reg: &Registry,
    namespace: &str,
    name: &str,
    version: Option<&str>,
    allow_pre_release: bool,
    mut progress: impl FnMut(&str, u64, Option<u64>),
) -> Result<InstallOutcome, String> {
    vsix::validate_id_part(namespace)?;
    vsix::validate_id_part(name)?;
    let platform = store::host_platform();
    progress("metadata", 0, None);
    let meta = match version {
        Some(v) => reg.metadata(namespace, name, Some(v), platform).await?,
        None => reg.latest_stable(namespace, name, platform, allow_pre_release).await?,
    };
    let tp = meta.get("targetPlatform").and_then(Value::as_str).unwrap_or("universal").to_string();
    if !store::platform_matches(Some(tp.as_str()), platform) {
        return Err(format!("O catálogo só oferece este pacote para \"{tp}\" (este computador é {platform})."));
    }
    let ver = meta.get("version").and_then(Value::as_str).ok_or("metadados sem versão")?.to_string();
    let files = meta.get("files").cloned().unwrap_or(Value::Null);
    let download = files.get("download").and_then(Value::as_str).ok_or("o catálogo não publica o .vsix desta versão")?;
    let expected = match files.get("sha256").and_then(Value::as_str) {
        Some(u) => Some(reg.sha256(u).await?),
        None => None,
    };
    let staging = store::new_staging(dir)?;
    let result = async {
        let pkg_path = staging.join("package.vsix");
        progress("download", 0, None);
        let (sha, size) = reg.download(download, &pkg_path, MAX_DOWNLOAD_BYTES, |r, t| progress("download", r, t)).await?;
        if let Some(exp) = &expected {
            if exp != &sha {
                return Err(format!("O SHA-256 do pacote não confere com o do catálogo (esperado {exp}, recebido {sha}). Instalação cancelada."));
            }
        }
        progress("extract", size, Some(size));
        let req = (namespace.to_lowercase(), name.to_lowercase(), ver.clone());
        let staging2 = staging.clone();
        let tp2 = tp.clone();
        let entry = tokio::task::spawn_blocking(move || -> Result<(PathBuf, vsix::VsixInfo), String> {
            let info = vsix::inspect(std::fs::File::open(&pkg_path).map_err(|e| e.to_string())?)?;
            if info.publisher.to_lowercase() != req.0 || info.name.to_lowercase() != req.1 {
                return Err(format!("o pacote baixado é {} e não {}.{}", info.id(), req.0, req.1));
            }
            if info.version != req.2 {
                return Err(format!("o pacote baixado é a versão {} e não {}", info.version, req.2));
            }
            let pkg_tp = info.target_platform.clone().unwrap_or_else(|| "universal".into());
            if pkg_tp != tp2 && !(pkg_tp == "universal" && tp2 == "universal") {
                return Err(format!("plataforma do pacote ({pkg_tp}) difere da do catálogo ({tp2})"));
            }
            let out = staging2.join("extension");
            vsix::extract_payload(std::fs::File::open(&pkg_path).map_err(|e| e.to_string())?, &out, vsix::Limits::default())?;
            let _ = std::fs::remove_file(&pkg_path);
            Ok((out, info))
        })
        .await
        .map_err(|e| format!("tarefa de extração falhou: {e}"))??;
        let (extracted, info) = entry;
        let id = info.id();
        let tp_opt = (tp != "universal").then_some(tp.as_str());
        let managed = ManagedEntry {
            id: id.clone(),
            version: info.version.clone(),
            dir: store::folder_name(&id, &info.version, tp_opt),
            target_platform: tp.clone(),
            source: InstallSource::Registry {
                registry: reg.source.id.clone(),
                namespace: namespace.to_string(),
                name: name.to_string(),
            },
            sha256: Some(sha.clone()),
            size,
            verified: expected.is_some(),
            pre_release: meta.get("preRelease").and_then(Value::as_bool).unwrap_or(false),
            installed_at: store::now_ms(),
            enabled: true,
            gate: None,
            trust: None,
        };
        progress("commit", size, Some(size));
        let entry = store::commit_install(dir, &extracted, managed)?;
        Ok(InstallOutcome { entry, sha256: sha, size, hash_verified: expected.is_some() })
    }
    .await;
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Instala um .vsix local (sem hash de catálogo: o usuário escolheu o arquivo).
pub fn install_from_file(dir: &Path, file: &Path) -> Result<InstallOutcome, String> {
    let meta = std::fs::metadata(file).map_err(|e| format!("Falha ao ler {}: {e}", file.display()))?;
    if meta.len() > MAX_DOWNLOAD_BYTES {
        return Err("pacote grande demais".into());
    }
    let bytes_hash = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        let mut f = std::fs::File::open(file).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut h).map_err(|e| e.to_string())?;
        h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    let info = vsix::inspect(std::fs::File::open(file).map_err(|e| e.to_string())?)?;
    let platform = store::host_platform();
    if !store::platform_matches(info.target_platform.as_deref(), platform) {
        return Err(format!("Este pacote é para {} (este computador é {platform}).", info.target_platform.unwrap_or_default()));
    }
    let staging = store::new_staging(dir)?;
    let out = staging.join("extension");
    let r = (|| {
        vsix::extract_payload(std::fs::File::open(file).map_err(|e| e.to_string())?, &out, vsix::Limits::default())?;
        let id = info.id();
        let entry = ManagedEntry {
            id: id.clone(),
            version: info.version.clone(),
            dir: store::folder_name(&id, &info.version, info.target_platform.as_deref()),
            target_platform: info.target_platform.clone().unwrap_or_else(|| "universal".into()),
            source: InstallSource::Vsix,
            sha256: Some(bytes_hash.clone()),
            size: meta.len(),
            verified: false,
            pre_release: false,
            installed_at: store::now_ms(),
            enabled: true,
            gate: None,
            trust: None,
        };
        let entry = store::commit_install(dir, &out, entry)?;
        Ok(InstallOutcome { entry, sha256: bytes_hash.clone(), size: meta.len(), hash_verified: false })
    })();
    let _ = std::fs::remove_dir_all(&staging);
    r
}

/// Copia uma extensão de `~/.vscode/extensions` (a origem só é LIDA).
pub fn import_from_vscode(dir: &Path, vscode_dir: &Path, id: &str) -> Result<InstallOutcome, String> {
    let src = store::vscode_extension_path(vscode_dir, id).ok_or_else(|| format!("{id} não está instalada no VS Code."))?;
    // A origem tem de estar DENTRO da pasta do VS Code (sem links para fora).
    let (real_src, real_root) = (
        std::fs::canonicalize(&src).map_err(|e| e.to_string())?,
        std::fs::canonicalize(vscode_dir).map_err(|e| e.to_string())?,
    );
    if !real_src.starts_with(&real_root) {
        return Err("pasta da extensão fora de ~/.vscode/extensions".into());
    }
    let pkg: Value = serde_json::from_slice(&std::fs::read(real_src.join("package.json")).map_err(|e| e.to_string())?)
        .map_err(|e| format!("package.json inválido: {e}"))?;
    let version = pkg.get("version").and_then(Value::as_str).ok_or("package.json sem versão")?.to_string();
    let folder = real_src.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    let re = regex::Regex::new(r"-(win32|linux|darwin|alpine)-(x64|arm64|armhf|ia32)$").unwrap();
    let tp = re.captures(&folder).map(|c| format!("{}-{}", &c[1], &c[2]));
    let staging = store::new_staging(dir)?;
    let out = staging.join("extension");
    let r = (|| {
        let size = store::copy_tree(&real_src, &out, vsix::Limits::default())?;
        let entry = ManagedEntry {
            id: id.to_string(),
            version: version.clone(),
            dir: store::folder_name(id, &version, tp.as_deref()),
            target_platform: tp.clone().unwrap_or_else(|| "universal".into()),
            source: InstallSource::VscodeImport { from: real_src.to_string_lossy().into_owned() },
            sha256: None,
            size,
            verified: false,
            pre_release: false,
            installed_at: store::now_ms(),
            enabled: true,
            gate: None,
            trust: None,
        };
        let entry = store::commit_install(dir, &out, entry)?;
        Ok(InstallOutcome { entry, sha256: String::new(), size, hash_verified: false })
    })();
    let _ = std::fs::remove_dir_all(&staging);
    r
}

// ------------------------------------------------------------------ comandos

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPaths {
    pub managed_dir: String,
    pub vscode_dir: Option<String>,
    pub platform: &'static str,
}

#[tauri::command]
pub fn extensions_paths(app: AppHandle) -> Result<ExtensionPaths, String> {
    Ok(ExtensionPaths {
        managed_dir: managed_dir(&app)?.to_string_lossy().into_owned(),
        vscode_dir: store::vscode_extensions_dir().map(|p| p.to_string_lossy().into_owned()),
        platform: store::host_platform(),
    })
}

#[tauri::command]
pub async fn extensions_list(app: AppHandle) -> Result<Vec<InstalledInfo>, String> {
    let dir = managed_dir(&app)?;
    let vdir = store::vscode_extensions_dir();
    tokio::task::spawn_blocking(move || store::discover(&dir, vdir.as_deref())).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDetails {
    pub readme: Option<String>,
    pub changelog: Option<String>,
    pub icon: Option<String>,
    pub api_scan: store::ApiScan,
}

fn read_text_capped(path: &Path, cap: u64) -> Option<String> {
    let m = std::fs::symlink_metadata(path).ok()?;
    if !m.is_file() || m.len() > cap {
        return None;
    }
    std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn find_case_insensitive(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    let rd = std::fs::read_dir(dir).ok()?;
    let files: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    for n in names {
        if let Some(p) = files.iter().find(|p| p.file_name().map(|f| f.to_string_lossy().eq_ignore_ascii_case(n)).unwrap_or(false)) {
            return Some(p.clone());
        }
    }
    None
}

pub fn local_details(ext_dir: &Path, pkg: &Value) -> LocalDetails {
    let readme = find_case_insensitive(ext_dir, &["README.md", "readme.txt", "README"]).and_then(|p| read_text_capped(&p, 2 << 20));
    let changelog = find_case_insensitive(ext_dir, &["CHANGELOG.md", "changelog.txt"]).and_then(|p| read_text_capped(&p, 2 << 20));
    let icon = pkg
        .get("icon")
        .and_then(Value::as_str)
        .and_then(|rel| vsix::safe_relative(rel.trim_start_matches("./")).ok())
        .map(|rel| ext_dir.join(rel))
        .filter(|p| std::fs::canonicalize(p).ok().zip(std::fs::canonicalize(ext_dir).ok()).map(|(f, r)| f.starts_with(r)).unwrap_or(false))
        .and_then(|p| {
            let m = std::fs::metadata(&p).ok()?;
            if m.len() > 512 << 10 {
                return None;
            }
            let bytes = std::fs::read(&p).ok()?;
            openvsx::icon_data_uri(&bytes, None, &p.to_string_lossy())
        });
    LocalDetails { readme, changelog, icon, api_scan: store::scan_extension(ext_dir, pkg) }
}

#[tauri::command]
pub async fn extensions_local_details(app: AppHandle, id: String) -> Result<LocalDetails, String> {
    let id = normalize_id(&id)?;
    let dir = managed_dir(&app)?;
    let vdir = store::vscode_extensions_dir();
    tokio::task::spawn_blocking(move || {
        let found = store::discover(&dir, vdir.as_deref()).into_iter().find(|e| e.id == id).ok_or("extensão não encontrada")?;
        Ok(local_details(Path::new(&found.path), &found.manifest))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn extensions_sources_list(app: AppHandle) -> Result<Vec<Source>, String> {
    Ok(openvsx::read_sources(&managed_dir(&app)?))
}

#[tauri::command]
pub fn extensions_sources_save(app: AppHandle, sources: Vec<Source>) -> Result<Vec<Source>, String> {
    openvsx::write_sources(&managed_dir(&app)?, &sources)
}

#[tauri::command]
pub async fn extensions_search(app: AppHandle, source_id: String, query: String, offset: Option<u32>, size: Option<u32>) -> Result<Value, String> {
    let reg = Registry::new(source_by_id(&managed_dir(&app)?, &source_id)?)?;
    let q: String = query.chars().take(200).collect();
    reg.search(&q, offset.unwrap_or(0), size.unwrap_or(20), store::host_platform()).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDetails {
    pub metadata: Value,
    /// `package.json` da versão (para o classificador de compatibilidade).
    pub manifest: Option<Value>,
}

#[tauri::command]
pub async fn extensions_metadata(app: AppHandle, source_id: String, namespace: String, name: String, version: Option<String>, allow_pre_release: Option<bool>) -> Result<RegistryDetails, String> {
    vsix::validate_id_part(&namespace)?;
    vsix::validate_id_part(&name)?;
    let reg = Registry::new(source_by_id(&managed_dir(&app)?, &source_id)?)?;
    let platform = store::host_platform();
    let meta = match version.as_deref() {
        Some(v) => reg.metadata(&namespace, &name, Some(v), platform).await?,
        None => reg.latest_stable(&namespace, &name, platform, allow_pre_release.unwrap_or(false)).await?,
    };
    let manifest = match meta.get("files").and_then(|f| f.get("manifest")).and_then(Value::as_str) {
        Some(u) => reg.text(u).await.ok().and_then(|t| serde_json::from_str(&t).ok()),
        None => None,
    };
    Ok(RegistryDetails { metadata: openvsx::trim_metadata(&meta), manifest })
}

#[tauri::command]
pub async fn extensions_fetch_text(app: AppHandle, source_id: String, url: String) -> Result<String, String> {
    let reg = Registry::new(source_by_id(&managed_dir(&app)?, &source_id)?)?;
    reg.text(&url).await
}

#[tauri::command]
pub async fn extensions_fetch_icon(app: AppHandle, source_id: String, url: String) -> Result<String, String> {
    let reg = Registry::new(source_by_id(&managed_dir(&app)?, &source_id)?)?;
    reg.icon(&url).await
}

#[tauri::command]
pub async fn extensions_install(app: AppHandle, source_id: String, namespace: String, name: String, version: Option<String>, allow_pre_release: Option<bool>) -> Result<InstallOutcome, String> {
    let dir = managed_dir(&app)?;
    let reg = Registry::new(source_by_id(&dir, &source_id)?)?;
    let _g = INSTALL_LOCK.lock().await;
    let id = format!("{namespace}.{name}").to_lowercase();
    let app2 = app.clone();
    install_from_registry(&dir, &reg, &namespace, &name, version.as_deref(), allow_pre_release.unwrap_or(false), move |phase, received, total| {
        let _ = app2.emit(PROGRESS_EVENT, Progress { id: &id, phase, received, total });
    })
    .await
}

#[tauri::command]
pub async fn extensions_install_vsix(app: AppHandle, path: String) -> Result<InstallOutcome, String> {
    let dir = managed_dir(&app)?;
    let _g = INSTALL_LOCK.lock().await;
    tokio::task::spawn_blocking(move || install_from_file(&dir, Path::new(&path))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn extensions_import_vscode(app: AppHandle, id: String) -> Result<InstallOutcome, String> {
    let id = normalize_id(&id)?;
    let dir = managed_dir(&app)?;
    let vdir = store::vscode_extensions_dir().ok_or("pasta de extensões do VS Code não encontrada")?;
    let _g = INSTALL_LOCK.lock().await;
    tokio::task::spawn_blocking(move || import_from_vscode(&dir, &vdir, &id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn extensions_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    let id = normalize_id(&id)?;
    let dir = managed_dir(&app)?;
    let _g = INSTALL_LOCK.lock().await;
    tokio::task::spawn_blocking(move || store::uninstall(&dir, &id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn extensions_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    store::set_enabled(&managed_dir(&app)?, &normalize_id(&id)?, enabled)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateInput {
    pub verdict: String,
    pub version: String,
    pub host_version: String,
}

#[tauri::command]
pub fn extensions_set_gate(app: AppHandle, id: String, gate: GateInput) -> Result<(), String> {
    store::set_gate(
        &managed_dir(&app)?,
        &normalize_id(&id)?,
        Gate { verdict: gate.verdict, version: gate.version, host_version: gate.host_version, evaluated_at: store::now_ms() },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateBatchItem {
    pub id: String,
    pub gate: GateInput,
}

/// Vereditos em lote: uma única escrita do índice (avaliação em segundo plano da view).
#[tauri::command]
pub async fn extensions_set_gates(app: AppHandle, gates: Vec<GateBatchItem>) -> Result<(), String> {
    let dir = managed_dir(&app)?;
    let now = store::now_ms();
    let mut list = Vec::with_capacity(gates.len());
    for g in gates.into_iter().take(1000) {
        list.push((normalize_id(&g.id)?, Gate { verdict: g.gate.verdict, version: g.gate.version, host_version: g.gate.host_version, evaluated_at: now }));
    }
    tokio::task::spawn_blocking(move || store::set_gates(&dir, list)).await.map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustInput {
    pub version: String,
    pub host_version: String,
}

/// Liberação explícita (confirmada pelo usuário na view) para rodar ESTA
/// versão "Não avaliada"; `None` revoga. O host só a aceita junto com um
/// portão `unknown` da mesma versão e da mesma API do shim.
#[tauri::command]
pub fn extensions_set_trust(app: AppHandle, id: String, trust: Option<TrustInput>) -> Result<(), String> {
    store::set_trust(
        &managed_dir(&app)?,
        &normalize_id(&id)?,
        trust.map(|t| store::Trust { version: t.version, host_version: t.host_version, granted_at: store::now_ms() }),
    )
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub id: String,
    pub current: String,
    pub latest: String,
    pub source_id: String,
    pub namespace: String,
    pub name: String,
    pub pre_release: bool,
}

/// Atualizações das extensões gerenciadas vindas de um catálogo.
#[tauri::command]
pub async fn extensions_check_updates(app: AppHandle) -> Result<Vec<UpdateInfo>, String> {
    let dir = managed_dir(&app)?;
    check_updates(&dir).await
}

pub async fn check_updates(dir: &Path) -> Result<Vec<UpdateInfo>, String> {
    let index = store::read_index(dir);
    let sources = openvsx::read_sources(dir);
    let platform = store::host_platform();
    let mut out = Vec::new();
    for e in index.extensions.values() {
        let InstallSource::Registry { registry, namespace, name } = &e.source else { continue };
        let Some(src) = sources.iter().find(|s| &s.id == registry && s.enabled) else { continue };
        let Ok(reg) = Registry::new(src.clone()) else { continue };
        let Ok(meta) = reg.latest_stable(namespace, name, platform, e.pre_release).await else { continue };
        let Some(latest) = meta.get("version").and_then(Value::as_str) else { continue };
        if semver::compare(latest, &e.version) == std::cmp::Ordering::Greater {
            out.push(UpdateInfo {
                id: e.id.clone(),
                current: e.version.clone(),
                latest: latest.to_string(),
                source_id: registry.clone(),
                namespace: namespace.clone(),
                name: name.clone(),
                pre_release: meta.get("preRelease").and_then(Value::as_bool).unwrap_or(false),
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::vsix::tests::{fixture_vsix, tmpdir};

    #[test]
    fn install_local_vsix_end_to_end() {
        let dir = tmpdir("local");
        let file = dir.join("demo.vsix");
        std::fs::write(&file, fixture_vsix("Acme", "demo", "2.0.0", None)).unwrap();
        let out = install_from_file(&dir, &file).unwrap();
        assert_eq!(out.entry.id, "acme.demo");
        assert_eq!(out.entry.dir, "acme.demo-2.0.0");
        assert_eq!(out.sha256.len(), 64);
        let found = store::discover(&dir, None);
        assert_eq!(found.len(), 1);
        let det = local_details(Path::new(&found[0].path), &found[0].manifest);
        assert!(det.readme.unwrap().contains("Fixture"));
        assert_eq!(det.api_scan.bindings, 1);
        assert!(det.api_scan.paths.iter().any(|(p, _)| p == "window.showInformationMessage"));
        // pacote de outra plataforma é recusado
        let other = if store::host_platform() == "darwin-arm64" { "linux-x64" } else { "darwin-arm64" };
        std::fs::write(&file, fixture_vsix("acme", "plat", "1.0.0", Some(other))).unwrap();
        assert!(install_from_file(&dir, &file).is_err());
        assert!(!dir.join(".staging").read_dir().map(|mut d| d.next().is_some()).unwrap_or(false), "staging limpo");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn import_copies_without_touching_source() {
        let dir = tmpdir("imp");
        let vdir = tmpdir("impv");
        vsix::extract_payload(std::io::Cursor::new(fixture_vsix("acme", "tool", "1.0.0", None)), &vdir.join("acme.tool-1.0.0"), vsix::Limits::default()).unwrap();
        let before: Vec<_> = std::fs::read_dir(vdir.join("acme.tool-1.0.0")).unwrap().flatten().map(|e| e.file_name()).collect();
        let out = import_from_vscode(&dir, &vdir, "acme.tool").unwrap();
        assert!(matches!(out.entry.source, InstallSource::VscodeImport { .. }));
        let after: Vec<_> = std::fs::read_dir(vdir.join("acme.tool-1.0.0")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(before, after);
        let found = store::discover(&dir, Some(&vdir));
        assert_eq!(found.iter().find(|f| f.id == "acme.tool").unwrap().location, "app");
        assert!(import_from_vscode(&dir, &vdir, "acme.missing").is_err());
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(vdir).unwrap();
    }

    #[test]
    fn ids_normalized() {
        assert_eq!(normalize_id("Anthropic.Claude-Code").unwrap(), "anthropic.claude-code");
        assert!(normalize_id("nodot").is_err());
        assert!(normalize_id("../x.y").is_err());
    }

    /// Instalação REAL de uma extensão pequena do Open VSX numa pasta
    /// temporária (rede). `cargo test --lib real_openvsx_install -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_openvsx_install() {
        let ns = std::env::var("FLUENT_OVSX_NS").unwrap_or_else(|_| "wayou".into());
        let name = std::env::var("FLUENT_OVSX_NAME").unwrap_or_else(|_| "vscode-todo-highlight".into());
        let dir = tmpdir("real");
        let reg = Registry::new(openvsx::default_sources().remove(0)).unwrap();
        let mut phases = Vec::new();
        let out = install_from_registry(&dir, &reg, &ns, &name, None, false, |p, _, _| {
            if phases.last().map(|l: &String| l != p).unwrap_or(true) {
                phases.push(p.to_string());
            }
        })
        .await
        .unwrap();
        println!("instalada: {} {} em {}", out.entry.id, out.entry.version, dir.join(&out.entry.dir).display());
        println!("sha256 {} ({} bytes) · hash do catálogo conferido: {}", out.sha256, out.size, out.hash_verified);
        println!("fases: {}", phases.join(" → "));
        assert!(out.hash_verified);
        let found = store::discover(&dir, None);
        assert_eq!(found.len(), 1);
        println!("descoberta (Rust): {} {} location={} enabled={}", found[0].id, found[0].version, found[0].location, found[0].enabled);
        let det = local_details(Path::new(&found[0].path), &found[0].manifest);
        println!("api scan: {} binding(s), {} caminho(s): {:?}", det.api_scan.bindings, det.api_scan.paths.len(), det.api_scan.paths.iter().take(12).collect::<Vec<_>>());
        if let Ok(keep) = std::env::var("FLUENT_OVSX_KEEP") {
            // Copia o índice + pasta para o harness do host Node conferir a descoberta.
            let dest = PathBuf::from(keep);
            let _ = std::fs::remove_dir_all(&dest);
            store::copy_tree(&dir, &dest, vsix::Limits::default()).unwrap();
            println!("cópia para o host Node: {}", dest.display());
        }
        let updates = check_updates(&dir).await.unwrap();
        println!("atualizações: {}", updates.len());
        store::uninstall(&dir, &out.entry.id).unwrap();
        assert!(store::discover(&dir, None).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
        println!("removida e pasta temporária apagada");
    }
}
