//! Arquivos do sistema de configurações (settings estilo VS Code).
//!
//! O Rust só faz E/S: localizar `<app_config>/User/{settings,keybindings}.json`,
//! ler/gravar os arquivos de configuração (JSONC) de forma atômica, observar
//! mudanças (para recarregar quando o arquivo é editado fora da UI) e devolver a
//! cadeia de `.editorconfig` de um arquivo. O parse JSONC, a precedência das
//! camadas e a resolução do EditorConfig ficam no TS (`src/settings/`), puros e
//! testáveis — ver `docs/context/configuracoes.md`.
//!
//! Segurança: leitura/escrita só de nomes de arquivo de configuração
//! conhecidos (`settings.json`, `keybindings.json`, `.vscode/*.json`,
//! `*.code-workspace`, `*.fluent-workspace`, `.editorconfig`). Nunca escreve no
//! `~/.vscode` (o perfil do VS Code do usuário).

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Caminhos do perfil de configuração do app.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPaths {
    pub user_dir: String,
    pub user_settings: String,
    pub user_keybindings: String,
    /// Overrides antigos do host de extensões (migrados para o User settings).
    pub legacy_ext_host_settings: String,
}

fn user_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Sem diretório de configuração do app: {e}"))?;
    Ok(dir.join("User"))
}

#[tauri::command]
pub fn settings_paths(app: AppHandle) -> Result<SettingsPaths, String> {
    let dir = user_dir(&app)?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Sem diretório de dados do app: {e}"))?;
    Ok(SettingsPaths {
        user_dir: dir.to_string_lossy().into_owned(),
        user_settings: dir.join("settings.json").to_string_lossy().into_owned(),
        user_keybindings: dir.join("keybindings.json").to_string_lossy().into_owned(),
        legacy_ext_host_settings: data
            .join("ext-host")
            .join("settings.json")
            .to_string_lossy()
            .into_owned(),
    })
}

/// O caminho é de um arquivo de configuração que o app pode ler/gravar?
pub(crate) fn is_settings_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    if lower == ".editorconfig"
        || lower.ends_with(".code-workspace")
        || lower.ends_with(".fluent-workspace")
    {
        return true;
    }
    if !matches!(
        lower.as_str(),
        "settings.json" | "keybindings.json" | "extensions.json" | "launch.json" | "tasks.json"
    ) {
        return false;
    }
    // `settings.json`/`keybindings.json` também vivem no perfil (`User/`).
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("");
    matches!(parent, ".vscode" | ".fluent" | "User" | "ext-host")
}

/// Nunca tocar no perfil real do VS Code (`~/.vscode`, `…/Code/User`).
fn is_vscode_profile(path: &Path) -> bool {
    let s = path.to_string_lossy().replace('\\', "/");
    let lower = s.to_ascii_lowercase();
    lower.contains("/code/user/")
        || lower.contains("/code - insiders/user/")
        || lower.contains("/.vscode/extensions/")
        || dirs_home()
            .map(|h| {
                let h = h.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
                lower.starts_with(&format!("{h}/.vscode/"))
            })
            .unwrap_or(false)
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn check_path(path: &str, write: bool) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(format!("Caminho de configuração não é absoluto: {path}"));
    }
    if !is_settings_file(&p) {
        return Err(format!("Não é um arquivo de configuração: {path}"));
    }
    if write && is_vscode_profile(&p) {
        return Err("O perfil do VS Code do usuário nunca é alterado.".into());
    }
    Ok(p)
}

/// Lê vários arquivos de configuração; ausentes voltam `null`.
#[tauri::command]
pub async fn settings_read_files(paths: Vec<String>) -> Result<HashMap<String, Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = HashMap::new();
        for path in paths {
            let content = match check_path(&path, false) {
                Ok(p) => read_text(&p),
                Err(_) => None,
            };
            out.insert(path, content);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_text(p: &Path) -> Option<String> {
    let bytes = std::fs::read(p).ok()?;
    // Tolera BOM UTF-8 (settings.json salvo pelo Notepad).
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&bytes);
    Some(String::from_utf8_lossy(bytes).into_owned())
}

