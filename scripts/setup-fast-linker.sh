#!/usr/bin/env bash
# Ativa o linker lld rápido para o ciclo de dev local (Windows x64, opt-in).
# Ver src-tauri/.cargo/config.toml.example para o porquê de ser opt-in.
#
# Provisiona `src-tauri/target/.linker/lld-link.exe` a partir do `rust-lld.exe`
# da sua toolchain e escreve `src-tauri/.cargo/config.toml` (gitignored). Rode
# uma vez por checkout. Para desativar: apague src-tauri/.cargo/config.toml.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tauri_dir="$repo_root/src-tauri"

sysroot="$(rustc --print sysroot)"
src="$sysroot/lib/rustlib/x86_64-pc-windows-msvc/bin/rust-lld.exe"
if [[ ! -f "$src" ]]; then
  echo "rust-lld.exe não encontrado em $src — instale a toolchain MSVC x64." >&2
  exit 1
fi

linker_dir="$tauri_dir/target/.linker"
mkdir -p "$linker_dir"
cp "$src" "$linker_dir/lld-link.exe"

mkdir -p "$tauri_dir/.cargo"
cp "$tauri_dir/.cargo/config.toml.example" "$tauri_dir/.cargo/config.toml"

echo "linker lld ativado: $linker_dir/lld-link.exe"
echo "config local: $tauri_dir/.cargo/config.toml (gitignored)"
echo "para desativar, apague esse config.toml."
