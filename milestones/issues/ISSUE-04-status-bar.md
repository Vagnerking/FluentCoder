# ISSUE-04 · Status bar inferior

**Épico:** [Fluent VSCode Layout](../EPIC-fluent-vscode-layout.md) · **Camada:** Front · **Tamanho:** S · **Depende de:** 01

## Contexto

A barra fina na base do VSCode com informações de contexto. No print aparece: branch
(`main`), erros/avisos, `Ln X, Col Y`, `Tab Size`, encoding.

## Tarefas

- [ ] Criar `src/components/StatusBar.tsx` (altura ~22px).
- [ ] Seções:
  - **Esquerda:** branch (placeholder `main` por ora — git real fora de escopo),
    erros/avisos (placeholder `0 ✕ 0 ⚠`).
  - **Direita:** posição do cursor (`Ln, Col`), linguagem do arquivo ativo, `Tab Size: 2`,
    encoding (`UTF-8`).
- [ ] Posição do cursor: ouvir o evento do Monaco (`onDidChangeCursorPosition`) e refletir.
- [ ] Linguagem: reaproveitar `languageForFile` ([language.ts](../../src/language.ts)).

## Arquivos

- `src/components/StatusBar.tsx` (novo)
- `src/components/EditorPane.tsx` (expor mudança de cursor via callback `onCursorChange`)
- `src/App.tsx` (estado `cursor: {line, column}` + passar para StatusBar)
- `src/styles.css` (`.status-bar`, `.status-item`)

## Detalhes técnicos

- `EditorPane` ganha `onMount` do `@monaco-editor/react` para registrar
  `editor.onDidChangeCursorPosition(e => onCursorChange(e.position))`.
- A barra usa a cor de acento Win11 como fundo? **Não** — VSCode moderno usa fundo neutro;
  manter translúcido sobre Mica para coerência (decisão de UI: neutro, não azul).

## Critérios de aceite

- [ ] Status bar visível na base, full-width.
- [ ] `Ln, Col` atualiza ao mover o cursor.
- [ ] Linguagem e tab size refletem o arquivo ativo.
