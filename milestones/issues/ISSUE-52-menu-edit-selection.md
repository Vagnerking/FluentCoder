# ISSUE-52 · Menus Edit + Selection

**Épico:** [Barra de Menu estilo VSCode](../EPIC-menu-bar-vscode.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** 47, 49, 50

## Contexto

Os menus **Edit** e **Selection** operam sobre o editor **Monaco ativo**, disparando ações pela
ponte de comandos exposta na **ISSUE-50** (`editorActionsRef`: run/trigger/focus do Monaco). Cada
item do menu mapeia para um **id de ação do Monaco**. Quando não há editor ativo
(`activeFile == null`), todos os itens destes dois menus ficam **desabilitados**.

## Tarefas

- [ ] **Edit** — fiar via `editorActionsRef` (ISSUE-50) aos ids do Monaco:
      - Undo → `undo`
      - Redo → `redo`
      - Cut → `editor.action.clipboardCutAction`
      - Copy → `editor.action.clipboardCopyAction`
      - Paste → `editor.action.clipboardPasteAction`
      - Find → `actions.find`
      - Replace → `editor.action.startFindReplaceAction`
- [ ] **Edit — Find in Files**: não é ação do Monaco; fazer `setActiveView("search")`.
- [ ] **Selection** — fiar via `editorActionsRef` aos ids do Monaco:
      - Select All → `editor.action.selectAll`
      - Expand Selection → `editor.action.smartSelect.expand`
      - Shrink Selection → `editor.action.smartSelect.shrink`
      - Copy Line Up → `editor.action.copyLinesUpAction`
      - Copy Line Down → `editor.action.copyLinesDownAction`
      - Move Line Up → `editor.action.moveLinesUpAction`
      - Move Line Down → `editor.action.moveLinesDownAction`
      - Add Cursor Above → `editor.action.insertCursorAbove`
      - Add Cursor Below → `editor.action.insertCursorBelow`
- [ ] Desabilitar **todos** os itens de Edit e Selection quando `activeFile == null`
      (`enabled` reativo ao estado).
- [ ] Adicionar as definições dos menus Edit e Selection ao modelo consumido pelo [MenuBar.tsx](../../src/components/MenuBar.tsx).

## Arquivos

- `src/App.tsx` (definição dos menus Edit/Selection usando `editorActionsRef`; `enabled` derivado de `activeFile`)
- `src/components/MenuBar.tsx` (apenas se precisar de ajuste pontual)

## Detalhes técnicos

- Depende de **`editorActionsRef`** (ISSUE-50) para disparar comandos no editor focado; sem ela
  os itens não têm como executar e devem ficar desabilitados.
- Mapear **cada item ao id de ação do Monaco** (lista acima); a ponte chama `trigger`/`run` da ref.
- O estado `enabled` de cada item deve ser **reativo a `activeFile`**: sem editor, tudo cinza.
- Find in Files é o único item de Edit que **não** é ação do Monaco — usa `setActiveView("search")`.

## Critérios de aceite

- [ ] Cada item de Edit (Undo/Redo/Cut/Copy/Paste/Find/Replace) executa a ação no editor ativo.
- [ ] Cada item de Selection executa a ação correspondente no editor ativo.
- [ ] Find in Files abre a view de busca (`setActiveView("search")`).
- [ ] Sem editor ativo (`activeFile == null`), todos os itens de Edit/Selection ficam desabilitados.
- [ ] `tsc --noEmit` sem erros.
