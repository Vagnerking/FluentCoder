import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
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
  os.platform() === 'win32' ? 'code-editor.exe' : 'code-editor',
)

let tauriDriver: ChildProcess

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
    timeout: 60_000,
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
    const r = spawnSync('npx', ['tauri', 'build', '--no-bundle'], {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: os.platform() === 'win32',
    })
    if (r.status !== 0) {
      throw new Error(`"tauri build --no-bundle" falhou (status ${r.status})`)
    }
  },

  // Sobe o tauri-driver antes de cada sessão e derruba ao final.
  beforeSession: () => {
    tauriDriver = spawn('tauri-driver', [], {
      stdio: [null, process.stdout, process.stderr],
      shell: os.platform() === 'win32',
    })
  },

  afterSession: () => {
    tauriDriver?.kill()
  },
}
