#!/usr/bin/env node
/**
 * Hook helper: roda a suíte E2E (tauri-driver + WebdriverIO) SOMENTE quando
 * houver mudanças no código do app (src/ ou src-tauri/) na working tree.
 *
 * Chamado pelo hook `Stop` do Claude Code (ver .claude/settings.json). Mantém
 * conversas sem código rápidas — não dispara o build release do Tauri à toa.
 *
 * Saída 0 sempre (mesmo pulando), para não bloquear o turno. Falhas de teste
 * são impressas para o usuário ver, mas não derrubam o hook.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')

function git(args) {
  const r = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' })
  return (r.stdout || '').trim()
}

// Arquivos modificados/staged/untracked relativos à raiz do repo.
const status = git(['status', '--porcelain'])
const changedAppFiles = status
  .split('\n')
  .map((line) => line.slice(3).trim()) // remove os 2 chars de status + espaço
  .filter(Boolean)
  .filter((f) => f.startsWith('src/') || f.startsWith('src-tauri/'))
  // ignora a própria pasta de testes e artefatos de build
  .filter((f) => !f.startsWith('src-tauri/target/'))

if (changedAppFiles.length === 0) {
  console.log('[e2e-hook] Nenhuma mudança em src/ ou src-tauri/ — pulando suíte E2E.')
  process.exit(0)
}

console.log(
  `[e2e-hook] ${changedAppFiles.length} arquivo(s) do app alterado(s) — rodando suíte E2E (tauri-driver)...`,
)

const result = spawnSync('npm', ['run', 'test:e2e'], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.status !== 0) {
  console.error('[e2e-hook] ⚠ Suíte E2E falhou (veja a saída acima).')
}

// Nunca bloqueia o turno; o resultado já foi impresso.
process.exit(0)
