# ISSUE-23 · Front: transport LSP + factory monaco-languageclient (genérico)

**Épico:** [IntelliSense C# via LSP (Roslyn)](../EPIC-lsp-intellisense-csharp.md) · **Camada:** Front · **Tamanho:** L · **Depende de:** 19, 21, 22

## Contexto

Com o bridge WS no backend (ISSUE-21) e os comandos Tauri (ISSUE-22) prontos, esta issue
implementa o **wiring genérico do frontend**: o módulo de transport que conecta ao WS do bridge, e
a factory `createLanguageClient` que configura um `MonacoLanguageClient` para qualquer servidor LSP.

Este é o coração reutilizável da arquitetura LSP no front: os épicos de Razor e TypeScript/JavaScript
**não reimplementam** nada aqui — só chamam `createLanguageClient` com configurações diferentes.

## Tarefas

- [x] Criar `src/lsp/transport.ts`:
      - `export async function createTransport(port: number, token: string): Promise<{ reader, writer }>`.
      - Conectar via `WebSocket` em `ws://127.0.0.1:{port}/?token={token}`.
      - Usar `toSocket(ws)` de `vscode-ws-jsonrpc` para obter `WebSocketMessageReader` e
        `WebSocketMessageWriter`.
      - Aguardar evento `open` antes de retornar; rejeitar na falha de conexão.
- [x] Criar `src/lsp/client.ts`:
      - Interface `LspClientConfig { serverId: string, documentSelector: DocumentSelector, initializationOptions?: any, rootUri: string }`.
      - `export async function createLanguageClient(config: LspClientConfig): Promise<MonacoLanguageClient>`:
        - Chama `lspBridgeInfo(config.serverId)` de `api.ts` para obter `{ port, token }`.
        - Chama `createTransport(port, token)`.
        - Instancia `MonacoLanguageClient` com o transport, documentSelector, rootUri e
          initializationOptions fornecidos.
        - Chama `client.start()` e retorna o client.
- [x] Criar `src/lsp/index.ts` re-exportando `createLanguageClient` e `createTransport`.
- [x] Adicionar dependências confirmadas na ISSUE-19 ao `package.json`.

## Arquivos

- `src/lsp/transport.ts` (novo)
- `src/lsp/client.ts` (novo)
- `src/lsp/index.ts` (novo)
- `package.json` (dependências LSP)

## Detalhes técnicos

- O `rootUri` deve ser formatado como URI de arquivo: `file:///C:/...` no Windows.
  Usar `URI.file(rootPath).toString()` de `vscode-uri` (vem como transitiva do `vscode-languageclient`).
- `documentSelector` é um array de `{ scheme: 'file', language: 'csharp' }` etc.
- O `MonacoLanguageClient` do `monaco-languageclient` precisa do monaco como peer — confirmar
  com a versão pinada na ISSUE-19.
- O transport fica em módulo separado (`transport.ts`) para facilitar troca futura por invoke/event
  sem mexer em `client.ts` ou nos servers específicos.
- Tratar reconexão: se o WS cair, `MonacoLanguageClient` tem `revealOutputChannelOn` e
  `errorHandler` configuráveis — usar `closeHandler` para propagar falha ao manager (ISSUE-25).

## Critérios de aceite

- [x] `createLanguageClient` retorna um client LSP ativo sem erros de console.
- [x] Transport conecta ao bridge WS com o token correto.
- [x] `tsc --noEmit` sem erros nos novos módulos.
- [x] O módulo é importável pelos épicos de Razor e TypeScript sem modificação.
- [x] Nenhum impacto visível na UI enquanto não há servidor LSP ativo.
