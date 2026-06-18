/**
 * Icon pack (Material Icon Theme + Codicons) — E2E.
 *
 * Drives the native Tauri window via tauri-driver (WebView2). The app boots with
 * no folder open and the native picker can't be driven over WebDriver, so the
 * file/folder Material icons (which need a real tree) are covered by the unit
 * tests in src/icon-theme/material/icon-resolver.test.ts. Here we verify the
 * Codicons that are always on screen render via the real codicon web-font, and
 * that the activity bar / status bar use them — proving the pack is wired, not
 * just present in the bundle.
 */

/** Reads the ::before content + font-family of an element's codicon glyph. */
async function codiconGlyph(selector: string) {
  return browser.execute((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return null
    const cs = getComputedStyle(el, '::before')
    return { content: cs.content, fontFamily: cs.fontFamily }
  }, selector)
}

describe('Code Editor — Codicons na interface', () => {
  it('a activity bar renderiza ícones Codicon (não SVGs soltos)', async () => {
    await $('.activity-bar').waitForExist({ timeout: 10_000 })

    // Cada item da activity bar tem um <span class="codicon codicon-*">.
    const explorerIcon = await $('.activity-item[data-view="explorer"] .codicon')
    await expect(explorerIcon).toBeExisting()
    const searchIcon = await $('.activity-item[data-view="search"] .codicon')
    await expect(searchIcon).toBeExisting()
  })

  it('os Codicons usam a web-font "codicon" com um glyph real', async () => {
    const glyph = await codiconGlyph(
      '.activity-item[data-view="explorer"] .codicon'
    )
    if (!glyph) throw new Error('ícone do explorer não encontrado')

    // A font-family resolvida tem que ser a fonte codicon (prova que o CSS +
    // .ttf carregaram), e o ::before tem que ter um glyph (não "none"/vazio).
    expect(glyph.fontFamily.toLowerCase()).toContain('codicon')
    expect(glyph.content).not.toBe('none')
    expect(glyph.content).not.toBe('')
    expect(glyph.content).not.toBe('normal')
  })

  it('a status bar usa Codicons para branch e diagnósticos', async () => {
    await expect($('.status-bar')).toBeDisplayed()
    // Ícones de erro/aviso são Codicons na status bar (substituem ✕/⚠ unicode).
    await expect($('.status-left .codicon-error')).toBeExisting()
    await expect($('.status-left .codicon-warning')).toBeExisting()
  })

  it('o arquivo da web-font codicon está acessível ao app', async () => {
    // Confirma que a .ttf foi embutida/servida: uma FontFace "codicon" deve
    // estar registrada no document (o @font-face do codicon.css).
    const hasFont = await browser.execute(() => {
      return Array.from(document.fonts).some((f) => f.family === 'codicon')
    })
    expect(hasFont).toBe(true)
  })
})
