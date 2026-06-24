/**
 * End-to-end proof of the CSHTML projection broker (ADR 0002, brick 6) against
 * the REAL SampleMvc fixture, driven through the native Tauri window.
 *
 * This is the live acceptance the unit/spike layers cannot give: it runs the
 * whole chain — flag ON → `.cshtml` gets language id `cshtml` → projection
 * starter → `razor_prepare` (`dotnet build` emits the `.g.cs`, shadow restored
 * + materialized) → standalone Roslyn over the shadow solution → pull
 * diagnostics in `.g.cs` coords → remap to the `.cshtml` via `#line` → publish
 * markers under owner `fluent-cshtml` — and asserts the deliberate CS1061 on
 * `@Model.NonExistentProperty` (Index.cshtml line 16) actually surfaces on the
 * `.cshtml` in the Problems panel.
 *
 * Run: RAZOR_PROJECTION_E2E=1 npx wdio run ./wdio.conf.ts --spec ./specs/razor-projection.e2e.ts
 * (the wdio config seeds session.json so the app boots into SampleMvc).
 *
 * Slow: the first `dotnet build` + shadow restore + Roslyn project init take
 * tens of seconds, hence the generous waits.
 */
/**
 * Dumps the app's `[lsp]` log on failure so a timeout is diagnosable: it shows
 * how far the chain got (manager.start → razor projection: preparing/prepared →
 * solution/open explícito → sent didOpen → diagnostic pull). `lspLog` mirrors to
 * the browser console, so `getLogs('browser')` surfaces it when supported.
 */
async function dumpLspLog(): Promise<void> {
  try {
    const logs = (await browser.getLogs('browser')) as Array<{ message?: string }>
    const lsp = logs
      .map((l) => String(l.message ?? ''))
      .filter((m) => m.includes('[lsp]') || /razor projection|razor_prepare|openRoslyn/i.test(m))
    // eslint-disable-next-line no-console
    console.log(`\n===== LSP LOG (${lsp.length} linhas) =====\n${lsp.join('\n')}\n=====`)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('getLogs("browser") indisponível neste driver:', String(e))
  }
}

describe('Fluent Coder — projeção .cshtml (broker ADR 0002) ao vivo', () => {
  it('liga a flag, abre Index.cshtml e o CS1061 aparece no .cshtml', async function () {
    this.timeout(330_000)

    // App booted into the SampleMvc folder (seeded by wdio.conf). Wait until the
    // tree has actually rendered the project (deterministic; avoids the Quick
    // wdio.conf seeded the session so the app boots into SampleMvc with
    // Index.cshtml ALREADY restored as a tab (a proven path that avoids the
    // tree-expand / Quick Open index races that hang the WebView under the
    // driver). At this first boot the flag is OFF, so it opened as the cohost id.
    await $('.explorer').waitForExist({ timeout: 30_000 })
    await $('.tab-name=Index.cshtml').waitForExist({ timeout: 30_000 })

    // Flip the flag ON and reload: on the next boot the session restore reopens
    // Index.cshtml with the flag set → language id `cshtml` → projection starter.
    await browser.execute(() => localStorage.setItem('lsp.razorProjection', '1'))
    await browser.execute(() => location.reload())
    await browser.pause(3_000)
    await $('.explorer').waitForExist({ timeout: 30_000 })
    await $('.tab-name=Index.cshtml').waitForExist({ timeout: 30_000 })
    await $('.monaco-editor').waitForExist({ timeout: 20_000 })

    // Wait for the whole projection chain to surface the CS1061 onto the
    // `.cshtml`: the global error counter (only this model open) goes >= 1.
    try {
      await browser.waitUntil(
        async () => {
          const t = await $('.status-diag-error')
            .getText()
            .catch(() => '')
          const n = parseInt((t.match(/\d+/) || ['0'])[0], 10)
          return n >= 1
        },
        {
          timeout: 290_000,
          interval: 3_000,
          timeoutMsg:
            'A projeção .cshtml não produziu nenhum erro C# (esperado CS1061 em Index.cshtml). ' +
            'A cadeia razor_prepare → Roslyn → remap não surgiu no editor.',
        },
      )
    } catch (err) {
      await dumpLspLog()
      throw err
    }

    // Open the Problems panel and assert the SPECIFIC diagnostic: the CS1061 on
    // `@Model.NonExistentProperty`, mapped to the `.cshtml` at line 16.
    await $('.status-diagnostics').click()
    await browser.waitUntil(
      async () => {
        const rows = await $$('.problem-row.problem-error')
        for (const row of rows) {
          const msg = await row.$('.problem-message').getText().catch(() => '')
          if (!/NonExistentProperty/i.test(msg)) continue
          const loc = await row.$('.problem-location').getText().catch(() => '')
          // `.problem-location` renders `{name} [{line}, {column}]` → line 16.
          if (/\[\s*16\s*,/.test(loc)) return true
        }
        return false
      },
      {
        timeout: 30_000,
        interval: 1_000,
        timeoutMsg:
          'O CS1061 (NonExistentProperty) mapeado para Index.cshtml linha 16 não ' +
          'apareceu no painel Problemas (owner fluent-cshtml).',
      },
    )
  })
})