/// Grava um arquivo de configuração de forma atômica (tmp + rename), criando
/// as pastas (`.fluent/`, `User/`) quando preciso.
#[tauri::command]
pub async fn settings_write_file(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = check_path(&path, true)?;
        write_atomic(&p, &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn write_atomic(p: &Path, content: &str) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Não foi possível criar {}: {e}", dir.display()))?;
    }
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("settings");
    let tmp = p.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, content).map_err(|e| format!("Não foi possível gravar {}: {e}", p.display()))?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Não foi possível gravar {}: {e}", p.display())
    })
}

/// Renomeia o settings antigo do host de extensões para `.bak` depois de migrado.
#[tauri::command]
pub fn settings_retire_legacy(app: AppHandle) -> Result<(), String> {
    let p = settings_paths(app)?.legacy_ext_host_settings;
    let p = PathBuf::from(p);
    if p.exists() {
        std::fs::rename(&p, p.with_extension("json.bak")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Um `.editorconfig` da cadeia (do mais próximo da raiz para o mais próximo do arquivo).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfigFile {
    pub dir: String,
    pub content: String,
}

/// Cadeia de `.editorconfig` que governa `file`: sobe até a raiz do disco ou
/// até um arquivo com `root = true`. Ordem: raiz → pasta do arquivo (o último
/// vence, como na spec).
pub(crate) fn editorconfig_chain_impl(file: &Path) -> Vec<EditorConfigFile> {
    let mut out = Vec::new();
    let mut dir = file.parent();
    let mut depth = 0;
    while let Some(d) = dir {
        depth += 1;
        if depth > 64 {
            break;
        }
        let candidate = d.join(".editorconfig");
        if let Some(content) = read_text(&candidate) {
            let is_root = declares_root(&content);
            out.push(EditorConfigFile {
                dir: d.to_string_lossy().into_owned(),
                content,
            });
            if is_root {
                break;
            }
        }
        dir = d.parent();
    }
    out.reverse();
    out
}

/// `root = true` no preâmbulo (antes da primeira seção).
fn declares_root(content: &str) -> bool {
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            return false;
        }
        if let Some((k, v)) = t.split_once('=') {
            if k.trim().eq_ignore_ascii_case("root") && v.trim().eq_ignore_ascii_case("true") {
                return true;
            }
        }
    }
    false
}

#[tauri::command]
pub async fn editorconfig_chain(path: String) -> Result<Vec<EditorConfigFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.is_absolute() {
            return Ok(Vec::new());
        }
        Ok(editorconfig_chain_impl(&p))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Watchers por janela (cada janela observa as camadas do próprio workspace).
#[derive(Default)]
pub struct SettingsWatchState {
    watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
}

impl SettingsWatchState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Serialize, Clone)]
struct SettingsChanged {
    paths: Vec<String>,
}

