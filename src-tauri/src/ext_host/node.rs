//! Localiza o `node` usado pelo host de extensões fora do terminal de dev.
//!
//! Um app aberto pelo menu do sistema (Linux/macOS) costuma herdar um PATH
//! mínimo, sem os gerenciadores de versão do usuário (fnm, nvm, volta, asdf,
//! mise). Ordem de busca: `FLUENT_NODE` → PATH → pastas dos gerenciadores (a
//! versão mais nova primeiro) → locais de instalação comuns. O primeiro
//! candidato que responde `--version` com major ≥ [`MIN_MAJOR`] vence.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Node mínimo suportado (as extensões exigem ES2022 + `fetch` global).
pub const MIN_MAJOR: u32 = 18;

#[cfg(windows)]
const NODE_EXE: &str = "node.exe";
#[cfg(not(windows))]
const NODE_EXE: &str = "node";

/// "v22.3.0" / "22.3.0" → (22, 3, 0). Entradas não numéricas → None.
pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let s = s.trim().trim_start_matches('v');
    let mut it = s.split(|c: char| c == '.' || c == '-');
    let major = it.next()?.parse().ok()?;
    let minor = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let patch = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    Some((major, minor, patch))
}

/// Subpastas de `dir` cujo nome é uma versão, da mais nova para a mais velha,
/// juntando `suffix` (o caminho do executável dentro de cada versão).
fn versioned(dir: &Path, suffix: &[&str]) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<((u32, u32, u32), PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let v = parse_version(&name)?;
            let mut p = e.path();
            for s in suffix {
                p.push(s);
            }
            Some((v, p))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// Candidatos em ordem de preferência (podem não existir). Puro: recebe o
/// ambiente por função para ser testável.
pub fn candidates(env: &dyn Fn(&str) -> Option<String>, path_hit: Option<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(p) = env("FLUENT_NODE").filter(|p| !p.trim().is_empty()) {
        out.push(PathBuf::from(p));
    }
    if let Some(p) = path_hit {
        out.push(p);
    }
    let home = env(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .or_else(|| env("HOME"))
        .map(PathBuf::from);
    let bin: &[&str] = if cfg!(windows) { &[NODE_EXE] } else { &["bin", NODE_EXE] };

    // fnm: $FNM_DIR ou ~/.local/share/fnm (Linux), ~/Library/Application Support/fnm (macOS), %APPDATA%\fnm.
    let mut fnm_dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = env("FNM_DIR") {
        fnm_dirs.push(PathBuf::from(d));
    }
    if let Some(h) = &home {
        fnm_dirs.push(h.join(".local/share/fnm"));
        fnm_dirs.push(h.join(".fnm"));
        fnm_dirs.push(h.join("Library/Application Support/fnm"));
    }
    if let Some(a) = env("APPDATA") {
        fnm_dirs.push(PathBuf::from(a).join("fnm"));
    }
    for d in fnm_dirs {
        let mut suffix = vec!["installation"];
        suffix.extend_from_slice(bin);
        out.extend(versioned(&d.join("node-versions"), &suffix));
    }
    // nvm: $NVM_DIR/versions/node/vX (Unix) e %NVM_HOME%\vX (nvm-windows).
    let mut nvm_dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = env("NVM_DIR") {
        nvm_dirs.push(PathBuf::from(d).join("versions/node"));
    }
    if let Some(h) = &home {
        nvm_dirs.push(h.join(".nvm/versions/node"));
    }
    for d in nvm_dirs {
        out.extend(versioned(&d, bin));
    }
    if let Some(d) = env("NVM_HOME") {
        out.extend(versioned(Path::new(&d), &[NODE_EXE]));
    }
    if let Some(h) = &home {
        // volta / asdf / mise (shims ou instalações por versão).
        out.push(h.join(".volta/bin").join(NODE_EXE));
        out.push(h.join(".asdf/shims").join(NODE_EXE));
        let mut mise = vec![];
        mise.extend_from_slice(bin);
        out.extend(versioned(&h.join(".local/share/mise/installs/node"), &mise));
        out.push(h.join(".local/bin").join(NODE_EXE));
    }
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(d) = env(var) {
                let base = PathBuf::from(d);
                out.push(base.join("nodejs").join(NODE_EXE));
                out.push(base.join("Programs\\nodejs").join(NODE_EXE));
            }
        }
    } else {
        for p in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node", "/snap/bin/node"] {
            out.push(PathBuf::from(p));
        }
    }
    // Sem duplicatas, mantendo a ordem.
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

