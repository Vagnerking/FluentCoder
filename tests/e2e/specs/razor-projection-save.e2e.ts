/**
 * Regression repro (reported): the CSHTML projection CS1061 appears, but after a
 * trivial EDIT + SAVE of the `.cshtml` the diagnostic vanishes ("buga tudo").
 *
 * The save dispatches `fluent:file-saved` → `scheduleReprepare` → `reprepare`,
 * which re-runs `razorPrepare` (a `dotnet build -p:EmitCompilerGeneratedFiles=true`
 * of the user project). That build can repopulate the user project's
 * `obj/.../generated/*.g.cs` (the SDK writes them even with the pinned output
 * path), and via the shadow's ProjectReference Roslyn may pull the duplicate page
 * class back in → CS0101/CS0111/CS0229 flood → the real CS1061 is suppressed.
 *
 * This spec asserts the CS1061 SURVIVES an edit+save round trip.
 * Run: RAZOR_PROJECTION_E2E=1 npx wdio run ./wdio.conf.ts --spec ./specs/razor-projection-save.e2e.ts
 */

async function errorCount(): Promise<number> {
  const t = await $('.status-diag-error').getText().catch(() => '')
  return parseInt((t.match(/\d+/) || ['0'])[0], 10)
}

describe('Fluent Coder — projeção .cshtml sobrevive a edit + save', () => {
  it('CS1061 permanece após editar e salvar o .cshtml', async function () {
    this.timeout(330_000)

    // Boot into SampleMvc, flip projection flag, reload → Index.cshtml as cshtml.
    await $('.explorer').waitForExist({ timeout: 30_000 })
    await $('.tab-name=Index.cshtml').waitForExist({ timeout: 30_000 })
    await browser.execute(() => localStorage.setItem('lsp.razorProjection', '1'))
    await browser.execute(() => location.reload())
    await browser.pause(3_000)
    await $('.explorer').waitForExist({ timeout: 30_000 })
    await $('.tab-name=Index.cshtml').waitForExist({ timeout: 30_000 })
    await $('.monaco-editor').waitForExist({ timeout: 20_000 })

    // 1. Baseline: the CS1061 surfaces on first open.
    await browser.waitUntil(async () => (await errorCount()) >= 1, {
      timeout: 290_000,
      interval: 3_000,
      timeoutMsg: 'baseline: o CS1061 não apareceu no primeiro open',
    })

    // 2. Edit the .cshtml (type a harmless char at end of an HTML line) and SAVE.
    //    Click into the editor, go to end of a safe line, type a space, save.
    await $('.monaco-editor').click()
    await browser.keys(['Control', 'Home'])
    // Move to the end of line 13 (`<p>Tipo: @Model.Kind</p>`) — append a space in
    // HTML text so the projection still emits a valid `.g.cs` (no syntax break).
    for (let i = 0; i < 12; i++) await browser.keys(['ArrowDown'])
    await browser.keys(['End'])
    await browser.keys([' '])
    await browser.pause(500)
    await browser.keys(['Control', 's']) // save → fluent:file-saved → reprepare

    // 3. The diagnostic must SURVIVE the save (reprepare must not reintroduce the
    //    duplicate-type flood). Allow time for the reprepare `dotnet build` +
    //    re-pull, then assert it ends with the error still present.
    await browser.waitUntil(async () => (await errorCount()) >= 1, {
      timeout: 90_000,
      interval: 2_000,
      timeoutMsg:
        'REGRESSÃO: o CS1061 sumiu após editar + salvar o .cshtml ' +
        '(reprepare reintroduziu a duplicação / dessincronizou a projeção).',
    })

    // 4. And it must STAY (not flicker back off after the retries settle).
    await browser.pause(8_000)
    const finalCount = await errorCount()
    if (finalCount < 1) {
      throw new Error('REGRESSÃO: o CS1061 reapareceu e sumiu de novo após o save (instável).')
    }
  })
})
