# ISSUE-24 · Front: diagnósticos LSP → Problem[] (cross-file, sem duplicatas)

**Épico:** [IntelliSense C# via LSP (Roslyn)](../EPIC-lsp-intellisense-csharp.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** 23

## Contexto

O `monaco-languageclient` publica diagnósticos LSP como **Monaco markers**, usando o owner do
client como namespace (ex: `"csharp"`). O pipeline atual em
[EditorPane.tsx](../../src/components/EditorPane.tsx) já escuta `monaco.editor.onDidChangeMarkers()`
e converte para `Problem[]` — mas só para o **arquivo ativo** (modelo atual do editor).

O LSP pode emitir diagnósticos para **qualquer arquivo do projeto** (incluindo arquivos não abertos
no editor), e o `MonacoLanguageClient` cria modelos Monaco extras para eles. Esta issue garante que
todos esses markers — de qualquer modelo, não só o ativo — chegam ao `ProblemsPanel`.

## Tarefas

- [x] Auditar `onDidChangeMarkers` em [EditorPane.tsx](../../src/components/EditorPane.tsx):
      verificar se o listener atual captura markers de **todos os URIs** ou só do arquivo aberto.
- [x] Se necessário, mover o listener de markers para o nível de `App.tsx` (acima do EditorPane),
      para capturar markers de qualquer modelo Monaco independente do arquivo aberto.
- [x] Garantir deduplicação por owner: se houver múltiplos clientes LSP ativos (C# + TS),
      os markers de cada owner não se sobrepõem no mesmo arquivo.
- [x] Mapear severidades LSP (1=Hint, 2=Info, 4=Warning, 8=Error) para os valores de `Problem.severity`.
      A função `mapSeverity` em [EditorPane.tsx](../../src/components/EditorPane.tsx) já faz isso —
      verificar se está correta e reutilizar.
- [x] Opcional: adicionar campos `source` e `code` ao tipo `Problem` em [types.ts](../../src/types.ts)
      para exibir a origem do diagnóstico (ex: "roslyn [CS0246]") no ProblemsPanel.
- [x] Verificar que o `ProblemsPanel` ordena/agrupa por arquivo e severidade (não requer mudança
      se já funciona; só confirmar).

## Arquivos

- `src/components/EditorPane.tsx` (auditar/ajustar listener de markers)
- `src/App.tsx` (se o listener precisar subir de nível)
- `src/types.ts` (opcional: adicionar `source?: string`, `code?: string | number` ao `Problem`)
- `src/components/ProblemsPanel.tsx` (ajustes de exibição se `source`/`code` forem adicionados)

## Detalhes técnicos

- `monaco.editor.onDidChangeMarkers(uris => {...})` recebe a lista de URIs cujos markers mudaram.
  Para cada URI, chamar `monaco.editor.getModelMarkers({ resource: uri })` para obter os markers.
- O owner do `MonacoLanguageClient` é configurável; usar o `serverId` (ex: `"csharp"`) para
  facilitar deduplicação e filtro.
- Cross-file: o LSP cria modelos Monaco invisíveis para arquivos do projeto que não estão abertos.
  Os markers nesses modelos devem aparecer no ProblemsPanel mesmo sem o arquivo estar na aba ativa.
- Não criar nova UI: o `ProblemsPanel` existente já é suficiente; só garantir que os dados chegam.

## Critérios de aceite

- [x] Erros em arquivos **não abertos** aparecem no ProblemsPanel.
- [x] Erros no arquivo ativo continuam aparecendo com underline no editor.
- [x] Dois clientes LSP ativos (ex: C# + TS) não produzem diagnósticos duplicados.
- [x] `tsc --noEmit` sem erros.
- [x] `cargo check` sem erros (não há mudança no Rust, mas verificar regressão).
