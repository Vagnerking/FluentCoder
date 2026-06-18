/**
 * Diagnóstico do Git Lens: abre o CLAUDE.md da raiz (sempre visível na árvore
 * do projeto ativus-new, que a sessão reabre no launch) e inspeciona o DOM real
 * do Monaco para descobrir por que as anotações de blame não aparecem.
 */
describe('Git Lens — diagnóstico de renderização', () => {
  it('abre CLAUDE.md e inspeciona as decorações de blame', async () => {
    await $('.editor-host, .editor-empty').waitForExist({ timeout: 15_000 })

    // Lista os labels visíveis na árvore (para diagnóstico, caso algo falhe).
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.tree-label')).map((e) => e.textContent),
    )
    // eslint-disable-next-line no-console
    console.log('\n=== TREE LABELS ===\n' + JSON.stringify(labels) + '\n')

    // Abre o CLAUDE.md da raiz (arquivo, não pasta — abre direto no editor).
    const claude = await $('.tree-label=CLAUDE.md')
    await claude.waitForExist({ timeout: 15_000 })
    await claude.click()

    // Espera o Monaco montar e o blame ser aplicado (loadBlame é async + git).
    await $('.monaco-editor').waitForExist({ timeout: 15_000 })
    await browser.pause(4000)

    const report = await browser.execute(() => {
      const result: Record<string, unknown> = {}

      const inline = Array.from(
        document.querySelectorAll('.git-lens-inline, .git-lens-inline-active'),
      )
      result.inlineCount = inline.length

      const allViewLines = document.querySelectorAll('.view-line')
      result.viewLineCount = allViewLines.length

      result.firstFew = inline.slice(0, 3).map((el) => {
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return {
          tag: el.tagName,
          className: el.className,
          textContent: (el.textContent || '').slice(0, 80),
          color: cs.color,
          display: cs.display,
          fontSize: cs.fontSize,
          visibility: cs.visibility,
          opacity: cs.opacity,
          offsetWidth: (el as HTMLElement).offsetWidth,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        }
      })

      // HTML bruto das 3 primeiras linhas — mostra como o Monaco serializou
      // a injeção `after` (ou se nem injetou).
      result.lineHTMLs = Array.from(allViewLines)
        .slice(0, 3)
        .map((l) => (l as HTMLElement).innerHTML.slice(0, 600))

      // O texto do autor aparece em algum lugar do DOM?
      const bodyText = document.body.innerText || ''
      result.bodyMentionsAuthor =
        bodyText.includes('Rafael') ||
        bodyText.includes('Vagner') ||
        bodyText.includes('há ')

      // Procura QUALQUER span de injeção do Monaco (classe mtk* + nossa classe).
      const anyInjected = document.querySelectorAll('[class*="git-lens"]')
      result.anyGitLensSpanCount = anyInjected.length

      return result
    })

    // eslint-disable-next-line no-console
    console.log(
      '\n=== GIT LENS DIAGNÓSTICO ===\n' +
        JSON.stringify(report, null, 2) +
        '\n=== FIM ===\n',
    )

    await expect($('.monaco-editor')).toBeDisplayed()
  })
})
