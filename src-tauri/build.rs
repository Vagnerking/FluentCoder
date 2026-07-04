fn main() {
    // Provisiona o linker LLD (só Windows) — ver bloco abaixo. Falha aqui NUNCA
    // deve quebrar a build: se algo der errado, o `.cargo/config.toml` cai no
    // linker padrão porque o caminho apontado simplesmente não existirá e o Cargo
    // avisa, então preferimos garantir que ele exista.
    #[cfg(windows)]
    provision_lld();

    tauri_build::build()
}

/// Cria um `lld-link.exe` (o LLD com o "flavor" MSVC) a partir do `rust-lld.exe`
/// que já vem com a toolchain Rust, em `target/.linker/`. O `.cargo/config.toml`
/// aponta o linker do target `x86_64-pc-windows-msvc` para esse arquivo.
///
/// Por quê: no MSVC o rustc só ativa o LLD quando o linker se CHAMA `lld-link.exe`
/// (é assim que ele detecta o flavor). O `rust-lld.exe` da toolchain é o mesmo
/// binário, mas com outro nome — então copiamos com o nome certo. Fazemos isso no
/// build.rs (que roda ANTES do passo de link) para que a configuração seja
/// auto-contida: nenhum dev/CI precisa instalar LLVM nem mexer no PATH.
///
/// O LLD linka em paralelo e corta segundos–dezenas de segundos do passo de link
/// — que é o mais caro na build de teste (`tauri build --debug`).
#[cfg(windows)]
fn provision_lld() {
    use std::path::PathBuf;
    use std::process::Command;

    // `target/.linker/lld-link.exe` — dentro de `target/` (gitignored).
    let out_dir = std::env::var("OUT_DIR").unwrap_or_default();
    // OUT_DIR = .../target/<profile>/build/<pkg>-<hash>/out — subimos até `target/`.
    let target_dir = PathBuf::from(&out_dir)
        .ancestors()
        .find(|p| p.file_name().map(|n| n == "target").unwrap_or(false))
        .map(PathBuf::from);
    let Some(target_dir) = target_dir else { return };

    let linker_dir = target_dir.join(".linker");
    let dest = linker_dir.join("lld-link.exe");
    if dest.exists() {
        return; // idempotente — já provisionado numa build anterior.
    }

    // Localiza o `rust-lld.exe`: <sysroot>/lib/rustlib/<host>/bin/rust-lld.exe.
    let sysroot = Command::new("rustc")
        .arg("--print")
        .arg("sysroot")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let Some(sysroot) = sysroot else { return };

    let src = PathBuf::from(sysroot)
        .join("lib")
        .join("rustlib")
        .join("x86_64-pc-windows-msvc")
        .join("bin")
        .join("rust-lld.exe");
    if !src.exists() {
        return; // toolchain sem rust-lld — config cairá no linker padrão.
    }

    let _ = std::fs::create_dir_all(&linker_dir);
    let _ = std::fs::copy(&src, &dest);
}
