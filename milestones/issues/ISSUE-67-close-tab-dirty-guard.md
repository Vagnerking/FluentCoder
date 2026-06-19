# ISSUE-67 · Guarda ao fechar aba com alterações não salvas

**Épico:** [Guarda de Alterações Não Salvas](../EPIC-unsaved-changes-guard.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 66 · **Status:** ⬜ Pendente

## Contexto

Hoje, fechar uma aba descarta silenciosamente as alterações não salvas. Esta issue adiciona uma guarda:
ao tentar fechar uma aba cujo `OpenFile.dirty === true`, o app deve perguntar ao usuário o que fazer
antes de descartar o conteúdo. Vale para todos os caminhos de fechamento: clique no **X** da aba,
atalho **Ctrl+W** e o item **Fechar** do menu de contexto da aba.

A pergunta usa o `ConfirmDialog` (ISSUE-66) com a mensagem "Deseja salvar as alterações em `<nome>`?"
e três opções: **Salvar**, **Não salvar** e **Cancelar**. Em **Salvar**, grava pelo fluxo de save já
existente em [App.tsx](../../src/App.tsx) (gravação via `write_file`) e só então fecha a aba; se a
gravação falhar, a aba **permanece aberta** e suja. Em **Não salvar**, descarta e fecha. Em
**Cancelar** (ou Esc), aborta — nada muda.

Como a decisão agora depende de uma interação assíncrona do usuário, o callback `onClose(path)` precisa
deixar de ser síncrono e passar a retornar uma `Promise`. O ponto "não salvo" (`tab-dirty-dot`) em
[TabBar.tsx](../../src/components/TabBar.tsx) continua indicando o estado; é ele que dispara o
`onClose(path)` no X e no menu de aba.

## Tarefas

- [ ] Em [App.tsx](../../src/App.tsx), tornar `onClose` assíncrono: ao fechar um arquivo com `dirty=true`,
      abrir o `ConfirmDialog` antes de remover de `openFiles`.
- [ ] Mensagem "Deseja salvar as alterações em `<nome>`?" com botões **Salvar** (primary, default),
      **Não salvar** (danger/secondary) e **Cancelar** (secondary).
- [ ] **Salvar**: invocar o fluxo de save existente (gravação via `write_file`); ao sucesso, limpar `dirty`
      e fechar; ao erro, manter a aba aberta e suja (e reportar o erro).
- [ ] **Não salvar**: remover de `openFiles` sem gravar.
- [ ] **Cancelar / Esc**: abortar — não fechar a aba.
- [ ] Garantir que arquivos **sem** alterações (`dirty=false`) fechem direto, sem diálogo.
- [ ] Cobrir os três gatilhos: X da aba, Ctrl+W e item "Fechar" do menu de contexto da aba em
      [TabBar.tsx](../../src/components/TabBar.tsx).
- [ ] Ajustar a assinatura de `onClose` em [TabBar.tsx](../../src/components/TabBar.tsx) para `(path) => Promise<void>`
      se necessário (ou apenas `void` o retorno, sem quebrar a UI).

## Arquivos

- `src/App.tsx` (guarda no `onClose`, integração com `ConfirmDialog`, modificado)
- `src/components/TabBar.tsx` (assinatura de `onClose` / disparos do X, Ctrl+W e menu, modificado)
- `src/components/ConfirmDialog.tsx` (consumido; criado na ISSUE-66)

## Detalhes técnicos

- O `onClose` vira `async`: aguarda a escolha do `ConfirmDialog` (Promise) e só então decide. Quem chama
  no [TabBar.tsx](../../src/components/TabBar.tsx) não precisa aguardar — pode disparar e esquecer.
- Reusar **exatamente** o fluxo de save já implementado em [App.tsx](../../src/App.tsx) (não duplicar a
  gravação). Em caso de erro de `write_file`, não remover a aba de `openFiles` e preservar `dirty=true`.
- O nome exibido na mensagem é o basename do `path` (último segmento), não o caminho completo.
- O Ctrl+W deve passar pela mesma guarda — não fechar atalho por um caminho que ignore o `dirty`.
- Enquanto o diálogo está aberto, evitar abrir um segundo diálogo para a mesma aba (debounce simples por path).
- Erros de gravação: hoje o app usa `window.alert`; manter esse comportamento aqui (a melhoria de
  toasts/inline não faz parte desta issue).

## Critérios de aceite

- [ ] Fechar uma aba suja pelo X abre o diálogo "Deseja salvar as alterações em `<nome>`?".
- [ ] **Salvar** grava e só fecha após sucesso; em erro de gravação a aba permanece aberta e suja.
- [ ] **Não salvar** descarta e fecha.
- [ ] **Cancelar** e **Esc** mantêm a aba aberta sem alterações.
- [ ] Aba sem alterações fecha direto, sem diálogo.
- [ ] Ctrl+W e o item "Fechar" do menu de aba passam pela mesma guarda.
- [ ] `tsc --noEmit` sem erros.
