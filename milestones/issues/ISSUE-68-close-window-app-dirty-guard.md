# ISSUE-68 · Guarda ao fechar a janela e ao trocar de pasta com abas sujas

**Épico:** [Guarda de Alterações Não Salvas](../EPIC-unsaved-changes-guard.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 66, 67 · **Status:** ⬜ Pendente

## Contexto

A guarda da ISSUE-67 protege o fechamento de **uma** aba. Esta issue estende a proteção para dois
fluxos que descartam **toda a sessão** de uma vez: (a) **fechar a janela / encerrar o app** e
(b) **trocar de pasta** (abrir outra pasta com abas sujas abertas). Em ambos, se houver qualquer
`OpenFile.dirty === true`, o usuário deve confirmar antes de perder o trabalho.

Para o fechamento da janela, é preciso interceptar o evento `onCloseRequested` da janela Tauri,
chamar `preventDefault()` para impedir o fechamento imediato e, havendo abas sujas, abrir um
`ConfirmDialog` (ISSUE-66) em lote: **Salvar tudo** / **Descartar tudo** / **Cancelar**. Só depois de
resolvida a escolha o fechamento real é executado (ou abortado). É essencial **não travar** o
encerramento: se o usuário confirmar, o app deve realmente fechar.

Para a troca de pasta, o mesmo diálogo em lote roda antes de descartar a sessão atual (os `openFiles`
da pasta corrente). Reusa-se o `ConfirmDialog` e a lógica de "salvar tudo" desta própria issue.

## Tarefas

- [ ] Interceptar `onCloseRequested` da janela Tauri em [App.tsx](../../src/App.tsx) (ou no bootstrap da janela),
      chamando `event.preventDefault()` quando houver abas sujas.
- [ ] Coletar todos os `openFiles` com `dirty=true`; se a lista estiver vazia, deixar o fechamento seguir normalmente.
- [ ] Abrir `ConfirmDialog` em lote com **Salvar tudo** (primary, default), **Descartar tudo** (danger) e **Cancelar** (secondary).
- [ ] **Salvar tudo**: gravar cada arquivo sujo pelo fluxo de save existente; se todos derem certo,
      prosseguir com o fechamento real da janela; se algum falhar, **abortar** o fechamento e manter o app aberto.
- [ ] **Descartar tudo**: fechar a janela imediatamente, sem gravar.
- [ ] **Cancelar / Esc**: abortar o fechamento (janela permanece aberta).
- [ ] Disparar o fechamento real via API da janela Tauri (`appWindow.close()` / `destroy`) após a confirmação.
- [ ] Aplicar a mesma confirmação em lote no fluxo de **trocar de pasta** (`pickFolder` + carregar nova sessão)
      antes de descartar os `openFiles` atuais.
- [ ] Garantir que, sem abas sujas, nem o fechamento nem a troca de pasta exibam diálogo.

## Arquivos

- `src/App.tsx` (listener de `onCloseRequested`, guarda na troca de pasta, integração com `ConfirmDialog`, modificado)
- `src/components/ConfirmDialog.tsx` (consumido; criado na ISSUE-66)

## Detalhes técnicos

- Usar a API de janela do Tauri para `onCloseRequested` (`getCurrentWindow().onCloseRequested(...)`) e
  `preventDefault()`; só chamar o fechamento real (`window.close()`/`destroy()`) após a decisão do usuário.
- Cuidado com **reentrância**: ao chamar o fechamento real depois do diálogo, esse fechamento pode
  reentrar no mesmo handler — usar uma flag (ex.: `confirmedClose`) para deixar passar o segundo evento
  sem reabrir o diálogo.
- "Salvar tudo" reusa o fluxo de save por arquivo já existente em [App.tsx](../../src/App.tsx) (mesma
  função usada na ISSUE-67); aguardar todas as gravações (`Promise.all`/sequencial) antes de fechar.
- Em erro de gravação no "Salvar tudo", **não** fechar: manter o app aberto com as abas problemáticas
  ainda sujas e reportar o erro (mantendo o `window.alert` atual).
- O fluxo é assíncrono: como `onCloseRequested` não aguarda Promises, a ordem correta é
  `preventDefault()` → abrir diálogo → ao resolver, chamar o fechamento real.
- A troca de pasta deve passar pela mesma confirmação antes de substituir a sessão (`session.json`/`openFiles`),
  evitando perder edições silenciosamente.

## Critérios de aceite

- [ ] Fechar a janela com abas sujas é interceptado e exibe o diálogo em lote (Salvar tudo / Descartar tudo / Cancelar).
- [ ] **Salvar tudo** grava todos os arquivos e então a janela fecha; se uma gravação falhar, o app não fecha.
- [ ] **Descartar tudo** fecha a janela imediatamente.
- [ ] **Cancelar / Esc** mantêm a janela aberta.
- [ ] Sem abas sujas, a janela fecha direto, sem diálogo.
- [ ] Trocar de pasta com abas sujas exibe a mesma confirmação antes de descartar a sessão.
- [ ] O encerramento não trava nem entra em loop de diálogo (reentrância tratada).
- [ ] `tsc --noEmit` sem erros.
