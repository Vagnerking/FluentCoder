# ISSUE-50 · Ponte de comandos do Monaco (ref imperativa do EditorPane)

**Épico:** [Barra de Menu estilo VSCode](../EPIC-menu-bar-vscode.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** —

## Contexto

Hoje o `editorRef` do Monaco é **privado** dentro de [EditorPane.tsx](../../src/components/EditorPane.tsx),
então o App não consegue disparar ações do editor como Undo/Redo/Cut/Copy/Paste/Select All. Esta issue
expõe uma **ref imperativa** do EditorPane para o App, análoga ao `revealRef` que já existe (a ponte
usada para revelar linhas), permitindo que o App acione comandos do Monaco.

Essa ponte é o que habilita, mais à frente, os menus **Edit** e **Selection** (ISSUE-52) e itens como
**Go to Line** — todos precisam falar com a instância do editor sem torná-la global. O padrão a seguir
é exatamente o de `revealRef` / `pendingRevealLine` já presente no [EditorPane.tsx](../../src/components/EditorPane.tsx):
uma ref que o App detém e o EditorPane popula no mount.

A ref não deve causar re-render — é uma `MutableRefObject` setada no `onMount` e limpa no unmount.

## Tarefas

- [ ] Criar uma ref imperativa (ex.: `editorActionsRef`) passada do App ao `EditorPane`, com os métodos:
      - `run(actionId: string)` → chama `editor.getAction(actionId)?.run()`.
      - `trigger(source, handlerId, payload?)` → chama `editor.trigger(...)`.
      - `focus()` → foca o editor.
- [ ] Popular a ref quando o editor monta (no `onMount` / `handleEditorDidMount`), seguindo o mesmo
      padrão de `revealRef` / `pendingRevealLine`.
- [ ] Limpar a ref no unmount do editor.
- [ ] Expor um helper para saber se há editor ativo (para itens de menu disabled quando não há arquivo aberto).
- [ ] Documentar que os menus Edit/Selection (ISSUE-52) dependem desta ponte.

## Arquivos

- `src/components/EditorPane.tsx` (popular a ref no mount, limpar no unmount, modificado)
- `src/App.tsx` (cria e detém `editorActionsRef`, modificado)
- `src/types.ts` (tipo da API imperativa do editor, possivelmente modificado)

## Detalhes técnicos

- Usar `MutableRefObject` setada no mount e **limpa** (`null`) no unmount; a ref não deve disparar re-render.
- IDs de ação do Monaco usados pelos menus: `undo`, `redo`, `editor.action.clipboardCutAction`,
  `editor.action.clipboardCopyAction`, `editor.action.clipboardPasteAction`, `editor.action.selectAll`,
  `actions.find` — `run(actionId)` cobre todos via `editor.getAction(actionId)?.run()`.
- Seguir o mesmo formato de ponte imperativa já usado por `revealRef` / `pendingRevealLine` no
  [EditorPane.tsx](../../src/components/EditorPane.tsx) — consistência de padrão.
- O helper de "há editor ativo" reflete `editorActionsRef.current != null` (ou flag equivalente), para
  que o App desabilite itens de Edit/Selection quando nenhum arquivo está aberto.

## Critérios de aceite

- [ ] O App consegue chamar `editorActionsRef.current.run("undo")` e o editor desfaz.
- [ ] `focus()` foca o editor.
- [ ] Quando não há arquivo aberto, a ref reflete isso (permitindo desabilitar itens de menu).
- [ ] A ref é limpa no unmount e não causa re-render.
- [ ] `tsc --noEmit` sem erros.
