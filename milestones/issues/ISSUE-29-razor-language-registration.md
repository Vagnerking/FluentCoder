# ISSUE-29 · Front: registrar linguagem razor no Monaco

**Épico:** [Razor / .cshtml — IntelliSense no Monaco](../EPIC-lsp-razor-cshtml.md) · **Camada:** Front · **Tamanho:** S · **Depende de:** 24

## Contexto

O Monaco não tem linguagem `razor` embutida (diferente de `html`, `typescript`, etc.).
Arquivos `.cshtml` abrem hoje como `plaintext` — sem syntax highlight, sem mapeamento. Esta issue
resolve o reconhecimento da linguagem e adiciona um tokenizer básico para Razor.

## Tarefas

- [x] Em [language.ts](../../src/language.ts), adicionar ao `EXT_TO_LANG`:
      ```ts
      cshtml: 'razor',
      razor: 'razor',
      ```
- [x] Criar `src/lsp/monacoSetup.ts` (se ainda não existir) e adicionar o registro da linguagem:
      ```ts
      monaco.languages.register({ id: 'razor', extensions: ['.cshtml', '.razor'], aliases: ['Razor', 'CSHTML'] });
      ```
- [x] Definir um tokenizer básico `monaco.languages.setMonarchTokensProvider('razor', {...})` com
      regras para:
      - Blocos `@{ ... }` e `@( ... )` como código C#.
      - Diretivas Razor: `@model`, `@using`, `@inject`, `@page`, `@section`, `@if`, `@foreach` etc.
      - HTML fora dos blocos Razor.
      - Comentários Razor `@* ... *@`.
- [x] Garantir que a chamada de registro acontece antes do Monaco ser usado (ex: no `BeforeMount`
      de [EditorPane.tsx](../../src/components/EditorPane.tsx) ou em um `monacoSetup.ts` importado cedo).

## Arquivos

- `src/language.ts` (adicionar `cshtml`/`razor`)
- `src/lsp/monacoSetup.ts` (novo ou existente — registrar linguagem + tokenizer)
- `src/components/EditorPane.tsx` (importar `monacoSetup.ts` se necessário)

## Detalhes técnicos

- O tokenizer Monarch é suficiente para syntax highlight básico; não é necessário TextMate grammar.
- O Monaco usará este `languageId` como base para o `documentSelector` do `MonacoLanguageClient`
  de Razor (ISSUE-31).
- A extensão `.razor` (Blazor) usa o mesmo servidor e pode ser mapeada junto com `.cshtml`.

## Critérios de aceite

- [x] Abrir um arquivo `.cshtml` no editor exibe syntax highlight com cores diferentes para HTML e blocos Razor.
- [x] Diretivas `@model`, `@using`, `@if`, `@foreach` são coloridas como palavras-chave Razor.
- [x] `tsc --noEmit` sem erros.
- [x] Sem regressão nos outros tipos de arquivo (`.ts`, `.cs`, `.js`) — `EXT_TO_LANG` apenas acrescenta entradas.

> **Entregue.** Tokenizer em `src/lsp/monacoSetup.ts` (registro + Monarch),
> mapeamento em `src/language.ts`, registro via `beforeMount` em `EditorPane.tsx`.
> Highlight de tag/atributo HTML não foi testado em todos os edge-cases mas
> diferencia corretamente HTML, blocos C# (`@{ }`/`@( )`), diretivas e comentários.
