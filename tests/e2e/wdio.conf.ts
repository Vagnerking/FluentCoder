import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')

// Caminho do binário compilado do app Tauri (modo debug).
// Gerado por `cargo build` dentro de src-tauri.
const appBinary = path.resolve(
  projectRoot,
  'src-tauri',
  'target',
  'release',
  os.platform() === 'win32' ? 'fluent-coder.exe' : 'fluent-coder',
)

let tauriDriver: ChildProcess
const explorerActionsE2e = process.env.EXPLORER_ACTIONS_E2E === '1'
// Razor projection E2E: boot the app already pointed at the real SampleMvc
// fixture so the `.cshtml` projection broker can run end-to-end against it.
const razorProjectionE2e = process.env.RAZOR_PROJECTION_E2E === '1'
const explorerWorkspace = path.join(os.tmpdir(), 'fluent-coder-explorer-actions-e2e')
const sampleMvc = path.resolve(
  projectRoot,
  'tools',
  'razor-lsp-probe',
  'fixtures',
  'SampleMvc',
)
const sessionFile = path.join(
  process.env.APPDATA ?? '',
  'com.fluentcoder.app',
  'session.json',
)
let previousSession: string | null = null

export const config: WebdriverIO.Config = {
  // tauri-driver expõe um servidor WebDriver em 127.0.0.1:4444 por padrão.
  hostname: '127.0.0.1',
  port: 4444,
  path: '/',

  specs: ['./specs/gitlens.e2e.ts'],
  maxInstances: 1,

  capabilities: [
    {
      // Capabilities específicas do tauri-driver.
      'tauri:options': {
        application: appBinary,
      },
    } as WebdriverIO.Capabilities,
  ],

  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    // The Razor projection spec runs the full live chain (dotnet build + shadow
    // restore + Roslyn project init + streamed diagnostics), which far exceeds
    // the default 60s. Per-test `this.timeout()` is unreliable under wdio's
    // mocha, so the ceiling is set here for that run.
    timeout: razorProjectionE2e ? 450_000 : 60_000,
  },

  // Compila o app em release antes de iniciar a suíte.
  //
  // IMPORTANTE: precisa ser `tauri build`, NÃO `cargo build --release`. Só a CLI
  // do Tauri roda o beforeBuildCommand (gera dist/) e, principalmente, compila o
  // binário em modo produção — que serve os assets embutidos de dist/. Um
  // `cargo build` direto produz um binário que ainda aponta para o devUrl
  // (localhost:1420), e a WebView abre em "localhost refused to connect".
  // --no-bundle pula a geração de instaladores (.msi/.exe), bem mais rápido.
  onPrepare: () => {
    if (process.env.E2E_SKIP_BUILD !== '1') {
      const r = spawnSync('npx', ['tauri', 'build', '--no-bundle'], {
        cwd: projectRoot,
        stdio: 'inherit',
        shell: os.platform() === 'win32',
      })
      if (r.status !== 0) {
        throw new Error(`"tauri build --no-bundle" falhou (status ${r.status})`)
      }
    }
    if (razorProjectionE2e) {
      // Warm SampleMvc's build (restore + emit the Razor `.g.cs`) so the in-test
      // broker emit is incremental, keeping the live chain well under the test
      // timeout. The build itself fails on the deliberate CS1061 — that's fine;
      // restore + the generated files are produced before the compile error.
      // Run from the project dir with a RELATIVE csproj so the space in the repo
      // path ("Projetos Pessoais") doesn't get split into two args by the shell
      // (which caused MSB1008 "Only one project can be specified").
      spawnSync(
        'dotnet',
        ['build', 'SampleMvc.csproj', '-c', 'Debug', '-p:EmitCompilerGeneratedFiles=true'],
        { cwd: sampleMvc, stdio: 'inherit', shell: os.platform() === 'win32' },
      )
    }
  },

  // Sobe o tauri-driver antes de cada sessão e derruba ao final.
  beforeSession: () => {
    if (explorerActionsE2e) {
      previousSession = fs.existsSync(sessionFile)
        ? fs.readFileSync(sessionFile, 'utf8')
        : null
      fs.rmSync(explorerWorkspace, { recursive: true, force: true })
      fs.mkdirSync(path.join(explorerWorkspace, 'src'), { recursive: true })
      fs.writeFileSync(path.join(explorerWorkspace, 'src', 'existente.txt'), 'conteúdo')
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
      fs.writeFileSync(
        sessionFile,
        JSON.stringify({ lastFolder: explorerWorkspace }, null, 2),
      )
    }
    if (razorProjectionE2e) {
      // Boot the app into SampleMvc with Index.cshtml ALREADY restored as a tab.
      // Restoring a tab (read_file) is a proven path; it sidesteps the explorer
      // tree-expand / Quick Open index races that hang the WebView under the
      // driver. The spec then flips the flag and reloads so the tab reopens as
      // `cshtml` → projection.
      previousSession = fs.existsSync(sessionFile)
        ? fs.readFileSync(sessionFile, 'utf8')
        : null
      const indexCshtml = path.join(sampleMvc, 'Views', 'Home', 'Index.cshtml')
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
      fs.writeFileSync(
        sessionFile,
        JSON.stringify(
          {
            lastFolder: sampleMvc,
            openTabs: [{ path: indexCshtml, mode: 'text' }],
            activePath: indexCshtml,
          },
          null,
          2,
        ),
      )
    }
    tauriDriver = spawn('tauri-driver', [], {
      stdio: [null, process.stdout, process.stderr],
      shell: false,
    })
  },

  afterSession: async () => {
    tauriDriver?.kill()
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (explorerActionsE2e) {
      if (previousSession === null) fs.rmSync(sessionFile, { force: true })
      else fs.writeFileSync(sessionFile, previousSession)
      try {
        fs.rmSync(explorerWorkspace, { recursive: true, force: true })
      } catch {
        // WebView2 may release the workspace a few milliseconds after this hook.
      }
    }
    if (razorProjectionE2e) {
      if (previousSession === null) fs.rmSync(sessionFile, { force: true })
      else fs.writeFileSync(sessionFile, previousSession)
    }
  },
}
