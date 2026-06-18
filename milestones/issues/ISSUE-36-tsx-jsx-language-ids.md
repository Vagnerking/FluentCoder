# ISSUE-36 · Front: ids de linguagem TSX/JSX (typescriptreact / javascriptreact)

**Épico:** [TypeScript e JavaScript — IntelliSense via LSP real](../EPIC-lsp-typescript-javascript.md) · **Camada:** Front · **Tamanho:** S · **Depende de:** 35

## Contexto

O Monaco mapeia `.tsx → typescript` e `.jsx → javascript` em [language.ts](../../src/language.ts),
mas o `typescript-language-server` (tsserver) distingue `typescriptreact` de `typescript` e
`javascriptreact` de `javascript`. Sem o id correto, o IntelliSense JSX pode ser degradado
(ex: sem sugestões de atributos JSX, sem checagem de props de componentes React).

Esta issue alinha os ids de linguagem para que arquivos React recebam IntelliSense correto.

## Tarefas

- [x] Em [language.ts](../../src/language.ts), atualizar o mapeamento:
      ```ts
      tsx: 'typescriptreact',
      jsx: 'javascriptreact',
      ```
- [x] Em `src/lsp/monacoSetup.ts`, registrar as novas linguagens no Monaco (se necessário —
      verificar se `typescriptreact`/`javascriptreact` são ids reconhecidos nativamente pelo Monaco
      ou se precisam de `monaco.languages.register`).
- [x] Garantir que `setDiagnosticsOptions` da ISSUE-33 também cobre os novos ids (se Monaco
      os herda de `typescript`/`javascript` ou se precisa de chamada separada).
- [x] Verificar que o `documentSelector` da ISSUE-35 já cobre `typescriptreact`/`javascriptreact`
      (deve estar — foi antecipado lá).
- [x] Testar em um arquivo `.tsx` deste repositório (ex: [App.tsx](../../src/App.tsx)):
      - Completions de props de componentes React funcionam.
      - Erros de JSX aparecem corretamente.

## Arquivos

- `src/language.ts` (atualizar `tsx` e `jsx`)
- `src/lsp/monacoSetup.ts` (registrar ids se necessário)

## Detalhes técnicos

- O Monaco pode ter `typescriptreact` e `javascriptreact` como aliases internos — verificar na
  API do Monaco se `monaco.languages.getLanguages()` já os lista.
- Se o Monaco não os conhece, registrar com `monaco.languages.register({ id: 'typescriptreact', ... })`.
- A mudança em `language.ts` pode afetar outros providers (ex: um futuro formatter de HTML em tsx)
  — avaliar impacto e documentar.

## Critérios de aceite

- [x] Arquivos `.tsx` abrem com `languageId = 'typescriptreact'` no Monaco.
- [x] Arquivos `.jsx` abrem com `languageId = 'javascriptreact'`.
- [x] IntelliSense de JSX/TSX funciona no arquivo de teste (props, tipos de componentes).
- [x] `tsc --noEmit` sem erros.
- [x] Sem regressão em arquivos `.ts` e `.js`.
