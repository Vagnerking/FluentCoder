/**
 * Exercises the features that were previously "visual-only" to prove they are
 * now wired up: the ActivityBar actually swaps the sidebar view, the Search
 * and Git panels render their real UI, and unimplemented views show an honest
 * "Em breve." placeholder instead of pretending to work.
 *
 * Runs against the native Tauri window via tauri-driver (WebView2).
 */
describe('Code Editor — ActivityBar swaps the sidebar', () => {
  it('mostra o Explorer por padrão', async () => {
    const explorer = await $('.explorer')
    await explorer.waitForExist({ timeout: 10_000 })
    await expect(explorer).toBeDisplayed()
  })

  it('clicar em Pesquisar troca para o painel de busca (com input real)', async () => {
    await $('.activity-item[data-view="search"]').click()

    const searchPanel = await $('.search-panel')
    await searchPanel.waitForDisplayed({ timeout: 5_000 })

    // A busca de verdade tem um campo de input — não é só ícone.
    await expect($('.search-input')).toBeDisplayed()

    // E o Explorer não está mais montado na sidebar.
    await expect($('.explorer')).not.toBeExisting()
  })

  it('clicar em Git abre o painel de controle de código (real, não placeholder)', async () => {
    await $('.activity-item[data-view="git"]').click()
    const gitPanel = await $('.git-panel')
    await gitPanel.waitForDisplayed({ timeout: 5_000 })
    // É o painel de Git de verdade, não o placeholder "Em breve.".
    await expect($('.placeholder-panel')).not.toBeExisting()
    await expect(gitPanel).toHaveText(expect.stringContaining('CONTROLE DE CÓDIGO'))
  })

  it('clicar em Executar e Depurar abre o RunPanel (real, não placeholder)', async () => {
    await $('.activity-item[data-view="debug"]').click()
    const runPanel = await $('.run-panel')
    await runPanel.waitForDisplayed({ timeout: 5_000 })
    await expect($('.placeholder-panel')).not.toBeExisting()
    await expect(runPanel).toHaveText(expect.stringContaining('EXECUTAR E DEPURAR'))
  })

  it('Contas ainda mostra placeholder honesto "Em breve."', async () => {
    await $('.activity-item[data-view="account"]').click()
    const placeholder = await $('.placeholder-panel')
    await placeholder.waitForDisplayed({ timeout: 5_000 })
    await expect(placeholder).toHaveText(expect.stringContaining('Em breve'))
  })

  it('volta para o Explorer ao clicar em Explorador', async () => {
    await $('.activity-item[data-view="explorer"]').click()
    await expect($('.explorer')).toBeDisplayed()
  })

  it('o conteúdo do painel não ultrapassa a largura da sidebar', async () => {
    // Abre o painel do Git, que tem o título mais longo ("CONTROLE DE
    // CÓDIGO-FONTE") — exatamente o caso do bug de transbordo reportado.
    await $('.activity-item[data-view="git"]').click()
    await $('.git-panel').waitForDisplayed({ timeout: 5_000 })

    // O retângulo do conteúdo do painel deve caber dentro da sidebar — sem
    // vazar pela direita (o bug que o overflow:hidden + min-width:0 corrige).
    const box = await browser.execute(() => {
      const sidebar = document.querySelector('.sidebar') as HTMLElement | null
      const panel = document.querySelector('.git-panel') as HTMLElement | null
      if (!sidebar || !panel) return null
      const s = sidebar.getBoundingClientRect()
      const p = panel.getBoundingClientRect()
      return {
        sidebarRight: s.right,
        panelRight: p.right,
        // scrollWidth > clientWidth indicaria conteúdo transbordando.
        sidebarScroll: sidebar.scrollWidth,
        sidebarClient: sidebar.clientWidth,
      }
    })

    if (!box) throw new Error('sidebar/git-panel não encontrados')
    // Permite 1px de folga por arredondamento de subpixel.
    expect(box.panelRight).toBeLessThanOrEqual(box.sidebarRight + 1)
    expect(box.sidebarScroll).toBeLessThanOrEqual(box.sidebarClient + 1)
  })
})

describe('Code Editor — StatusBar', () => {
  it('mostra os contadores de diagnóstico reais com ícones Codicon', async () => {
    const statusBar = await $('.status-bar')
    await expect(statusBar).toBeDisplayed()

    // Os ícones agora são Codicons (web-font), não mais glyphs unicode no
    // texto. Conferimos que os ícones de erro/aviso existem na status bar...
    await expect($('.status-left .codicon-error')).toBeExisting()
    await expect($('.status-left .codicon-warning')).toBeExisting()

    // ...e que os contadores reais (0 erros / 0 avisos sem arquivo aberto)
    // continuam visíveis ao lado deles.
    await expect(statusBar).toHaveText(expect.stringContaining('0'))
  })
})
