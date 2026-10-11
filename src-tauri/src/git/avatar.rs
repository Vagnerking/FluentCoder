//! Avatares de autores com privacidade e cache em disco.
//!
//! Antes, todo e-mail de autor ia em claro para `unavatar.io` a cada render
//! (sem cache e sem como desligar). Agora (setting `git.avatars`):
//! - `github` (padrão): só `…@users.noreply.github.com` vira avatar do GitHub
//!   — o usuário já está no próprio e-mail; nada privado sai da máquina;
//! - `gravatar` (opt-in): além disso, consulta o Gravatar com o **SHA-256** do
//!   e-mail normalizado (`d=404`), nunca o e-mail em claro;
//! - `off`: nenhuma requisição; o frontend usa iniciais.
//!
//! O resultado (imagem ou "não tem") fica em `app_data_dir/avatars/` com TTL
//! (7 dias positivo, 1 dia negativo), downloads limitados (4 simultâneos,
//! 256 KiB, só `image/*`) e deduplicados por chave. O frontend NUNCA põe uma
//! URL externa no DOM: recebe um `data:` URL ou `null` e mostra iniciais até lá.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const POSITIVE_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
pub(crate) const NEGATIVE_TTL: Duration = Duration::from_secs(24 * 3600);
const MAX_BYTES: usize = 256 * 1024;

#[derive(Debug, PartialEq, Clone)]
pub(crate) struct AvatarSource {
    /// Chave de cache (hash; não contém o e-mail).
    pub key: String,
    pub url: String,
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Usuário de um e-mail noreply do GitHub (`123+user@…` ou `user@…`).
pub(crate) fn github_noreply_user(email: &str) -> Option<&str> {
    let local = email.strip_suffix("@users.noreply.github.com")?;
    let user = local.split_once('+').map(|(_, u)| u).unwrap_or(local);
    let valid = !user.is_empty()
        && user.len() <= 39
        && user.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    valid.then_some(user)
}

/// De onde (e se) buscar o avatar. Puro: decide a política de privacidade.
pub(crate) fn avatar_source(email: &str, mode: &str, size: u32) -> Option<AvatarSource> {
    let email = email.trim().trim_matches(|c| c == '<' || c == '>').to_ascii_lowercase();
    if email.is_empty() || mode == "off" {
        return None;
    }
    if !matches!(mode, "github" | "gravatar") {
        return None;
    }
    let size = size.clamp(16, 256);
    if let Some(user) = github_noreply_user(&email) {
        return Some(AvatarSource {
            key: format!("gh-{}-{size}", sha256_hex(user)),
            url: format!("https://avatars.githubusercontent.com/{user}?s={size}"),
        });
    }
    if mode == "gravatar" {
        let hash = sha256_hex(&email);
        return Some(AvatarSource {
            key: format!("gr-{hash}-{size}"),
            url: format!("https://www.gravatar.com/avatar/{hash}?s={size}&d=404"),
        });
    }
    None
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub(crate) struct CacheMeta {
    fetched_at: u64,
    found: bool,
    mime: String,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Entrada válida no cache: `Some(Some(data_url))`, `Some(None)` (negativo) ou
/// `None` (ausente/expirado).
pub(crate) fn read_cache(dir: &Path, key: &str, now: u64) -> Option<Option<String>> {
    let meta: CacheMeta = serde_json::from_slice(&std::fs::read(dir.join(format!("{key}.json"))).ok()?).ok()?;
    let ttl = if meta.found { POSITIVE_TTL } else { NEGATIVE_TTL };
    if now.saturating_sub(meta.fetched_at) > ttl.as_secs() {
        return None;
    }
    if !meta.found {
        return Some(None);
    }
    let bytes = std::fs::read(dir.join(format!("{key}.img"))).ok()?;
    Some(Some(data_url(&meta.mime, &bytes)))
}

pub(crate) fn write_cache(dir: &Path, key: &str, image: Option<(&str, &[u8])>, now: u64) {
    let _ = std::fs::create_dir_all(dir);
    if let Some((_, bytes)) = image {
        let _ = std::fs::write(dir.join(format!("{key}.img")), bytes);
    }
    let meta = CacheMeta {
        fetched_at: now,
        found: image.is_some(),
        mime: image.map(|(m, _)| m.to_string()).unwrap_or_default(),
    };
    if let Ok(json) = serde_json::to_vec(&meta) {
        let _ = std::fs::write(dir.join(format!("{key}.json")), json);
    }
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn key_locks() -> &'static std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default)
}

fn download_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(4))
}

async fn download(url: &str) -> Result<Option<(String, Vec<u8>)>, String> {
    let _slot = download_slots().acquire().await.map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("FluentCoder")
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !mime.starts_with("image/") || mime.contains("svg") {
        return Ok(None);
    }
    if res.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Ok(None);
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Ok(None);
    }
    Ok(Some((mime, bytes.to_vec())))
}

