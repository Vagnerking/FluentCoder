# ISSUE-54 · Menu Help + remover botão "Abrir pasta"

**Épico:** [Barra de Menu estilo VSCode](../EPIC-menu-bar-vscode.md) · **Camada:** Full · **Tamanho:** S · **Depende de:** 51

## Contexto

Completar o menu **Help** (com diálogo "Sobre") e **remover de vez** o botão "Abrir pasta" do
[FileExplorer.tsx](../../src/components/FileExplorer.tsx), já que abrir pasta agora é feito pelo
menu **File** (ISSUE-51) e por um atalho global. Com isso o fluxo de abrir pasta passa a ser
único e consistente com o resto do app.

## Tarefas

- [ ] **Help — Keyboard Shortcuts**: abrir uma lista **estática** dos atalhos atuais
      (Ctrl+S salvar, Ctrl+` terminal, Ctrl+P Quick Open, e o novo atalho de Open Folder).
- [ ] **Help — About**: diálogo modal simples no padrão de overlay do
      [QuickOpen.tsx](../../src/components/QuickOpen.tsx) — nome do app, **versão** lida do
      `package.json`, e um link. Esc / clique fora fecham.
- [ ] **Help — Welcome / Documentation**: itens **desabilitados/opcionais**.
- [ ] **Remover** o botão "Abrir pasta" e a prop `onOpenFolder` de
      [FileExplorer.tsx](../../src/components/FileExplorer.tsx) e o respectivo prop drilling em
      [App.tsx](../../src/App.tsx) (`renderSidebar`).
- [ ] Ajustar o **empty-state** do [EditorPane.tsx](../../src/components/EditorPane.tsx) que
      menciona abrir pasta (apontar para o menu File / atalho).
- [ ] Adicionar um **atalho global de Open Folder** no `keydown` de [App.tsx](../../src/App.tsx),
      alinhado ao acelerador exibido no menu File (ISSUE-51).
- [ ] Adicionar a definição do menu Help (Shortcuts + About) ao modelo consumido pelo [MenuBar.tsx](../../src/components/MenuBar.tsx).

## Arquivos

- `src/components/MenuBar.tsx` / `src/App.tsx` (menu Help + abertura do diálogo About)
- `src/components/AboutDialog.tsx` (novo, opcional — diálogo About no padrão do QuickOpen)
- `src/components/FileExplorer.tsx` (remover botão "Abrir pasta" e prop `onOpenFolder`)
- `src/components/EditorPane.tsx` (ajustar empty-state)
- `src/App.tsx` (atalho global de Open Folder; remover o prop drilling de `onOpenFolder`)

## Detalhes técnicos

- O diálogo **About** segue o **mesmo padrão de overlay** do [QuickOpen.tsx](../../src/components/QuickOpen.tsx)
  (backdrop, superfície centrada, Esc/clique fora fecham) — não reinventar.
- A versão do app deve vir do `package.json` (import ou exposta via build), não hardcoded.
- Garantir que **nenhuma referência** ao botão removido ou à prop `onOpenFolder` reste em
  App.tsx, FileExplorer.tsx ou no empty-state do EditorPane.
- O acelerador do atalho global de Open Folder deve **bater** com o exibido no menu File (ISSUE-51).

## Critérios de aceite

- [ ] Menu Help abre Keyboard Shortcuts e About; About mostra nome/versão/link e fecha com Esc/clique fora.
- [ ] O botão "Abrir pasta" não existe mais em lugar nenhum (FileExplorer, prop drilling, empty-state).
- [ ] Abrir pasta funciona via menu File **e** pelo novo atalho global.
- [ ] `tsc --noEmit` sem erros.
