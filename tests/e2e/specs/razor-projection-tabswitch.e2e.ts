/**
 * Regression repro (reported bug): the CSHTML projection diagnostic (CS1061)
 * appears on first open, but DISAPPEARS after the user visits another file,
 * edits it, and returns to the `.cshtml` tab.
 *
 * Root-cause hypothesis: a single `<Editor>` per group with `path={modelPath}`
 * and no `keepCurrentModel` makes `@monaco-editor/react` DISPOSE the `.cshtml`
 * model on every tab switch → `onWillDisposeModel` → `forgetDoc` clears markers +
 * `razorForget`. Returning recreates the model and `scheduleReprepare`s, but the
 * recovery races the async teardown / leaves the projection stale, so the
 * squiggle never comes back.
 *
 * This spec drives the EXACT reported sequence and asserts the diagnostic
 * survives the round trip. Run:
 *   RAZOR_PROJECTION_E2E=1 npx wdio run ./wdio.conf.ts --spec ./specs/razor-projection-tabswitch.e2e.ts
 */

/** Mirror the webview console into an in-page buffer so we can dump the `[lsp]`
 * trace on failure (getLogs('browser') is unavailable under this driver). */
async function installConsoleCapture(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __lspLogs?: string[] }
    if (w.__lspLogs) return
    w.__lspLogs = []
    const orig = console.log.bind(console)
    console.log = (...args: unknown[]) => {
      try {
        w.__lspLogs!.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      } catch {
        /* ignore serialization failures */
      }
      orig(...args)
    }
  })
}

async function dumpCaptured(): Promise<void> {
  try {
    const logs = (await browser.execute(() => {
      const w = window as unknown as { __lspLogs?: string[] }
      return (w.__lspLogs ?? []).filter(
        (m) => m.includes('[lsp]') || /razor projection|razor_prepare|forgetDoc|reprepare/i.test(m)
      )
    })) as string[]
    // eslint-disable-next-line no-console
    console.log(`\n===== LSP LOG (${logs.length} linhas) =====\n${logs.join('\n')}\n=====`)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('console capture indisponível:', String(e))
  }
}

/** Current global C# error count shown in the status bar (0 if none). */
async function errorCount(): Promise<number> {
  const t = await $('.status-diag-error')
    .getText()
    .catch(() => '')
  return parseInt((t.match(/\d+/) || ['0'])[0], 10)
}

describe('Fluent Coder — projeção .cshtml sobrevive a troca de aba', () => {
  it('CS1061 permanece após editar outro arquivo e voltar ao .cshtml', async function () {
    this.timeout(330_000)

    // 1. Boot into SampleMvc (seeded by wdio.conf), flip the projection flag and
    //    reload so Index.cshtml reopens as `cshtml` → projection.
    await $('.explorer').waitForExist({ timeout: 30_000 })
    await $('.tab-name=Index.cshtml').waitForExist({ timeout: 30_000 })
    await browser.execute(() => localStorage.setItem('lsp.razorProjection', '1'))
    await browser.execute(() => location.reload())
    await browser.pause(3_000)
    await $('.explorer').waitForExist({ timeout: 30_000 })
    await $('.tab-name=Index.cshtml').waitForExist({ timeout: 30_000 })
    await $('.monaco-editor').waitForExist({ timeout: 20_000 })
    await installConsoleCapture()

    // 2. Baseline: the projection brings the CS1061 up on first open (the boot fix).
    try {
      await browser.waitUntil(async () => (await errorCount()) >= 1, {
        timeout: 290_000,
        interval: 3_000,
        timeoutMsg: 'baseline: a projeção não trouxe o CS1061 no primeiro open',
      })
    } catch (err) {
      await dumpCaptured()
      throw err
    }

    // 3. Open Program.cs (a real C# file in the project), edit it, then return.
    //    This is the reported trigger: visiting + editing another file mid-session.
    await $('.tree-label=Program.cs').click()
    await $('.tab-name=Program.cs').waitForExist({ timeout: 15_000 })
    await browser.pause(1_500)
    // Type into the editor so the C# buffer changes (mirrors "editei outro arquivo").
    await browser.keys(['Control', 'End'])
    await browser.keys([' ', '/', '/', ' ', 'x'])
    await browser.pause(1_500)

    // Back to the .cshtml tab.
    await $('.tab-name=Index.cshtml').click()
    await $('.monaco-editor').waitForExist({ timeout: 15_000 })

    // 4. The diagnostic must SURVIVE the round trip. Give the projection a window
    //    to re-settle (reprepare debounce + pull retries), but it must end >= 1.
    try {
      await browser.waitUntil(async () => (await errorCount()) >= 1, {
        timeout: 60_000,
        interval: 2_000,
        timeoutMsg:
          'REGRESSÃO: o CS1061 sumiu após editar outro arquivo e voltar ao .cshtml ' +
          '(a projeção não republicou os markers na reativação da aba).',
      })
    } catch (err) {
      await dumpCaptured()
      throw err
    }
  })
})
