//! Leitura e extração SEGURA de pacotes VSIX (ZIP).
//!
//! Regras (docs/context/extensoes-vscode.md → "Instalação de extensões"):
//! - só o payload `extension/` é extraído (o resto do VSIX — `[Content_Types].xml`,
//!   `extension.vsixmanifest`, assinaturas — fica de fora);
//! - zip-slip: caminho absoluto, `..`, `\`, NUL ou componente vazio → recusa o
//!   PACOTE inteiro (não só a entrada);
//! - symlinks (modo Unix `S_IFLNK`) → recusa;
//! - tetos de entradas, de tamanho por arquivo e total (conferidos nos bytes
//!   realmente descomprimidos, não no cabeçalho — zip bomb);
//! - nada é executado: extrair é só copiar bytes.

use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

/// Limites da extração (padrões em [`Limits::default`]).
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_entries: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        // O Codex 26.x extraído tem ~1 GB (binários nativos); o Claude Code ~260 MB.
        Self { max_entries: 60_000, max_file_bytes: 1 << 30, max_total_bytes: 2 << 30 }
    }
}

/// Teto do `package.json` e do `extension.vsixmanifest` lidos do pacote.
const MAX_MANIFEST_BYTES: u64 = 4 << 20;

const PAYLOAD_PREFIX: &str = "extension/";

/// O que o VSIX declara sobre si mesmo.
#[derive(Debug, Clone)]
pub struct VsixInfo {
    #[allow(dead_code)]
    pub manifest: Value,
    pub publisher: String,
    pub name: String,
    pub version: String,
    /// `TargetPlatform` do `extension.vsixmanifest` (None = universal).
    pub target_platform: Option<String>,
}

impl VsixInfo {
    pub fn id(&self) -> String {
        format!("{}.{}", self.publisher, self.name).to_lowercase()
    }
}

/// Caminho relativo seguro (sem raiz, sem `..`, sem `\`/NUL, sem vazios).
pub fn safe_relative(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.contains('\0') || raw.contains('\\') || raw.starts_with('/') {
        return Err(format!("caminho inseguro no pacote: {raw:?}"));
    }
    // Letra de unidade (C:) e afins.
    if raw.len() >= 2 && raw.as_bytes()[1] == b':' {
        return Err(format!("caminho inseguro no pacote: {raw:?}"));
    }
    let trimmed = raw.trim_end_matches('/');
    let mut out = PathBuf::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("caminho inseguro no pacote: {raw:?}"));
        }
        out.push(part);
    }
    // Defesa extra: só componentes normais.
    if !out.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("caminho inseguro no pacote: {raw:?}"));
    }
    Ok(out)
}

fn is_symlink_mode(mode: Option<u32>) -> bool {
    mode.map(|m| m & 0o170000 == 0o120000).unwrap_or(false)
}

fn read_entry_capped<R: Read>(mut r: R, cap: u64) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    (&mut r).take(cap + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > cap {
        return Err("arquivo de manifesto grande demais".into());
    }
    Ok(buf)
}

/// `TargetPlatform="linux-x64"` do `<Identity …/>` do vsixmanifest.
pub fn parse_target_platform(vsixmanifest: &str) -> Option<String> {
    let re = regex::Regex::new(r#"<Identity\b[^>]*\bTargetPlatform\s*=\s*"([A-Za-z0-9-]+)""#).ok()?;
    let tp = re.captures(vsixmanifest)?.get(1)?.as_str().to_string();
    if tp == "universal" {
        None
    } else {
        Some(tp)
    }
}

/// Lê o manifesto (`extension/package.json`) e a plataforma sem extrair nada.
pub fn inspect<R: Read + Seek>(reader: R) -> Result<VsixInfo, String> {
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("VSIX inválido: {e}"))?;
    let manifest_bytes = {
        let f = archive
            .by_name("extension/package.json")
            .map_err(|_| "VSIX sem extension/package.json".to_string())?;
        read_entry_capped(f, MAX_MANIFEST_BYTES)?
    };
    let manifest: Value =
        serde_json::from_slice(&manifest_bytes).map_err(|e| format!("package.json inválido: {e}"))?;
    let field = |k: &str| manifest.get(k).and_then(Value::as_str).map(str::to_string);
    let publisher = field("publisher").ok_or("package.json sem publisher")?;
    let name = field("name").ok_or("package.json sem name")?;
    let version = field("version").ok_or("package.json sem version")?;
    validate_id_part(&publisher)?;
    validate_id_part(&name)?;
    crate::extensions::semver::Version::parse(&version)
        .ok_or_else(|| format!("versão inválida no package.json: {version}"))?;
    let target_platform = match archive.by_name("extension.vsixmanifest") {
        Ok(f) => {
            let bytes = read_entry_capped(f, MAX_MANIFEST_BYTES)?;
            parse_target_platform(&String::from_utf8_lossy(&bytes))
        }
        Err(_) => None,
    };
    Ok(VsixInfo { manifest, publisher, name, version, target_platform })
}

