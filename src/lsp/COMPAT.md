# ISSUE-19 — Spike: compatibilidade `monaco-languageclient`

## Conclusão

Versão pinada: **`monaco-languageclient@^1.1.0`** (a última da linha 1.x).

### Por quê

O projeto usa a distribuição **padrão** do Monaco:
`@monaco-editor/react@^4.6` + `monaco-editor@^0.52`.

A partir da **v2** do `monaco-languageclient`, a dependência passou a ser
`vscode: npm:@codingame/monaco-vscode-api`, que **substitui** o `monaco-editor`
padrão por uma distribuição com shims dos serviços do VSCode. Isso conflita com
`@monaco-editor/react@4.6` (que carrega o `monaco-editor` "vanilla") e exigiria
migrar o carregamento do Monaco inteiro para a stack `@codingame`, reescrevendo
`EditorPane.tsx` e abrindo mão do `@monaco-editor/react`.

Verificação feita via `npm view` (junho/2026):

| Versão | Dependência de Monaco | Serve? |
| --- | --- | --- |
| `>= 2.0.0` | `npm:@codingame/monaco-vscode-api` | ❌ conflita com `@monaco-editor/react@4.6` |
| `1.x` (1.0.0–1.1.0) | nenhuma (usa `monaco-editor` peer "vanilla") | ✅ escolhida |
| `0.18.x` | `vscode-languageclient@7` / `vscode-jsonrpc@6` | protocolo mais antigo |

A **v1.x** depende de `vscode-languageclient@8` + `vscode-jsonrpc@8` e expõe
`MonacoServices.install(monaco)` + `MonacoLanguageClient`, funcionando com o
`monaco-editor` padrão sem `@codingame`. É a versão mais recente que satisfaz
o critério "sem quebrar o setup atual".

## Conjunto de dependências (pinado)

```json
"monaco-languageclient": "^1.1.0",
"vscode-languageclient": "^8.0.2",
"vscode-jsonrpc": "^8.0.2",
"vscode-ws-jsonrpc": "^3.0.0",
"vscode-languageserver-protocol": "^3.17.5"
```

- `vscode-ws-jsonrpc@3` fornece `toSocket`, `WebSocketMessageReader` e
  `WebSocketMessageWriter`, usados pelo transport WS (ISSUE-21/23).
- `vscode-languageserver-protocol` fornece os tipos LSP (`DocumentSelector`,
  `Diagnostic`, etc.) usados no front.

## Wiring (resumo)

1. `MonacoServices.install(monaco)` — uma vez, no bootstrap, antes de criar
   qualquer client (feito de forma idempotente em `client.ts`).
2. `toSocket(ws)` → `WebSocketMessageReader`/`WebSocketMessageWriter`.
3. `new MonacoLanguageClient({ name, clientOptions, connectionProvider })`
   com `connectionProvider.get()` retornando `{ reader, writer }`.
4. `client.start()`.

## NÃO TESTADO em runtime

> O `npm install` das dependências LSP **não foi executado** neste worktree para
> evitar travas/downloads longos (restrição da tarefa). O código foi escrito
> contra a API documentada da v1.x. O "hello LSP" vive em `spike.ts` e só roda
> após `npm install`. `tsc --noEmit` cobre o front existente; os módulos `lsp/`
> que importam os pacotes ainda-não-instalados são validados por inspeção até o
> install ser feito (ver nota no relatório do épico).
