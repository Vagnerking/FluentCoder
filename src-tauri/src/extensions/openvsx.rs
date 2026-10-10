//! Catálogos compatíveis com Open VSX (https://open-vsx.org/api).
//!
//! Endpoints usados (verificados em 10/10/2026 contra open-vsx.org):
//! - `GET {api}/-/search?query=&offset=&size=&targetPlatform=` → `{extensions, offset, totalSize}`
//! - `GET {api}/{ns}/{name}/{plataforma}/latest` (404 se só houver universal)
//! - `GET {api}/{ns}/{name}/latest` / `{api}/{ns}/{name}/{versão}` → metadados com
//!   `files.{download, sha256, manifest, readme, changelog, icon}`, `engines`,
//!   `targetPlatform`, `preRelease`, `verified`, `allVersions`
//! - `GET {api}/-/query?extensionId=&targetPlatform=&includeAllVersions=true`
//!   → todas as versões (com `preRelease`), para achar a última ESTÁVEL
//! - `files.sha256` → texto com o hex do SHA-256 do .vsix
//! - downloads redirecionam (302) para `openvsx.eclipsecontent.org`.
//!
//! Segurança: só HTTPS; todo pedido (e todo redirecionamento) tem de cair num
//! host da allowlist = hosts das fontes configuradas (+ os hosts de conteúdo
//! declarados por elas). Respostas têm teto de tamanho.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SOURCES_FILE: &str = "sources.json";
pub const OPEN_VSX_ID: &str = "open-vsx";
const JSON_CAP: usize = 16 << 20;
const TEXT_CAP: usize = 2 << 20;
const ICON_CAP: usize = 512 << 10;
const USER_AGENT: &str = concat!("FluentCoder/", env!("CARGO_PKG_VERSION"), " (+extensions)");

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub label: String,
    /// Base da API (ex.: `https://open-vsx.org/api`), sem barra final.
    pub url: String,
    /// Hosts extras para onde o registro redireciona downloads (CDN).
    #[serde(default)]
    pub content_hosts: Vec<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Fonte padrão (não pode ser removida, só desabilitada).
    #[serde(default)]
    pub builtin: bool,
}

fn yes() -> bool {
    true
}

pub fn default_sources() -> Vec<Source> {
    vec![Source {
        id: OPEN_VSX_ID.into(),
        label: "Open VSX".into(),
        url: "https://open-vsx.org/api".into(),
        content_hosts: vec!["openvsx.eclipsecontent.org".into()],
        enabled: true,
        builtin: true,
    }]
}

/// Normaliza e valida a URL de uma fonte: só `https://host[:porta]/caminho`,
/// sem credenciais, query ou fragmento.
pub fn normalize_source_url(raw: &str) -> Result<String, String> {
    let s = raw.trim().trim_end_matches('/');
    let rest = s
        .strip_prefix("https://")
        .ok_or("A fonte precisa usar HTTPS (https://…).")?;
    if s.contains('?') || s.contains('#') || s.contains('@') || s.contains(char::is_whitespace) || s.contains('\\') {
        return Err("URL de fonte inválida: sem credenciais, query ou fragmento.".into());
    }
    let host = rest.split('/').next().unwrap_or("");
    let hostname = host.split(':').next().unwrap_or("");
    if hostname.is_empty() || !hostname.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') || !hostname.contains('.') {
        return Err("URL de fonte inválida: host ausente ou malformado.".into());
    }
    if rest.split('/').skip(1).any(|seg| seg == ".." || seg == ".") {
        return Err("URL de fonte inválida.".into());
    }
    Ok(s.to_string())
}

pub fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    if host.contains('@') {
        return None;
    }
    Some(host.split(':').next()?.to_ascii_lowercase())
}

