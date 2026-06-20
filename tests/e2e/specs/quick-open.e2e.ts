/**
 * Quick Open (Ctrl+P) — file search by name.
 *
 * Drives the native Tauri window via tauri-driver (WebView2). The palette opens
 * with a keyboard chord, focuses its input, and closes on Esc / clicking the
 * backdrop.
 *
 * Note on scope: the app boots with no folder open, and the native folder
 * picker can't be driven over WebDriver, so these tests cover the palette's
 * open/close/focus behavior and its honest empty state. The actual fuzzy
 * ranking is covered by the unit tests in src/quickOpen/fuzzy.test.ts.
 */

/** Sends Ctrl+P to the focused window via WebDriver's Actions API. */
async function pressCtrlP() {
  await browser.keys(['Control', 'p'])
}

describe('Fluent Coder — Quick Open (Ctrl+P)', () => {
  it('Ctrl+P abre a palette com o input focado', async () => {
    // Garante um ponto de partida estável: nenhuma palette aberta.
    await expect($('.quick-open')).not.toBeExisting()

    await pressCtrlP()

    const palette = await $('.quick-open')
    await palette.waitForDisplayed({ timeout: 5_000 })

    const input = await $('.quick-open-input')
    await expect(input).toBeDisplayed()
    // O input recebe foco automaticamente ao abrir.
    await expect(input).toBeFocused()
  })

  it('a palette mostra um estado honesto e não trava', async () => {
    // (palette já aberta do teste anterior; reabre se necessário)
    if (!(await $('.quick-open').isExisting())) {
      await pressCtrlP()
      await $('.quick-open').waitForDisplayed({ timeout: 5_000 })
    }
    // O app pode reabrir a última pasta da sessão (feature de "reabrir último
    // projeto"), então o estado depende de haver pasta ou não — sem assumir
    // sessão limpa: o placeholder é sempre uma das duas mensagens honestas, e
    // a palette ou lista resultados ou mostra o vazio honesto (nunca trava).
    const input = await $('.quick-open-input')
    const placeholder = await input.getAttribute('placeholder')
    expect(placeholder).toMatch(/pasta|arquivo/i)

    const hasResults = await $('.quick-open-item').isExisting()
    const hasEmpty = await $('.quick-open-empty').isExisting()
    expect(hasResults || hasEmpty).toBe(true)
  })

  it('Esc fecha a palette', async () => {
    if (!(await $('.quick-open').isExisting())) {
      await pressCtrlP()
      await $('.quick-open').waitForDisplayed({ timeout: 5_000 })
    }
    await browser.keys(['Escape'])
    await expect($('.quick-open')).not.toBeExisting()
  })

  it('clicar no backdrop fora da palette também fecha', async () => {
    await pressCtrlP()
    await $('.quick-open').waitForDisplayed({ timeout: 5_000 })

    // Clica no canto superior esquerdo do backdrop (longe da palette centrada).
    await browser.execute(() => {
      const backdrop = document.querySelector(
        '.quick-open-backdrop'
      ) as HTMLElement | null
      backdrop?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 2, clientY: 2 })
      )
    })

    await expect($('.quick-open')).not.toBeExisting()
  })
})
