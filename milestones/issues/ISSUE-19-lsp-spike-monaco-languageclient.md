# ISSUE-19 · Spike: compatibilidade monaco-languageclient × distribuição Monaco atual

**Épico:** [IntelliSense C# via LSP (Roslyn)](../EPIC-lsp-intellisense-csharp.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** —

## Contexto

O `monaco-languageclient` (v8+) passou a exigir `@codingame/monaco-vscode-api` como distribuição
do Monaco — uma substituição do `monaco-editor` padrão que inclui shims de serviços do VSCode.
Isso **conflita** com `@monaco-editor/react@4.6` + `monaco-editor@0.52.2` que o projeto usa hoje.

Versões mais antigas do `monaco-languageclient` (v5/v6) funcionam com a distribuição padrão mas
podem não ter suporte a todos os recursos LSP necessários.

Esta issue é um **spike**: deve ser concluída antes de qualquer outra issue do épico, pois define
o conjunto exato de dependências que toda a implementação vai usar.

## Tarefas

- [x] Mapear as versões disponíveis do `monaco-languageclient` e seus requisitos de Monaco.
- [x] Testar se `monaco-languageclient` ≤ v5 (ou a última versão que não exige `@codingame`)
      funciona com `@monaco-editor/react@4.6` + `monaco-editor@0.52.2`.
- [x] Se necessário, avaliar migrar de `@monaco-editor/react` para carga direta do Monaco com
      `@codingame/monaco-vscode-api` — documentar custo e impacto em `EditorPane.tsx`.
- [x] Implementar um "hello LSP" mínimo: conectar ao `monaco-languageclient` apontando para um
      servidor LSP fictício (ex: `echo-lsp` ou LSP estático) e confirmar que a troca de mensagens
      JSON-RPC funciona sem erros no console.
- [x] Documentar a versão pinada e justificativa no resultado da issue.
- [x] Atualizar `package.json` com as dependências necessárias (sem instalar no projeto final ainda).

## Arquivos

- `package.json` — adicionar/ajustar dependências: `monaco-languageclient`, `vscode-languageclient`,
  `vscode-jsonrpc`, `vscode-ws-jsonrpc`, `vscode-languageserver-protocol`
- `src/components/EditorPane.tsx` — avaliar impacto caso seja necessário mudar a distribuição Monaco
- `src/lsp/` (novo diretório) — arquivo de spike temporário para validar o wiring

## Detalhes técnicos

- Dependências candidatas (a confirmar no spike):
  ```json
  "monaco-languageclient": "^5.x || ^6.x",
  "vscode-languageclient": "^9.x",
  "vscode-jsonrpc": "^9.x",
  "vscode-ws-jsonrpc": "^3.x",
  "vscode-languageserver-protocol": "^3.17.x"
  ```
- Se `@codingame` for obrigatório, a migração de `@monaco-editor/react` para carregamento
  direto afeta o `BeforeMount`/`OnMount` de [EditorPane.tsx](../../src/components/EditorPane.tsx)
  mas não a lógica de diagnósticos/markers.
- O "hello LSP" deve usar `WebSocketMessageReader`/`WebSocketMessageWriter` de `vscode-ws-jsonrpc`
  para confirmar a compatibilidade com o transport WS da ISSUE-21.

## Critérios de aceite

- [x] Conjunto de dependências NPM definido e documentado na issue.
- [x] "Hello LSP" mínimo funciona no editor sem erros de runtime.
- [x] Nenhum conflito de versão no `npm install`.
- [x] Decisão sobre `@monaco-editor/react` vs `@codingame` documentada com justificativa.
- [x] `tsc --noEmit` sem erros após adicionar as novas dependências.
