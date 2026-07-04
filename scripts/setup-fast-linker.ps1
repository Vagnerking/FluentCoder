# Ativa o linker lld rápido para o ciclo de dev local (Windows x64, opt-in).
# Ver src-tauri/.cargo/config.toml.example para o porquê de ser opt-in.
#
# Provisiona src-tauri\target\.linker\lld-link.exe a partir do rust-lld.exe da
# sua toolchain e escreve src-tauri\.cargo\config.toml (gitignored). Rode uma vez
# por checkout. Para desativar: apague src-tauri\.cargo\config.toml.
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$tauriDir = Join-Path $repoRoot 'src-tauri'

$sysroot = (& rustc --print sysroot).Trim()
$src = Join-Path $sysroot 'lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe'
if (-not (Test-Path $src)) {
    Write-Error "rust-lld.exe não encontrado em $src — instale a toolchain MSVC x64."
    exit 1
}

$linkerDir = Join-Path $tauriDir 'target\.linker'
New-Item -ItemType Directory -Force -Path $linkerDir | Out-Null
Copy-Item -Force $src (Join-Path $linkerDir 'lld-link.exe')

$cargoDir = Join-Path $tauriDir '.cargo'
New-Item -ItemType Directory -Force -Path $cargoDir | Out-Null
Copy-Item -Force (Join-Path $cargoDir 'config.toml.example') (Join-Path $cargoDir 'config.toml')

Write-Host "linker lld ativado: $linkerDir\lld-link.exe"
Write-Host "config local: $cargoDir\config.toml (gitignored)"
Write-Host "para desativar, apague esse config.toml."