/// Pastas a observar para um conjunto de arquivos: a pasta de cada arquivo ou,
/// se ainda não existe (`.fluent/` antes da 1ª gravação), o ancestral mais
/// próximo que existe. Não recursivo — barato mesmo em árvores enormes.
pub(crate) fn watch_dirs(paths: &[String]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for path in paths {
        let mut dir = Path::new(path).parent().map(Path::to_path_buf);
        while let Some(d) = dir.clone() {
            if d.is_dir() {
                break;
            }
            dir = d.parent().map(Path::to_path_buf);
        }
        if let Some(d) = dir {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    dirs
}

/// Observa os arquivos de configuração da janela (substitui o conjunto anterior).
/// Emite `settings://changed` só para a janela que pediu.
#[tauri::command]
pub fn settings_watch(
    app: AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, SettingsWatchState>,
    paths: Vec<String>,
) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};
    let label = window.label().to_string();
    let wanted: Vec<String> = paths
        .into_iter()
        .filter(|p| is_settings_file(Path::new(p)))
        .collect();
    let names: Vec<PathBuf> = wanted.iter().map(PathBuf::from).collect();
    let target = label.clone();
    let app2 = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if matches!(ev.kind, notify::EventKind::Access(_)) {
            return;
        }
        // Mudança num arquivo observado OU criação de pasta no caminho (`.fluent/`).
        let hit: Vec<String> = ev
            .paths
            .iter()
            .filter(|p| names.iter().any(|n| n == *p || n.starts_with(p)))
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        if !hit.is_empty() {
            let _ = app2.emit_to(target.as_str(), "settings://changed", SettingsChanged { paths: hit });
        }
    })
    .map_err(|e| e.to_string())?;
    for dir in watch_dirs(&wanted) {
        let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
    }
    state
        .watchers
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label, watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_settings_files_are_accepted() {
        assert!(is_settings_file(Path::new("/w/.vscode/settings.json")));
        assert!(is_settings_file(Path::new("/w/.fluent/settings.json")));
        assert!(is_settings_file(Path::new("/cfg/User/keybindings.json")));
        assert!(is_settings_file(Path::new("/w/.vscode/launch.json")));
        assert!(is_settings_file(Path::new("/w/x.code-workspace")));
        assert!(is_settings_file(Path::new("/w/x.fluent-workspace")));
        assert!(is_settings_file(Path::new("/w/sub/.editorconfig")));
        assert!(!is_settings_file(Path::new("/w/src/settings.json")));
        assert!(!is_settings_file(Path::new("/etc/passwd")));
        assert!(!is_settings_file(Path::new("/w/package.json")));
    }

    #[test]
    fn refuses_writes_to_the_vscode_profile() {
        assert!(is_vscode_profile(Path::new("/home/u/.config/Code/User/settings.json")));
        assert!(check_path("/home/u/.config/Code/User/settings.json", true).is_err());
        assert!(check_path("relative/.vscode/settings.json", false).is_err());
    }

    #[test]
    fn atomic_write_creates_parent_dirs_and_replaces() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join(".fluent").join("settings.json");
        write_atomic(&p, "{\n  // c\n}\n").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\n  // c\n}\n");
        write_atomic(&p, "{}").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{}");
        // Nenhum .tmp sobrando.
        let left: Vec<_> = std::fs::read_dir(p.parent().unwrap()).unwrap().collect();
        assert_eq!(left.len(), 1);
    }

    #[test]
    fn editorconfig_chain_stops_at_root_true() {
        let tmp = tempfile::tempdir().unwrap();
        let outer = tmp.path().join("outer");
        let proj = outer.join("proj");
        let src = proj.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(outer.join(".editorconfig"), "[*]\nindent_size = 8\n").unwrap();
        std::fs::write(proj.join(".editorconfig"), "root = true\n[*]\nindent_size = 2\n").unwrap();
        std::fs::write(src.join(".editorconfig"), "[*.cs]\nindent_size = 4\n").unwrap();
        let chain = editorconfig_chain_impl(&src.join("a.cs"));
        assert_eq!(chain.len(), 2, "não sobe além do root = true");
        assert!(chain[0].dir.ends_with("proj"));
        assert!(chain[1].dir.ends_with("src"));
    }

    #[test]
    fn root_declaration_only_counts_in_the_preamble() {
        assert!(declares_root("root = true\n[*]\n"));
        assert!(declares_root("# c\nROOT=TRUE\n"));
        assert!(!declares_root("[*]\nroot = true\n"));
    }

    #[test]
    fn watch_dirs_fall_back_to_existing_ancestor() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join(".fluent").join("settings.json");
        let dirs = watch_dirs(&[missing.to_string_lossy().into_owned()]);
        assert_eq!(dirs, vec![tmp.path().to_path_buf()]);
    }
}
