/**
 * Smoke test: garante que o app Tauri inicializa e renderiza a casca
 * principal da UI (title bar, activity bar e status bar).
 *
 * Roda contra o binário nativo via tauri-driver — não é o navegador web,
 * é a janela WebView2 real do app desktop.
 */
describe('Fluent Coder — shell', () => {
  it('renderiza a title bar com o título do app', async () => {
    const titlebar = await $('.titlebar')
    await titlebar.waitForExist({ timeout: 10_000 })
    await expect(titlebar).toBeDisplayed()

    const title = await $('.titlebar-title')
    await expect(title).toBeExisting()
  })

  it('renderiza a activity bar e a status bar', async () => {
    await expect($('.activity-bar')).toBeDisplayed()
    await expect($('.status-bar')).toBeDisplayed()
  })
})
