//! Contribuições DECLARATIVAS de extensões (temas de cor, temas de ícones,
//! ícones de produto, gramáticas, configurações de linguagem e snippets) —
//! lidas sem executar NADA da extensão (modo "somente contribuições").
//!
//! Duas portas, ambas presas à pasta da extensão (realpath):
//!
//! - `extensions_read_contribution(id, path, file)` devolve o TEXTO de um
//!   arquivo de contribuição (JSON/JSONC, `.tmTheme`/`.tmLanguage` plist,
//!   `.code-snippets`), ≤ 4 MB, só extensões de texto conhecidas. Registra a
//!   raiz da extensão para o protocolo abaixo.
//! - protocolo `fcext://localhost/<id>/<caminho>` (Windows:
//!   `http://fcext.localhost/…`) serve os ÍCONES (svg/png/jpg/gif/webp) e
//!   FONTES (woff/woff2/ttf/otf) dos temas, só das extensões já registradas,
//!   com tetos de tamanho. SVG é sanitizado (sem `<script>`, `<foreignObject>`,
//!   `on*=`, `href` externo) e sai com CSP `default-src 'none'`; o app só o usa
//!   via `<img>`/`url()` — nunca inline no DOM.
//!
//! Também: `snippets_user_list` (snippets do usuário em
//! `<app_config>/snippets/*.json|*.code-snippets`).
//!
//! Regras: docs/context/extensoes-vscode.md ("Contribuições sem código").

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use super::{managed_dir, normalize_id, resolve_installed_path, store, vsix};

/// Teto de um arquivo de contribuição (tema, gramática, snippets…).
pub const MAX_TEXT_BYTES: u64 = 4 << 20;
/// Tetos dos ativos servidos pelo protocolo.
pub const MAX_SVG_BYTES: u64 = 512 << 10;
pub const MAX_IMAGE_BYTES: u64 = 1 << 20;
pub const MAX_FONT_BYTES: u64 = 2 << 20;
/// Snippets do usuário: tetos de arquivos e de tamanho.
const MAX_USER_SNIPPET_FILES: usize = 200;
const MAX_USER_SNIPPET_BYTES: u64 = 1 << 20;

pub const SCHEME: &str = "fcext";

/// id → raiz canônica da extensão (registrada pela 1ª leitura de contribuição).
static ROOTS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

fn remember_root(id: &str, root: &Path) {
    let mut g = ROOTS.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(HashMap::new).insert(id.to_string(), root.to_path_buf());
}

fn root_of(id: &str) -> Option<PathBuf> {
    let g = ROOTS.lock().unwrap_or_else(|e| e.into_inner());
    g.as_ref().and_then(|m| m.get(id).cloned())
}

const TEXT_EXTS: [&str; 9] = ["json", "jsonc", "code-snippets", "tmtheme", "tmlanguage", "plist", "xml", "json5", "tmsnippet"];

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// Resolve `file` (relativo, já normalizado pelo app — sem `.`/`..`) dentro de
/// `root`, conferindo o realpath (symlink para fora → erro).
pub fn resolve_inside(root: &Path, file: &str) -> Result<PathBuf, String> {
    let rel = vsix::safe_relative(file)?;
    let joined = root.join(rel);
    let real = std::fs::canonicalize(&joined).map_err(|_| format!("arquivo não encontrado: {file}"))?;
    let root_real = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !real.starts_with(&root_real) {
        return Err(format!("caminho fora da pasta da extensão: {file}"));
    }
    if !real.is_file() {
        return Err(format!("não é um arquivo: {file}"));
    }
    Ok(real)
}

/// Lê um arquivo de contribuição de texto (≤ 4 MB, extensões conhecidas).
pub fn read_text_inside(root: &Path, file: &str) -> Result<String, String> {
    let real = resolve_inside(root, file)?;
    let ext = ext_of(&real);
    if !TEXT_EXTS.contains(&ext.as_str()) {
        return Err(format!("tipo de arquivo não permitido para contribuição: {file}"));
    }
    let len = std::fs::metadata(&real).map_err(|e| e.to_string())?.len();
    if len > MAX_TEXT_BYTES {
        return Err(format!("arquivo de contribuição grande demais ({len} bytes): {file}"));
    }
    let bytes = std::fs::read(&real).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text))
}

