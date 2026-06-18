# ISSUE-33 · Front: desabilitar worker TS/JS embutido do Monaco

**Épico:** [TypeScript e JavaScript — IntelliSense via LSP real](../EPIC-lsp-typescript-javascript.md) · **Camada:** Front · **Tamanho:** S · **Depende de:** 23

## Contexto

O Monaco tem um worker TypeScript embutido que fornece IntelliSense básico por padrão. Quando o
`typescript-language-server` também estiver ativo (via `monaco-languageclient`), os dois vão
competir: o usuário verá diagnósticos e completions duplicados, às vezes conflitantes.

Esta issue desabilita o worker embutido **antes** de ativar o servidor LSP real, garantindo que
o `typescript-language-server` seja a única fonte de IntelliSense para TS/JS.

## Tarefas

- [x] Em `src/lsp/monacoSetup.ts` (criado na ISSUE-29 ou agora), adicionar:
      ```ts
      // Desabilitar diagnósticos do worker embutido (o LSP real assume o papel)
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: true,
        noSuggestionDiagnostics: true,
      });
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: true,
        noSuggestionDiagnostics: true,
      });
      ```
- [x] Desabilitar também o completion provider embutido do Monaco para TS/JS se necessário
      (verificar se `monaco-languageclient` já tem precedência ou se é preciso deregistrar).
- [x] Garantir que o `monacoSetup.ts` é executado no `BeforeMount` de
      [EditorPane.tsx](../../src/components/EditorPane.tsx), antes de qualquer editor ser criado.
- [x] **Não** desabilitar o syntax highlighting — só os diagnósticos e completions do worker.

## Arquivos

- `src/lsp/monacoSetup.ts` (criar ou atualizar)
- `src/components/EditorPane.tsx` (garantir import/chamada do monacoSetup no BeforeMount)

## Detalhes técnicos

- `setDiagnosticsOptions` com as três flags `true` desabilita completamente o worker de
  validação semântica e sintática, mas mantém syntax coloring (Monarch) intacto.
- O worker embutido ainda pode fazer hover e completions básicas — verificar se é necessário
  desabilitar via `setCompletionItemProvider` ou se o `monaco-languageclient` tem prioridade
  natural pelo score dos providers.
- Esta mudança não afeta `.cs`, `.razor` nem outros tipos de arquivo.

## Critérios de aceite

- [x] Abrir um arquivo `.ts` com erro de tipo (ex: `const x: number = "abc"`) **não** mostra underline
      do worker embutido — só do LSP real (verificar com e sem servidor ativo).
- [x] Syntax highlighting de TS/JS continua funcionando normalmente.
- [x] Nenhum diagnóstico duplicado ao ativar o `typescript-language-server`.
- [x] `tsc --noEmit` sem erros.
- [x] Sem regressão em `.cs`, `.razor` nem outros tipos.