pub(crate) async fn resolve(cache_dir: PathBuf, email: &str, mode: &str, size: u32) -> Option<String> {
    let source = avatar_source(email, mode, size)?;
    if let Some(hit) = read_cache(&cache_dir, &source.key, now_secs()) {
        return hit;
    }
    // Uma busca por chave por vez; quem chega depois lê o cache recém-escrito.
    let lock = {
        let mut locks = key_locks().lock().unwrap_or_else(|e| e.into_inner());
        locks.entry(source.key.clone()).or_default().clone()
    };
    let _guard = lock.lock().await;
    if let Some(hit) = read_cache(&cache_dir, &source.key, now_secs()) {
        return hit;
    }
    match download(&source.url).await {
        Ok(Some((mime, bytes))) => {
            write_cache(&cache_dir, &source.key, Some((&mime, &bytes)), now_secs());
            Some(data_url(&mime, &bytes))
        }
        Ok(None) => {
            write_cache(&cache_dir, &source.key, None, now_secs());
            None
        }
        // Erro de rede: não grava (tenta de novo depois), mostra iniciais.
        Err(_) => None,
    }
}

/// Avatar do autor como `data:` URL, ou `null` para usar iniciais.
#[tauri::command]
pub async fn git_avatar(
    app: tauri::AppHandle,
    email: String,
    mode: String,
    size: Option<u32>,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("avatars");
    Ok(resolve(dir, &email, &mode, size.unwrap_or(64)).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privacy_policy_by_mode() {
        // off: nunca.
        assert_eq!(avatar_source("ana@empresa.com", "off", 64), None);
        assert_eq!(avatar_source("1+ana@users.noreply.github.com", "off", 64), None);
        // github (padrão): só noreply, e-mail comum não sai da máquina.
        assert_eq!(avatar_source("ana@empresa.com", "github", 64), None);
        let gh = avatar_source("12345+Ana-Dev@users.noreply.github.com", "github", 64).unwrap();
        assert_eq!(gh.url, "https://avatars.githubusercontent.com/ana-dev?s=64");
        assert!(!gh.key.contains("ana"));
        assert_eq!(avatar_source("ana@users.noreply.github.com", "github", 64).unwrap().url, "https://avatars.githubusercontent.com/ana?s=64");
        // gravatar (opt-in): só o SHA-256 do e-mail normalizado.
        let gr = avatar_source("  <Ana@Empresa.com> ", "gravatar", 64).unwrap();
        let hash = sha256_hex("ana@empresa.com");
        assert_eq!(gr.url, format!("https://www.gravatar.com/avatar/{hash}?s=64&d=404"));
        assert!(!gr.url.contains("empresa") && !gr.key.contains("empresa"));
        // modo desconhecido = nada.
        assert_eq!(avatar_source("ana@empresa.com", "all", 64), None);
        assert_eq!(avatar_source("", "gravatar", 64), None);
    }

    #[test]
    fn noreply_usernames_are_validated() {
        assert_eq!(github_noreply_user("1+a@users.noreply.github.com"), Some("a"));
        assert_eq!(github_noreply_user("a/../b@users.noreply.github.com"), None);
        assert_eq!(github_noreply_user("@users.noreply.github.com"), None);
    }

    #[test]
    fn disk_cache_has_positive_and_negative_ttl() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        assert_eq!(read_cache(d, "k", 1000), None);
        write_cache(d, "k", Some(("image/png", b"\x89PNG")), 1000);
        let hit = read_cache(d, "k", 1000 + 60).unwrap().unwrap();
        assert!(hit.starts_with("data:image/png;base64,"));
        assert_eq!(read_cache(d, "k", 1000 + POSITIVE_TTL.as_secs() + 1), None, "expirado");
        write_cache(d, "n", None, 1000);
        assert_eq!(read_cache(d, "n", 1000 + 10), Some(None), "negativo em cache");
        assert_eq!(read_cache(d, "n", 1000 + NEGATIVE_TTL.as_secs() + 1), None);
    }

    #[test]
    fn off_and_plain_emails_never_touch_the_network_or_disk() {
        let dir = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let got = rt.block_on(resolve(dir.path().to_path_buf(), "ana@empresa.com", "github", 64));
        assert_eq!(got, None);
        let got = rt.block_on(resolve(dir.path().to_path_buf(), "1+a@users.noreply.github.com", "off", 64));
        assert_eq!(got, None);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