/// Publisher/nome de extensão: letras, dígitos, `-`/`_`/`.` (sem começar por ponto).
pub fn validate_id_part(s: &str) -> Result<(), String> {
    let ok = !s.is_empty()
        && s.len() <= 128
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !s.starts_with('.')
        && !s.contains("..");
    if ok {
        Ok(())
    } else {
        Err(format!("identificador inválido: {s:?}"))
    }
}

/// Extrai só `extension/**` em `dest` (que NÃO pode existir). Em erro, `dest`
/// é apagada — nunca fica extração parcial.
pub fn extract_payload<R: Read + Seek>(reader: R, dest: &Path, limits: Limits) -> Result<u64, String> {
    if dest.exists() {
        return Err(format!("destino já existe: {}", dest.display()));
    }
    let result = extract_inner(reader, dest, limits);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(dest);
    }
    result
}

fn extract_inner<R: Read + Seek>(reader: R, dest: &Path, limits: Limits) -> Result<u64, String> {
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("VSIX inválido: {e}"))?;
    if archive.len() > limits.max_entries {
        return Err(format!("pacote com entradas demais ({} > {})", archive.len(), limits.max_entries));
    }
    // 1ª passada: valida TODOS os nomes/tipos antes de escrever qualquer byte.
    let mut plan: Vec<(usize, PathBuf, bool)> = Vec::new();
    for i in 0..archive.len() {
        let f = archive.by_index_raw(i).map_err(|e| e.to_string())?;
        let raw = f.name().map_err(|e| format!("nome inválido no pacote: {e}"))?.into_owned();
        if is_symlink_mode(f.unix_mode()) {
            return Err(format!("o pacote contém um link simbólico: {raw}"));
        }
        // Valida o nome inteiro (inclusive fora do payload) contra zip-slip.
        let rel_full = safe_relative(&raw)?;
        let Some(rest) = raw.strip_prefix(PAYLOAD_PREFIX) else {
            continue; // metadados do VSIX: não extraídos
        };
        if rest.is_empty() {
            continue; // a própria pasta extension/
        }
        let rel = safe_relative(rest)?;
        debug_assert!(rel_full.starts_with("extension"));
        if f.size() > limits.max_file_bytes {
            return Err(format!("arquivo grande demais no pacote: {raw}"));
        }
        plan.push((i, rel, f.is_dir()));
    }
    if !plan.iter().any(|(_, rel, dir)| !dir && rel == Path::new("package.json")) {
        return Err("VSIX sem extension/package.json".into());
    }
    std::fs::create_dir_all(dest).map_err(|e| format!("falha ao criar {}: {e}", dest.display()))?;
    let mut total: u64 = 0;
    for (i, rel, is_dir) in plan {
        let out_path = dest.join(&rel);
        if is_dir {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // Nunca escrever através de um symlink pré-existente (não deveria haver: dest é nova).
        if std::fs::symlink_metadata(&out_path).is_ok() {
            return Err(format!("entrada duplicada no pacote: {}", rel.display()));
        }
        let mut out = File::create(&out_path).map_err(|e| e.to_string())?;
        let remaining_total = limits.max_total_bytes.saturating_sub(total);
        let cap = limits.max_file_bytes.min(remaining_total);
        let mut limited = (&mut entry).take(cap + 1);
        let mut buf = [0u8; 64 * 1024];
        let mut written: u64 = 0;
        loop {
            let n = limited.read(&mut buf).map_err(|e| format!("falha ao descomprimir {}: {e}", rel.display()))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > cap {
                return Err(if written > limits.max_file_bytes {
                    format!("arquivo grande demais no pacote: {}", rel.display())
                } else {
                    "o pacote descomprimido passa do limite total".to_string()
                });
            }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        }
        total += written;
        // Mantém o bit de execução (binários nativos de extensões), nada mais.
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let perm = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
            let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(perm));
        }
    }
    Ok(total)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    pub(crate) fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fluent-vsix-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Monta um VSIX em memória: (nome, conteúdo, modo unix opcional).
    pub(crate) fn build_zip(entries: &[(&str, &[u8], Option<u32>)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            for (name, data, mode) in entries {
                let mut opts = SimpleFileOptions::default();
                if let Some(m) = mode {
                    opts = opts.unix_permissions(*m);
                }
                if mode.map(|m| m & 0o170000 == 0o120000).unwrap_or(false) {
                    w.add_symlink(*name, std::str::from_utf8(data).unwrap(), SimpleFileOptions::default()).unwrap();
                } else if name.ends_with('/') {
                    w.add_directory(*name, opts).unwrap();
                } else {
                    w.start_file(*name, opts).unwrap();
                    w.write_all(data).unwrap();
                }
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    // ZipWriter masks privileged bits, so inject raw central-directory metadata
    // to exercise the reader with an archive an external publisher could send.
    pub(crate) fn set_archive_unix_mode(bytes: &mut [u8], name: &str, mode: u32) {
        for i in 0..bytes.len().saturating_sub(46) {
            if bytes[i..i + 4] != [0x50, 0x4b, 0x01, 0x02] {
                continue;
            }
            let len = u16::from_le_bytes([bytes[i + 28], bytes[i + 29]]) as usize;
            if bytes.get(i + 46..i + 46 + len) != Some(name.as_bytes()) {
                continue;
            }
            bytes[i + 5] = 3; // "version made by": Unix
            bytes[i + 38..i + 42].copy_from_slice(&(mode << 16).to_le_bytes());
            return;
        }
        panic!("central-directory entry missing: {name}");
    }

    pub(crate) fn fixture_vsix(publisher: &str, name: &str, version: &str, platform: Option<&str>) -> Vec<u8> {
        let pkg = format!(
            r#"{{"name":"{name}","publisher":"{publisher}","version":"{version}","engines":{{"vscode":"^1.80.0"}},"main":"./out/ext.js","contributes":{{"commands":[{{"command":"{name}.hello","title":"Hello"}}]}}}}"#
        );
        let tp = platform.map(|p| format!(r#" TargetPlatform="{p}""#)).unwrap_or_default();
        let vsixmanifest = format!(
            r#"<?xml version="1.0"?><PackageManifest><Metadata><Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}"{tp}/></Metadata></PackageManifest>"#
        );
        build_zip(&[
            ("[Content_Types].xml", b"<Types/>", None),
            ("extension.vsixmanifest", vsixmanifest.as_bytes(), None),
            ("extension/package.json", pkg.as_bytes(), None),
            ("extension/out/ext.js", b"const vscode = require(\"vscode\"); exports.activate = () => vscode.window.showInformationMessage('oi');", None),
            ("extension/README.md", b"# Fixture\n", None),
        ])
    }

    #[test]
    fn inspect_reads_manifest_and_platform() {
        let z = fixture_vsix("Acme", "demo", "1.2.3", Some("linux-x64"));
        let info = inspect(Cursor::new(z)).unwrap();
        assert_eq!(info.id(), "acme.demo");
        assert_eq!(info.version, "1.2.3");
        assert_eq!(info.target_platform.as_deref(), Some("linux-x64"));
        let u = fixture_vsix("acme", "demo", "1.0.0", None);
        assert_eq!(inspect(Cursor::new(u)).unwrap().target_platform, None);
    }

    #[test]
    fn extracts_only_extension_payload() {
        let z = fixture_vsix("acme", "demo", "1.0.0", None);
        let root = tmpdir("ok");
        let dest = root.join("out");
        let total = extract_payload(Cursor::new(z), &dest, Limits::default()).unwrap();
        assert!(total > 0);
        assert!(dest.join("package.json").is_file());
        assert!(dest.join("out/ext.js").is_file());
        assert!(!dest.join("extension.vsixmanifest").exists());
        assert!(!dest.join("[Content_Types].xml").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_utf8_and_legacy_cp437_entry_names() {
        let mut bytes = build_zip(&[
            ("extension/package.json", b"{}", None),
            ("extension/mídia/你好.txt", b"utf8", None),
            ("extension/cafX.txt", b"cp437", None),
        ]);
        // ASCII writer entry has no UTF-8 flag. Replace its equal-length local
        // and central names with a genuine CP437 byte for é.
        let name = b"extension/cafX.txt";
        let mut replaced = 0;
        for i in 0..=bytes.len() - name.len() {
            if &bytes[i..i + name.len()] == name {
                bytes[i + 13] = 0x82;
                replaced += 1;
            }
        }
        assert_eq!(replaced, 2);
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("out");

        extract_payload(Cursor::new(bytes), &dest, Limits::default()).unwrap();

        assert_eq!(std::fs::read(dest.join("mídia/你好.txt")).unwrap(), b"utf8");
        assert_eq!(std::fs::read(dest.join("café.txt")).unwrap(), b"cp437");
    }

    #[test]
    fn rejects_zip_slip() {
        for bad in ["extension/../../evil.txt", "../evil.txt", "/abs/evil", "extension/a\\..\\b", "C:/x", "extension//x"] {
            let z = build_zip(&[("extension/package.json", b"{}", None), (bad, b"x", None)]);
            let root = tmpdir("slip");
            let dest = root.join("out");
            let err = extract_payload(Cursor::new(z), &dest, Limits::default());
            assert!(err.is_err(), "deveria recusar {bad}");
            assert!(!dest.exists(), "não pode sobrar extração parcial ({bad})");
            assert!(!root.join("evil.txt").exists());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn rejects_symlinks() {
        let z = build_zip(&[("extension/package.json", b"{}", None), ("extension/link", b"/etc/passwd", Some(0o120777))]);
        let root = tmpdir("link");
        let err = extract_payload(Cursor::new(z), &root.join("out"), Limits::default()).unwrap_err();
        assert!(err.contains("link simbólico"), "{err}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn strips_privileged_archive_bits_but_keeps_executable_payload() {
        use std::os::unix::fs::PermissionsExt;

        let mut bytes = build_zip(&[
            ("extension/package.json", b"{}", None),
            ("extension/tool", b"#!/bin/sh\n", Some(0o755)),
        ]);
        set_archive_unix_mode(&mut bytes, "extension/tool", 0o107755);
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("out");

        extract_payload(Cursor::new(bytes), &dest, Limits::default()).unwrap();

        assert_eq!(std::fs::metadata(dest.join("tool")).unwrap().permissions().mode() & 0o7777, 0o755);
        assert_eq!(std::fs::read(dest.join("tool")).unwrap(), b"#!/bin/sh\n");
    }

    #[test]
    fn enforces_size_and_entry_limits() {
        let big = vec![b'a'; 10_000];
        let z = build_zip(&[("extension/package.json", b"{}", None), ("extension/big.bin", &big, None)]);
        let root = tmpdir("lim");
        let per_file = Limits { max_entries: 100, max_file_bytes: 1000, max_total_bytes: 1 << 20 };
        assert!(extract_payload(Cursor::new(z.clone()), &root.join("a"), per_file).is_err());
        let total = Limits { max_entries: 100, max_file_bytes: 1 << 20, max_total_bytes: 5000 };
        assert!(extract_payload(Cursor::new(z.clone()), &root.join("b"), total).is_err());
        assert!(!root.join("b").exists());
        let entries = Limits { max_entries: 1, max_file_bytes: 1 << 20, max_total_bytes: 1 << 20 };
        assert!(extract_payload(Cursor::new(z), &root.join("c"), entries).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn requires_package_json() {
        let z = build_zip(&[("extension/readme.md", b"x", None)]);
        let root = tmpdir("nopkg");
        assert!(extract_payload(Cursor::new(z.clone()), &root.join("o"), Limits::default()).is_err());
        assert!(inspect(Cursor::new(z)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn id_parts_validated() {
        assert!(validate_id_part("ms-python").is_ok());
        assert!(validate_id_part("a.b_c").is_ok());
        assert!(validate_id_part("../x").is_err());
        assert!(validate_id_part("a/b").is_err());
        assert!(validate_id_part("").is_err());
    }

    #[test]
    fn target_platform_parsing() {
        assert_eq!(parse_target_platform(r#"<Identity Id="x" TargetPlatform="darwin-arm64" />"#).as_deref(), Some("darwin-arm64"));
        assert_eq!(parse_target_platform(r#"<Identity Id="x" TargetPlatform="universal" />"#), None);
        assert_eq!(parse_target_platform(r#"<Identity Id="x" />"#), None);
    }
}
