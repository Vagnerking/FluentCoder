# ISSUE-55 · Integração, atalhos e E2E

**Épico:** [Barra de Menu estilo VSCode](../EPIC-menu-bar-vscode.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 47, 48, 49, 50, 51, 52, 53, 54

## Contexto

Fechamento do épico da barra de menu: garantir **paridade entre os aceleradores exibidos** nos
menus e os **atalhos reais** do `keydown` global, polir o visual Fluent e fazer o **primeiro
setup de E2E** cobrindo o fluxo principal da menu bar. Segue a regra do projeto: E2E com
**tauri-driver + WebdriverIO** (não Playwright/MCP), exigindo `tauri build` antes de rodar.

## Tarefas

- [ ] Centralizar/expandir o `keydown` global de [App.tsx](../../src/App.tsx) para casar com os
      aceleradores mostrados nos menus (New File, Save As, Toggle Sidebar, Command Palette,
      Open Folder, etc.), **evitando conflito** com os chords do Monaco quando o editor está focado.
- [ ] Polimento visual Fluent da barra e dos dropdowns (espaçamento, hover, foco, acrílico).
- [ ] Setup **tauri-driver + WebdriverIO** (se ainda não existir no projeto).
- [ ] **Testes E2E** do menu, cobrindo:
      - abrir cada menu (File, Edit, Selection, View, Go, Run, Terminal, Help);
      - navegação por teclado / **Alt**;
      - fechar ao clicar fora;
      - **Open Folder** via menu File abre o picker;
      - **Save** persiste o arquivo;
      - itens **desabilitados** sem editor ativo;
      - **ausência** do botão "Abrir pasta";
      - smoke de **Edit (Undo)** e **Selection (Select All)**.
- [ ] `tsc --noEmit` e `cargo check` limpos.
- [ ] Atualizar o status no [README de milestones](../README.md) e marcar os checkboxes do épico.

## Arquivos

- `src/App.tsx` (centralização/expansão dos atalhos do `keydown` global)
- `e2e/menubar.e2e.ts` (novo teste E2E da menu bar)
- Config do tauri-driver (se necessário introduzir)
- `milestones/README.md` (status)

## Detalhes técnicos

- Regra do projeto: E2E com **tauri-driver + WebdriverIO** (**NÃO** Playwright/MCP) e exige
  **`tauri build`** (não `cargo build`) antes de rodar — senão o WebView abre em localhost
  recusado. Rodar ao terminar a feature.
- Os atalhos globais devem **bater exatamente** com os aceleradores exibidos nos menus (ISSUE-48
  renderiza os aceleradores; aqui garantimos que eles realmente disparam).
- Cuidar para que os atalhos **não conflitem** com os chords do Monaco quando o editor está
  focado (testar com o cursor dentro do editor).

## Critérios de aceite

- [ ] Aceleradores exibidos nos menus disparam de fato as ações correspondentes.
- [ ] E2E cobrindo o fluxo principal (abrir menus, Alt, clicar fora, Open Folder, Save, itens disabled, smoke Edit/Selection) passa.
- [ ] O botão "Abrir pasta" não existe mais.
- [ ] `tsc --noEmit` e `cargo check` sem erros; E2E executado com tauri-driver (após `tauri build`).
- [ ] Milestones README atualizado.