/// Versão reportada por `<node> --version` (None se não roda).
fn probe_version(node: &Path) -> Option<(u32, u32, u32)> {
    let mut cmd = Command::new(node);
    cmd.arg("--version").stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

/// Primeiro `node` utilizável. Erro em pt-BR, pronto para a UI.
pub fn find_node() -> Result<PathBuf, String> {
    let env = |k: &str| std::env::var(k).ok();
    let mut too_old: Option<(PathBuf, (u32, u32, u32))> = None;
    for cand in candidates(&env, which::which(NODE_EXE).ok()) {
        if !cand.is_file() {
            continue;
        }
        match probe_version(&cand) {
            Some(v) if v.0 >= MIN_MAJOR => return Ok(cand),
            Some(v) => {
                if too_old.is_none() {
                    too_old = Some((cand, v));
                }
            }
            None => {}
        }
    }
    Err(match too_old {
        Some((p, v)) => format!(
            "O Node.js encontrado ({}, v{}.{}.{}) é antigo demais para as extensões do VS Code. Instale o Node.js {MIN_MAJOR} ou mais novo (https://nodejs.org) ou aponte FLUENT_NODE para um executável compatível.",
            p.display(),
            v.0,
            v.1,
            v.2
        ),
        None => format!(
            "Node.js não encontrado. As extensões do VS Code (Claude Code, Codex) precisam do Node.js {MIN_MAJOR}+: instale em https://nodejs.org (ou via fnm/nvm/volta) e reinicie o Fluent Coder. Se ele estiver num local incomum, defina FLUENT_NODE com o caminho do executável."
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("v22.3.1\n"), Some((22, 3, 1)));
        assert_eq!(parse_version("18"), Some((18, 0, 0)));
        assert_eq!(parse_version("lts-iron"), None);
    }

    #[test]
    fn version_managers_are_searched_newest_first() {
        let tmp = std::env::temp_dir().join(format!("fluent-node-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let fnm = tmp.join("fnm/node-versions");
        for v in ["v18.20.0", "v22.11.0", "v20.1.0"] {
            std::fs::create_dir_all(fnm.join(v).join("installation/bin")).unwrap();
        }
        let nvm = tmp.join("nvm/versions/node/v21.0.0/bin");
        std::fs::create_dir_all(&nvm).unwrap();
        let vars: HashMap<&str, String> = HashMap::from([
            ("FNM_DIR", tmp.join("fnm").to_string_lossy().into_owned()),
            ("NVM_DIR", tmp.join("nvm").to_string_lossy().into_owned()),
            ("HOME", tmp.join("home").to_string_lossy().into_owned()),
            ("USERPROFILE", tmp.join("home").to_string_lossy().into_owned()),
            ("FLUENT_NODE", "/custom/node".to_string()),
        ]);
        let env = |k: &str| vars.get(k).cloned();
        let list = candidates(&env, Some(PathBuf::from("/from/path/node")));
        assert_eq!(list[0], PathBuf::from("/custom/node"), "FLUENT_NODE vem primeiro");
        assert_eq!(list[1], PathBuf::from("/from/path/node"), "depois o PATH");
        let s: Vec<String> = list.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect();
        let pos = |needle: &str| s.iter().position(|x| x.contains(needle)).unwrap();
        assert!(pos("v22.11.0") < pos("v20.1.0"));
        assert!(pos("v20.1.0") < pos("v18.20.0"));
        assert!(s.iter().any(|x| x.contains("nvm/versions/node/v21.0.0")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn finds_some_node_in_dev() {
        // A máquina de dev/CI que roda os testes tem Node (o build do front exige).
        assert!(find_node().is_ok());
    }
}
