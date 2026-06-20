import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const workspace = path.join(os.tmpdir(), 'fluent-coder-explorer-actions-e2e')

describe('Fluent Coder — ações do Explorador', () => {
  before(async () => {
    await $('.explorer-actions').waitForDisplayed({ timeout: 15_000 })
  })

  it('exibe as quatro ações traduzidas e acessíveis', async () => {
    for (const label of [
      'Novo arquivo',
      'Nova pasta',
      'Atualizar explorador',
      'Recolher pastas',
    ]) {
      await expect($(`button[aria-label="${label}"]`)).toBeDisplayed()
    }
  })

  it('cria uma pasta e atualiza alterações externas', async () => {
    await $('button[aria-label="Nova pasta"]').click()
    const input = await $('input[aria-label="Nome da nova pasta"]')
    await input.click()
    await input.addValue('nova-pasta')
    const confirm = await $('button[aria-label="Confirmar criação"]')
    await confirm.waitForEnabled({ timeout: 5_000 })
    await confirm.click()

    await browser.waitUntil(() => fs.existsSync(path.join(workspace, 'nova-pasta')), {
      timeout: 5_000,
    })

    fs.writeFileSync(path.join(workspace, 'externo.txt'), 'externo')
    await $('button[aria-label="Atualizar explorador"]').click()
    await $('.tree-label=externo.txt').waitForExist({ timeout: 5_000 })
  })

  it('recolhe todas as pastas expandidas', async () => {
    const srcLabel = await $('.tree-label=src')
    await srcLabel.click()
    await $('.tree-label=existente.txt').waitForExist({ timeout: 5_000 })

    const collapse = await $('button[aria-label="Recolher pastas"]')
    await expect(collapse).toBeEnabled()
    await collapse.click()
    await expect($('.tree-label=existente.txt')).not.toBeDisplayed()
    await expect(collapse).toBeDisabled()
  })

  it('cria e abre um arquivo sem usar o seletor nativo', async () => {
    await $('button[aria-label="Novo arquivo"]').click()
    const input = await $('input[aria-label="Nome do novo arquivo"]')
    await input.click()
    await input.addValue('criado.txt')
    const confirm = await $('button[aria-label="Confirmar criação"]')
    await confirm.waitForEnabled({ timeout: 5_000 })
    await confirm.click()

    await browser.waitUntil(async () => {
      const error = await $('.explorer-inline-error')
      return (
        fs.existsSync(path.join(workspace, 'nova-pasta', 'criado.txt')) ||
        error.isExisting()
      )
    }, {
      timeout: 5_000,
      timeoutMsg: 'a criação do arquivo não concluiu nem exibiu erro',
    })
    const error = await $('.explorer-inline-error')
    if (await error.isExisting()) {
      throw new Error(`Falha reportada pelo Explorador: ${await error.getText()}`)
    }
    await $('.tab-name=criado.txt').waitForExist({ timeout: 5_000 })
  })
})