pub fn read_sources(dir: &Path) -> Vec<Source> {
    let mut list: Vec<Source> = std::fs::read(dir.join(SOURCES_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // A padrão sempre existe (pode estar desabilitada).
    for d in default_sources() {
        match list.iter_mut().find(|s| s.id == d.id) {
            Some(s) => {
                s.url = d.url.clone();
                s.content_hosts = d.content_hosts.clone();
                s.builtin = true;
            }
            None => list.insert(0, d),
        }
    }
    list.retain(|s| normalize_source_url(&s.url).is_ok());
    list
}

pub fn write_sources(dir: &Path, sources: &[Source]) -> Result<Vec<Source>, String> {
    let mut clean: Vec<Source> = Vec::new();
    for s in sources {
        let url = normalize_source_url(&s.url)?;
        let id = if s.id.trim().is_empty() { host_of(&url).unwrap_or_default() } else { s.id.trim().to_string() };
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_') || id.is_empty() {
            return Err(format!("id de fonte inválido: {id:?}"));
        }
        if clean.iter().any(|c| c.id == id) {
            continue;
        }
        let content_hosts = s
            .content_hosts
            .iter()
            .map(|h| h.trim().to_ascii_lowercase())
            .filter(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') && h.contains('.'))
            .collect();
        clean.push(Source {
            id,
            label: if s.label.trim().is_empty() { host_of(&url).unwrap_or_default() } else { s.label.trim().chars().take(80).collect() },
            url,
            content_hosts,
            enabled: s.enabled,
            builtin: false,
        });
    }
    // A padrão não pode ser removida: volta (desabilitada se o usuário a tirou).
    for d in default_sources() {
        if let Some(c) = clean.iter_mut().find(|c| c.id == d.id) {
            c.url = d.url.clone();
            c.content_hosts = d.content_hosts.clone();
            c.builtin = true;
        } else {
            clean.insert(0, Source { enabled: false, ..d });
        }
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{SOURCES_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(&clean).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(SOURCES_FILE)).map_err(|e| e.to_string())?;
    Ok(clean)
}

/// Hosts permitidos para uma fonte (API + conteúdo).
pub fn allowed_hosts(source: &Source) -> Vec<String> {
    let mut hosts: Vec<String> = host_of(&source.url).into_iter().collect();
    hosts.extend(source.content_hosts.iter().cloned());
    hosts
}

pub fn url_allowed(url: &str, hosts: &[String]) -> bool {
    url.starts_with("https://") && host_of(url).map(|h| hosts.iter().any(|a| a == &h)).unwrap_or(false)
}

/// Cliente HTTP preso à allowlist: HTTPS only e redirecionamentos (≤ 5) só
/// para hosts permitidos.
pub fn client(hosts: Vec<String>, timeout: Duration) -> Result<reqwest::Client, String> {
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("redirecionamentos demais");
        }
        let u = attempt.url().as_str().to_string();
        if url_allowed(&u, &hosts) {
            attempt.follow()
        } else {
            attempt.error(format!("redirecionamento para host fora da allowlist: {}", host_of(&u).unwrap_or_default()))
        }
    });
    reqwest::Client::builder()
        .https_only(true)
        .redirect(policy)
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

pub struct Registry {
    pub source: Source,
    client: reqwest::Client,
}

#[derive(Debug)]
pub enum FetchError {
    NotFound,
    Other(String),
}

impl From<FetchError> for String {
    fn from(e: FetchError) -> String {
        match e {
            FetchError::NotFound => "não encontrado no catálogo".into(),
            FetchError::Other(s) => s,
        }
    }
}

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl Registry {
    pub fn new(source: Source) -> Result<Self, String> {
        if !source.enabled {
            return Err(format!("A fonte \"{}\" está desabilitada.", source.label));
        }
        let client = client(allowed_hosts(&source), Duration::from_secs(60))?;
        Ok(Self { source, client })
    }

    pub fn hosts(&self) -> Vec<String> {
        allowed_hosts(&self.source)
    }

    async fn get_bytes(&self, url: &str, cap: usize) -> Result<(Vec<u8>, Option<String>), FetchError> {
        if !url_allowed(url, &self.hosts()) {
            return Err(FetchError::Other(format!("host fora da allowlist: {}", host_of(url).unwrap_or_default())));
        }
        let mut resp = self.client.get(url).send().await.map_err(|e| FetchError::Other(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(FetchError::NotFound);
        }
        if !resp.status().is_success() {
            return Err(FetchError::Other(format!("HTTP {}", resp.status())));
        }
        if resp.content_length().map(|l| l as usize > cap).unwrap_or(false) {
            return Err(FetchError::Other("resposta grande demais".into()));
        }
        let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
        let mut buf = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| FetchError::Other(e.to_string()))? {
            if buf.len() + chunk.len() > cap {
                return Err(FetchError::Other("resposta grande demais".into()));
            }
            buf.extend_from_slice(&chunk);
        }
        Ok((buf, ctype))
    }

    pub async fn get_json(&self, url: &str) -> Result<Value, FetchError> {
        let (b, _) = self.get_bytes(url, JSON_CAP).await?;
        let v: Value = serde_json::from_slice(&b).map_err(|e| FetchError::Other(format!("JSON inválido do catálogo: {e}")))?;
        // O Open VSX devolve `{error: "..."}` com 200 em alguns casos.
        if let Some(err) = v.get("error").and_then(Value::as_str) {
            if err.to_lowercase().contains("not found") {
                return Err(FetchError::NotFound);
            }
            return Err(FetchError::Other(err.to_string()));
        }
        Ok(v)
    }

    pub async fn search(&self, query: &str, offset: u32, size: u32, platform: &str) -> Result<Value, String> {
        let url = format!(
            "{}/-/search?query={}&offset={}&size={}&targetPlatform={}&includeAllVersions=false",
            self.source.url,
            enc(query),
            offset,
            size.clamp(1, 50),
            enc(platform)
        );
        let v = self.get_json(&url).await?;
        let list = v.get("extensions").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(serde_json::json!({
            "offset": v.get("offset").cloned().unwrap_or(Value::from(offset)),
            "totalSize": v.get("totalSize").cloned().unwrap_or(Value::from(list.len())),
            "extensions": list.iter().map(trim_summary).collect::<Vec<_>>(),
        }))
    }

    /// Metadados de uma versão (ou da última) PARA ESTA PLATAFORMA: tenta o
    /// pacote da plataforma e cai no universal.
    pub async fn metadata(&self, ns: &str, name: &str, version: Option<&str>, platform: &str) -> Result<Value, String> {
        let v = version.unwrap_or("latest");
        let base = format!("{}/{}/{}", self.source.url, enc(ns), enc(name));
        match self.get_json(&format!("{base}/{}/{}", enc(platform), enc(v))).await {
            Ok(m) => return Ok(m),
            Err(FetchError::NotFound) => {}
            Err(e) => return Err(e.into()),
        }
        match self.get_json(&format!("{base}/universal/{}", enc(v))).await {
            Ok(m) => return Ok(m),
            Err(FetchError::NotFound) => {}
            Err(e) => return Err(e.into()),
        }
        Ok(self.get_json(&format!("{base}/{}", enc(v))).await?)
    }

    /// Última versão ESTÁVEL para a plataforma (o `latest` do Open VSX pode
    /// ser pré-lançamento, ex.: Codex).
    pub async fn latest_stable(&self, ns: &str, name: &str, platform: &str, allow_pre: bool) -> Result<Value, String> {
        let latest = self.metadata(ns, name, None, platform).await?;
        if allow_pre || !latest.get("preRelease").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(latest);
        }
        let url = format!(
            "{}/-/query?extensionId={}&targetPlatform={}&includeAllVersions=true&size=200",
            self.source.url,
            enc(&format!("{ns}.{name}")),
            enc(platform)
        );
        let all = self.get_json(&url).await?;
        let best = all
            .get("extensions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|e| !e.get("preRelease").and_then(Value::as_bool).unwrap_or(false))
            .filter(|e| {
                let tp = e.get("targetPlatform").and_then(Value::as_str);
                super::store::platform_matches(tp, platform)
            })
            .max_by(|a, b| {
                let va = a.get("version").and_then(Value::as_str).unwrap_or("0.0.0");
                let vb = b.get("version").and_then(Value::as_str).unwrap_or("0.0.0");
                super::semver::compare(va, vb)
            })
            .cloned();
        Ok(best.unwrap_or(latest))
    }

    pub async fn text(&self, url: &str) -> Result<String, String> {
        let (b, _) = self.get_bytes(url, TEXT_CAP).await?;
        Ok(String::from_utf8_lossy(&b).into_owned())
    }

    /// Ícone como `data:` URI (png/jpeg/gif/webp/svg, ≤ 512 KB).
    pub async fn icon(&self, url: &str) -> Result<String, String> {
        let (b, ctype) = self.get_bytes(url, ICON_CAP).await?;
        Ok(icon_data_uri(&b, ctype.as_deref(), url).ok_or("formato de ícone não suportado")?)
    }

    /// SHA-256 publicado (`files.sha256`): 64 hex no início do texto.
    pub async fn sha256(&self, url: &str) -> Result<String, String> {
        let (b, _) = self.get_bytes(url, 4096).await?;
        parse_sha256(&String::from_utf8_lossy(&b)).ok_or_else(|| "hash SHA-256 do catálogo malformado".into())
    }

    /// Baixa o VSIX para `dest`, calculando o SHA-256 em streaming, com teto.
    pub async fn download(&self, url: &str, dest: &Path, cap: u64, mut progress: impl FnMut(u64, Option<u64>)) -> Result<(String, u64), String> {
        use sha2::{Digest, Sha256};
        use std::io::Write;
        if !url_allowed(url, &self.hosts()) {
            return Err(format!("download fora da allowlist: {}", host_of(url).unwrap_or_default()));
        }
        let dl = client(self.hosts(), Duration::from_secs(30 * 60))?;
        let mut resp = dl.get(url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {} ao baixar o pacote", resp.status()));
        }
        let total = resp.content_length();
        if total.map(|t| t > cap).unwrap_or(false) {
            return Err("pacote grande demais".into());
        }
        let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut got: u64 = 0;
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            got += chunk.len() as u64;
            if got > cap {
                return Err("pacote grande demais".into());
            }
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            progress(got, total);
        }
        file.sync_all().map_err(|e| e.to_string())?;
        if let Some(t) = total {
            if t != got {
                return Err(format!("download incompleto ({got} de {t} bytes)"));
            }
        }
        let hex = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        Ok((hex, got))
    }
}