#[tauri::command]
pub async fn extensions_read_contribution(app: AppHandle, id: String, path: String, file: String) -> Result<String, String> {
    let id = normalize_id(&id)?;
    let dir = managed_dir(&app)?;
    let vdir = store::vscode_extensions_dir();
    tokio::task::spawn_blocking(move || {
        let root = match root_of(&id) {
            Some(r) if std::fs::canonicalize(&path).ok().as_deref() == Some(r.as_path()) => r,
            _ => {
                let (root, _) = resolve_installed_path(&dir, vdir.as_deref(), &id, &path).ok_or("extensão não encontrada (caminho fora das pastas de extensões)")?;
                remember_root(&id, &root);
                root
            }
        };
        read_text_inside(&root, &file)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ snippets do usuário

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UserSnippetFile {
    pub name: String,
    pub path: String,
    pub content: String,
}

/// `*.json` e `*.code-snippets` de `dir` (não recursivo), com tetos.
pub fn list_snippet_files(dir: &Path) -> Vec<UserSnippetFile> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if out.len() >= MAX_USER_SNIPPET_FILES {
            break;
        }
        let p = e.path();
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        if !meta.is_file() || meta.len() > MAX_USER_SNIPPET_BYTES {
            continue;
        }
        let ext = ext_of(&p);
        if ext != "json" && ext != "code-snippets" {
            continue;
        }
        let Ok(bytes) = std::fs::read(&p) else { continue };
        out.push(UserSnippetFile {
            name: e.file_name().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            content: String::from_utf8_lossy(&bytes).into_owned(),
        });
    }
    out
}

/// Snippets do usuário: `<app_config>/snippets/` (ou `FLUENT_APP_CONFIG_DIR`).
#[tauri::command]
pub async fn snippets_user_list(app: AppHandle) -> Result<Vec<UserSnippetFile>, String> {
    let base = match std::env::var("FLUENT_APP_CONFIG_DIR") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => app.path().app_config_dir().map_err(|e| e.to_string())?,
    };
    let dir = base.join("snippets");
    let _ = std::fs::create_dir_all(&dir);
    tokio::task::spawn_blocking(move || Ok(list_snippet_files(&dir))).await.map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ protocolo fcext

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `/<id>/<rel…>` (cada segmento codificado à parte) → (id, rel). Barra ou
/// barra invertida CODIFICADA dentro de um segmento → recusa.
pub fn parse_asset_path(path: &str) -> Option<(String, String)> {
    let mut segs = path.trim_start_matches('/').split('/');
    let id_raw = segs.next()?;
    let id = normalize_id(&percent_decode(id_raw)?).ok()?;
    let mut rel = Vec::new();
    for s in segs {
        let d = percent_decode(s)?;
        if d.is_empty() || d.contains('/') || d.contains('\\') || d.contains('\0') {
            return None;
        }
        rel.push(d);
    }
    if rel.is_empty() {
        return None;
    }
    Some((id, rel.join("/")))
}

fn mime_and_cap(ext: &str) -> Option<(&'static str, u64)> {
    Some(match ext {
        "svg" => ("image/svg+xml", MAX_SVG_BYTES),
        "png" => ("image/png", MAX_IMAGE_BYTES),
        "jpg" | "jpeg" => ("image/jpeg", MAX_IMAGE_BYTES),
        "gif" => ("image/gif", MAX_IMAGE_BYTES),
        "webp" => ("image/webp", MAX_IMAGE_BYTES),
        "woff" => ("font/woff", MAX_FONT_BYTES),
        "woff2" => ("font/woff2", MAX_FONT_BYTES),
        "ttf" => ("font/ttf", MAX_FONT_BYTES),
        "otf" => ("font/otf", MAX_FONT_BYTES),
        _ => return None,
    })
}

/// Remove o que um SVG não precisa para desenhar e que poderia executar ou
/// buscar algo: `<script>`, `<foreignObject>`, handlers `on*=`, `href`/
/// `xlink:href` para fora do próprio documento, `<!ENTITY>`. (Via `<img>` o
/// SVG já não roda script; isto é defesa em profundidade.)
pub fn sanitize_svg(src: &str) -> String {
    use std::sync::OnceLock;
    static RES: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    let res = RES.get_or_init(|| {
        [
            r"(?is)<!DOCTYPE[^\[>]*\[.*?\]\s*>",
            r"(?is)<!ENTITY[^>]*>",
            r"(?is)<script\b.*?</script\s*>",
            r"(?is)<script\b[^>]*/>",
            r"(?is)<foreignObject\b.*?</foreignObject\s*>",
            r"(?is)<foreignObject\b[^>]*/>",
            r#"(?i)\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#,
        ]
        .iter()
        .map(|p| regex::Regex::new(p).expect("regex de sanitização"))
        .collect()
    });
    static HREF: OnceLock<regex::Regex> = OnceLock::new();
    let href = HREF.get_or_init(|| regex::Regex::new(r#"(?i)\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).expect("regex href"));
    let mut out = src.to_string();
    for re in res {
        out = re.replace_all(&out, "").into_owned();
    }
    // Só referências internas (`#id`) e imagens raster embutidas (`data:image/…`).
    href.replace_all(&out, |c: &regex::Captures| {
        let v = c.get(1).or(c.get(2)).or(c.get(3)).map(|m| m.as_str().trim()).unwrap_or("");
        let lower = v.to_ascii_lowercase();
        if v.starts_with('#') || (lower.starts_with("data:image/") && !lower.starts_with("data:image/svg")) {
            c[0].to_string()
        } else {
            String::new()
        }
    })
    .into_owned()
}

fn origin_allowed(origin: &str) -> bool {
    matches!(origin, "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost" | "http://localhost:1420" | "http://127.0.0.1:1420")
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>, origin: Option<&str>) -> Response<Vec<u8>> {
    let mut b = Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
        .header("Cache-Control", "max-age=3600");
    if let Some(o) = origin.filter(|o| origin_allowed(o)) {
        // Fontes (`@font-face`) exigem CORS; só para a própria origem do app.
        b = b.header("Access-Control-Allow-Origin", o).header("Vary", "Origin");
    }
    b.body(body).unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Atende um pedido do protocolo (puro sobre o mapa de raízes; testável).
pub fn serve_asset(method: &str, path: &str, origin: Option<&str>, root_for: impl Fn(&str) -> Option<PathBuf>) -> Response<Vec<u8>> {
    let text = |s: StatusCode| respond(s, "text/plain", Vec::new(), origin);
    if method != "GET" && method != "HEAD" {
        return text(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some((id, rel)) = parse_asset_path(path) else { return text(StatusCode::BAD_REQUEST) };
    let Some(root) = root_for(&id) else { return text(StatusCode::NOT_FOUND) };
    let Ok(real) = resolve_inside(&root, &rel) else { return text(StatusCode::FORBIDDEN) };
    let ext = ext_of(&real);
    let Some((mime, cap)) = mime_and_cap(&ext) else { return text(StatusCode::FORBIDDEN) };
    let Ok(meta) = std::fs::metadata(&real) else { return text(StatusCode::NOT_FOUND) };
    if meta.len() > cap {
        return text(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let Ok(bytes) = std::fs::read(&real) else { return text(StatusCode::NOT_FOUND) };
    let body = if ext == "svg" { sanitize_svg(&String::from_utf8_lossy(&bytes)).into_bytes() } else { bytes };
    respond(StatusCode::OK, mime, if method == "HEAD" { Vec::new() } else { body }, origin)
}

/// Handler do `register_asynchronous_uri_scheme_protocol("fcext", …)`.
pub fn protocol<R: Runtime>(_ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let origin = request.headers().get("Origin").and_then(|v| v.to_str().ok()).map(str::to_string);
    std::thread::spawn(move || {
        responder.respond(serve_asset(&method, &path, origin.as_deref(), root_of));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ext_dir() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("themes")).unwrap();
        std::fs::write(d.path().join("themes/dark.json"), "{\"name\":\"x\"}").unwrap();
        std::fs::write(d.path().join("icon.svg"), "<svg onload=\"alert(1)\"><script>alert(2)</script><a href=\"https://evil\"/><use href=\"#ok\"/><path d=\"M0\"/></svg>").unwrap();
        std::fs::write(d.path().join("code.js"), "alert(1)").unwrap();
        d
    }

    #[test]
    fn reads_text_inside_and_refuses_escapes() {
        let d = ext_dir();
        assert_eq!(read_text_inside(d.path(), "themes/dark.json").unwrap(), "{\"name\":\"x\"}");
        assert!(read_text_inside(d.path(), "../etc/passwd").is_err());
        assert!(read_text_inside(d.path(), "/etc/passwd").is_err());
        assert!(read_text_inside(d.path(), "./themes/dark.json").is_err());
        assert!(read_text_inside(d.path(), "code.js").is_err(), "só texto de contribuição");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_out_of_root_is_refused() {
        let d = ext_dir();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("s.json"), "{}").unwrap();
        std::os::unix::fs::symlink(outside.path().join("s.json"), d.path().join("link.json")).unwrap();
        assert!(read_text_inside(d.path(), "link.json").is_err());
    }

    #[test]
    fn svg_is_sanitized() {
        let out = sanitize_svg("<svg onload=\"alert(1)\"><script>alert(2)</script><foreignObject><div/></foreignObject><a href=\"https://evil\"/><use href=\"#ok\"/></svg>");
        assert!(!out.contains("onload"));
        assert!(!out.contains("script"));
        assert!(!out.contains("foreignObject"));
        assert!(!out.contains("evil"));
        assert!(out.contains("#ok"), "referência interna fica: {out}");
        let img = sanitize_svg("<svg><image href=\"data:image/png;base64,AAA\"/><image href=\"data:image/svg+xml;base64,AAA\"/></svg>");
        assert!(img.contains("data:image/png"));
        assert!(!img.contains("svg+xml"));
    }

    #[test]
    fn asset_path_parsing() {
        assert_eq!(parse_asset_path("/pkief.material-icon-theme/icons/a%20b.svg"), Some(("pkief.material-icon-theme".into(), "icons/a b.svg".into())));
        assert_eq!(parse_asset_path("/x.y/a%2Fb.svg"), None, "barra codificada");
        assert_eq!(parse_asset_path("/x.y/a%5Cb.svg"), None);
        assert_eq!(parse_asset_path("/x.y/"), None);
        assert_eq!(parse_asset_path("/bad/a.svg"), None, "id sem ponto");
    }

    #[test]
    fn serve_asset_rules() {
        let d = ext_dir();
        let root = d.path().to_path_buf();
        let roots = |id: &str| (id == "pub.ext").then(|| root.clone());
        let ok = serve_asset("GET", "/pub.ext/icon.svg", Some("tauri://localhost"), roots);
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()["Content-Type"], "image/svg+xml");
        assert_eq!(ok.headers()["Access-Control-Allow-Origin"], "tauri://localhost");
        assert!(!String::from_utf8_lossy(ok.body()).contains("script"));
        assert_eq!(serve_asset("GET", "/pub.ext/code.js", None, roots).status(), StatusCode::FORBIDDEN);
        assert_eq!(serve_asset("GET", "/pub.ext/themes/dark.json", None, roots).status(), StatusCode::FORBIDDEN);
        assert_eq!(serve_asset("GET", "/other.ext/icon.svg", None, roots).status(), StatusCode::NOT_FOUND);
        assert_eq!(serve_asset("POST", "/pub.ext/icon.svg", None, roots).status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(serve_asset("GET", "/pub.ext/..%2F..%2Fetc/passwd", None, roots).status(), StatusCode::BAD_REQUEST);
        let evil = serve_asset("GET", "/pub.ext/icon.svg", Some("https://evil.example"), roots);
        assert!(evil.headers().get("Access-Control-Allow-Origin").is_none());
    }

    #[test]
    fn oversized_svg_refused() {
        let d = ext_dir();
        std::fs::write(d.path().join("big.svg"), vec![b' '; (MAX_SVG_BYTES + 1) as usize]).unwrap();
        let root = d.path().to_path_buf();
        assert_eq!(serve_asset("GET", "/pub.ext/big.svg", None, |_| Some(root.clone())).status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn user_snippet_listing_filters() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("rust.json"), "{}").unwrap();
        std::fs::write(d.path().join("global.code-snippets"), "{}").unwrap();
        std::fs::write(d.path().join("notes.txt"), "x").unwrap();
        let names: Vec<_> = list_snippet_files(d.path()).into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["global.code-snippets", "rust.json"]);
    }
}
