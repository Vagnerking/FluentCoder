/**
 * Smoke test: garante que o app Tauri inicializa e renderiza a casca
 * principal da UI (title bar, activity bar e status bar).
 *
 * Roda contra o binário nativo via tauri-driver — não é o navegador web,
 * é a janela WebView2 real do app desktop.
 *
 * O binário de teste é buildado com `tauri build --debug` (profile.dev, opt-level
 * baixo) para builds rápidas: ele BOOTA mais devagar que o release, então o
 * primeiro paint do WebView2 pode passar de 10s sob a contenção do driver. Por
 * isso o gate de boot (`waitForExist` da casca) usa um timeout folgado e TODAS as
 * asserções seguintes só rodam depois que a casca existe — sem isso a 2ª it()
 * falhava consultando `.activity-bar` enquanto o app ainda pintava.
 */
const BOOT_TIMEOUT = 30_000

describe('Fluent Coder — shell', () => {
  before(async () => {
    // Gate de boot único: espera a casca principal aparecer antes de qualquer
    // asserção. Cobre o boot mais lento do binário debug.
    await $('.titlebar').waitForExist({ timeout: BOOT_TIMEOUT })
  })

  it('renderiza a title bar com o título do app', async () => {
    await expect($('.titlebar')).toBeDisplayed()
    await expect($('.titlebar-title')).toBeExisting()
  })

  it('renderiza a activity bar e a status bar', async () => {
    await expect($('.activity-bar')).toBeDisplayed()
    await expect($('.status-bar')).toBeDisplayed()
  })
})