pub fn parse_sha256(text: &str) -> Option<String> {
    let t = text.trim();
    let h: String = t.chars().take(64).collect();
    (h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())).then(|| h.to_ascii_lowercase())
}

pub fn icon_data_uri(bytes: &[u8], ctype: Option<&str>, url: &str) -> Option<String> {
    use base64::Engine;
    let lower = url.to_ascii_lowercase();
    let mime = match ctype.map(|c| c.split(';').next().unwrap_or("").trim().to_ascii_lowercase()) {
        Some(c) if ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"].contains(&c.as_str()) => c,
        _ if bytes.starts_with(b"\x89PNG") => "image/png".into(),
        _ if bytes.starts_with(b"\xFF\xD8") => "image/jpeg".into(),
        _ if bytes.starts_with(b"GIF8") => "image/gif".into(),
        _ if lower.ends_with(".svg") => "image/svg+xml".into(),
        _ => return None,
    };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Campos que a UI usa de um resultado de busca.
pub fn trim_summary(e: &Value) -> Value {
    let pick = |k: &str| e.get(k).cloned().unwrap_or(Value::Null);
    let files = e.get("files").cloned().unwrap_or(Value::Null);
    serde_json::json!({
        "namespace": pick("namespace"),
        "name": pick("name"),
        "version": pick("version"),
        "displayName": pick("displayName"),
        "description": pick("description"),
        "verified": pick("verified"),
        "deprecated": pick("deprecated"),
        "downloadCount": pick("downloadCount"),
        "averageRating": pick("averageRating"),
        "timestamp": pick("timestamp"),
        "targetPlatform": pick("targetPlatform"),
        "iconUrl": files.get("icon").cloned().unwrap_or(Value::Null),
    })
}

/// Campos que a UI usa dos metadados de uma versão.
pub fn trim_metadata(e: &Value) -> Value {
    let pick = |k: &str| e.get(k).cloned().unwrap_or(Value::Null);
    let files = e.get("files").cloned().unwrap_or(Value::Null);
    let f = |k: &str| files.get(k).cloned().unwrap_or(Value::Null);
    let versions: Vec<Value> = e
        .get("allVersions")
        .and_then(Value::as_object)
        .map(|m| m.keys().filter(|k| k.as_str() != "latest" && k.as_str() != "pre-release").take(50).map(|k| Value::from(k.as_str())).collect())
        .unwrap_or_default();
    serde_json::json!({
        "namespace": pick("namespace"),
        "name": pick("name"),
        "version": pick("version"),
        "displayName": pick("displayName"),
        "description": pick("description"),
        "namespaceDisplayName": pick("namespaceDisplayName"),
        "verified": pick("verified"),
        "unrelatedPublisher": pick("unrelatedPublisher"),
        "deprecated": pick("deprecated"),
        "preRelease": pick("preRelease"),
        "targetPlatform": pick("targetPlatform"),
        "engines": pick("engines"),
        "dependencies": pick("dependencies"),
        "bundledExtensions": pick("bundledExtensions"),
        "categories": pick("categories"),
        "license": pick("license"),
        "homepage": pick("homepage"),
        "repository": pick("repository"),
        "downloadCount": pick("downloadCount"),
        "averageRating": pick("averageRating"),
        "timestamp": pick("timestamp"),
        "files": {
            "download": f("download"), "sha256": f("sha256"), "manifest": f("manifest"),
            "readme": f("readme"), "changelog": f("changelog"), "icon": f("icon"),
        },
        "versions": versions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_urls() {
        assert_eq!(normalize_source_url("https://open-vsx.org/api/").unwrap(), "https://open-vsx.org/api");
        assert!(normalize_source_url("http://open-vsx.org/api").is_err());
        assert!(normalize_source_url("https://user:pw@evil.com/api").is_err());
        assert!(normalize_source_url("https://evil.com/api?x=1").is_err());
        assert!(normalize_source_url("https:///api").is_err());
        assert!(normalize_source_url("https://localhost/api").is_err());
        assert!(normalize_source_url("file:///etc").is_err());
        assert_eq!(host_of("https://Open-VSX.org:443/api").as_deref(), Some("open-vsx.org"));
    }

    #[test]
    fn allowlist() {
        let s = &default_sources()[0];
        let hosts = allowed_hosts(s);
        assert!(url_allowed("https://open-vsx.org/api/x", &hosts));
        assert!(url_allowed("https://openvsx.eclipsecontent.org/a/b.vsix", &hosts));
        assert!(!url_allowed("http://open-vsx.org/api/x", &hosts));
        assert!(!url_allowed("https://open-vsx.org.evil.com/x", &hosts));
        assert!(!url_allowed("https://evil.com/?h=open-vsx.org", &hosts));
        assert!(!url_allowed("https://open-vsx.org@evil.com/", &hosts));
    }

    #[test]
    fn sources_roundtrip_keep_default() {
        let dir = crate::extensions::vsix::tests::tmpdir("src");
        assert_eq!(read_sources(&dir)[0].id, OPEN_VSX_ID);
        let saved = write_sources(
            &dir,
            &[Source { id: "".into(), label: "".into(), url: "https://registry.example.com/api/".into(), content_hosts: vec!["cdn.example.com".into(), "bad host".into()], enabled: true, builtin: true }],
        )
        .unwrap();
        assert_eq!(saved.len(), 2);
        let open = saved.iter().find(|s| s.id == OPEN_VSX_ID).unwrap();
        assert!(!open.enabled, "padrão removida volta desabilitada");
        let ex = saved.iter().find(|s| s.id == "registry.example.com").unwrap();
        assert_eq!(ex.url, "https://registry.example.com/api");
        assert_eq!(ex.content_hosts, vec!["cdn.example.com".to_string()]);
        assert!(!ex.builtin);
        assert_eq!(read_sources(&dir).len(), 2);
        assert!(write_sources(&dir, &[Source { id: "x".into(), label: "x".into(), url: "http://a.b/api".into(), content_hosts: vec![], enabled: true, builtin: false }]).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sha_and_icons() {
        assert_eq!(parse_sha256("FB730EA4306D09CDC0A3AAA9E9BAAE28058CC97A4FBFCE8B056B377A0639A9FE  file.vsix\n").unwrap().len(), 64);
        assert!(parse_sha256("nope").is_none());
        assert!(icon_data_uri(b"\x89PNG....", None, "https://x/icon").unwrap().starts_with("data:image/png;base64,"));
        assert!(icon_data_uri(b"<html>", Some("text/html"), "https://x/icon.html").is_none());
    }

    #[test]
    fn url_encoding() {
        assert_eq!(enc("a b/c"), "a%20b%2Fc");
        assert_eq!(enc("ms-python.python"), "ms-python.python");
    }
}
