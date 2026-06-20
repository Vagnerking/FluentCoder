/**
 * Verifica o menu de contexto das abas:
 * - Aparece próximo ao local do clique (position: fixed com clientX/clientY)
 * - Contém as opções esperadas
 * - Fecha ao clicar fora
 */
describe('Fluent Coder — Tab Context Menu', () => {
  const TEST_ROOT = 'C:\\Users\\Vagner\\Documents\\GitHub\\Projetos Pessoais\\CodeEditor\\src'

  before(async () => {
    // Abre uma pasta para ter arquivos disponíveis
    await browser.execute((root: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__e2e_openFolder?.(root)
    }, TEST_ROOT)
    await browser.pause(2000)

    // Clica no primeiro arquivo visível no explorer para abrir uma aba
    const firstFile = await $('.tree-file')
    if (await firstFile.isExisting()) {
      await firstFile.click()
      await browser.pause(500)
    }
  })

  it('existe pelo menos uma aba aberta', async () => {
    const tab = await $('.tab')
    await tab.waitForExist({ timeout: 5_000 })
    await expect(tab).toBeDisplayed()
  })

  it('menu de contexto aparece próximo ao cursor ao clicar com botão direito', async () => {
    const tab = await $('.tab')
    await tab.waitForExist({ timeout: 5_000 })

    // Obtém a posição da aba antes do clique
    const tabRect = await browser.execute(() => {
      const t = document.querySelector('.tab') as HTMLElement | null
      if (!t) return null
      const r = t.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })

    if (!tabRect) throw new Error('Aba não encontrada no DOM')

    // Clica com botão direito no centro da aba
    await tab.click({ button: 'right' })
    await browser.pause(300)

    // Menu deve estar visível
    const menu = await $('.tab-context-menu')
    await menu.waitForDisplayed({ timeout: 3_000 })

    // Verifica se o menu apareceu próximo ao clique (tolerância de 100px)
    const menuRect = await browser.execute(() => {
      const m = document.querySelector('.tab-context-menu') as HTMLElement | null
      if (!m) return null
      const r = m.getBoundingClientRect()
      return { left: r.left, top: r.top }
    })

    if (!menuRect) throw new Error('Menu de contexto não encontrado no DOM')

    const deltaX = Math.abs(menuRect.left - tabRect.x)
    const deltaY = Math.abs(menuRect.top - tabRect.y)

    console.log(`Clique em (${tabRect.x.toFixed(0)}, ${tabRect.y.toFixed(0)}), menu em (${menuRect.left.toFixed(0)}, ${menuRect.top.toFixed(0)}), delta=(${deltaX.toFixed(0)}, ${deltaY.toFixed(0)})`)

    // O menu deve abrir a no máximo 100px do clique em cada eixo
    expect(deltaX).toBeLessThan(100)
    expect(deltaY).toBeLessThan(100)
  })

  it('contém todas as opções esperadas', async () => {
    // Menu já deve estar aberto do teste anterior; se não, reabre
    let menu = await $('.tab-context-menu')
    if (!(await menu.isDisplayed())) {
      const tab = await $('.tab')
      await tab.click({ button: 'right' })
      await browser.pause(300)
      menu = await $('.tab-context-menu')
    }

    await menu.waitForDisplayed({ timeout: 3_000 })
    const text = await menu.getText()
    expect(text).toContain('Fechar')
    expect(text).toContain('Fechar outras')
    expect(text).toContain('Fechar à esquerda')
    expect(text).toContain('Fechar à direita')
    expect(text).toContain('Fechar todas')
  })

  it('fecha ao clicar fora do menu', async () => {
    // Reabre se fechado
    let menu = await $('.tab-context-menu')
    if (!(await menu.isDisplayed())) {
      const tab = await $('.tab')
      await tab.click({ button: 'right' })
      await browser.pause(300)
    }

    menu = await $('.tab-context-menu')
    await menu.waitForDisplayed({ timeout: 3_000 })

    // Clica fora do menu (no editor vazio ou na status bar)
    await $('.status-bar').click()
    await browser.pause(300)

    await expect($('.tab-context-menu')).not.toBeDisplayed()
  })
})
