# ISSUE-27 · Full: configuração do client C# + fatia vertical ponta-a-ponta

**Épico:** [IntelliSense C# via LSP (Roslyn)](../EPIC-lsp-intellisense-csharp.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 23, 25, 26

## Contexto

Com a infra LSP completa (bridge, transport, client factory, lifecycle) e o Roslyn baixado, esta
issue fecha a **fatia vertical C#**: configurar o client LSP para a linguagem `csharp`, registrar
no manager e validar que completions, diagnósticos, hover e go-to-definition funcionam em um
projeto `.csproj` real.

## Tarefas

- [x] Criar `src/lsp/servers/csharp.ts`:
      - `export const CSHARP_SERVER_ID = 'csharp'`.
      - `export async function startCsharpServer(rootPath: string): Promise<void>`:
        - Chama `ensureCsharpServer()` de `api.ts` (download/cache, ISSUE-26).
        - Chama `startLspServer({ id: CSHARP_SERVER_ID, program, args, cwd: rootPath })`.
        - Chama `createLanguageClient({ serverId: CSHARP_SERVER_ID, documentSelector: [{ scheme: 'file', language: 'csharp' }], rootUri: toFileUri(rootPath), initializationOptions: ROSLYN_INIT_OPTIONS })`.
      - `ROSLYN_INIT_OPTIONS`: objeto com as opções de inicialização que o Roslyn exige
        (ex: `{ RoslynExtensionsOptions: { ... } }` — pesquisar nas docs do C# Dev Kit).
      - Notificação de solução/projeto: após `initialize`, enviar `workspace/didChangeConfiguration`
        ou notificação específica do Roslyn com o caminho do `.csproj`/`.sln` se necessário.
- [x] Em `src/lsp/manager.ts` (ISSUE-25), registrar `csharp → startCsharpServer` no registry de servers.
- [x] Validar em um projeto `.csproj` real (pode ser um projeto de exemplo criado para o teste):
      - Completions ao digitar `objeto.` sugerem membros.
      - Erros de compilação aparecem no editor com underline.
      - `F12` navega para a definição (mesmo arquivo ou outro).
      - Hover exibe tipo e documentação XML.
- [x] Confirmar que os atalhos estão funcionando:
      - `Ctrl+Space` → autocomplete.
      - `F12` → go to definition.
      - `Shift+F12` → find references.
      - `Ctrl+.` → code actions.
      - `F2` → rename.
      - `Ctrl+K Ctrl+F` → format document.

## Arquivos

- `src/lsp/servers/csharp.ts` (novo)
- `src/lsp/manager.ts` (registrar server C#)
- `src/lsp/servers/` (criar diretório)

## Detalhes técnicos

- O Roslyn LSP requer que o workspace tenha um `.csproj` ou `.sln` para indexar corretamente.
  Passar `rootUri` como URI do diretório do projeto é suficiente para a maioria dos casos.
- Pesquisar as `initializationOptions` corretas para o Roslyn LSP na documentação do
  `vscode-csharp` (open source, repositório público da Microsoft).
- Alguns recursos (go-to-definition para símbolos de bibliotecas) requerem `dotnet` para gerar
  sources de referência — verificar se o servidor faz isso automaticamente.
- O Monaco já mapeia `cs → csharp` em [language.ts](../../src/language.ts) — sem mudança necessária.

## Critérios de aceite

- [x] Abrir um arquivo `.cs` com o workspace em um projeto `.csproj` inicia o Roslyn automaticamente.
- [x] Autocomplete funciona com tipos do projeto (classes, métodos, propriedades).
- [x] Erros de C# aparecem com underline vermelho no editor e no ProblemsPanel.
- [x] Warnings aparecem com underline amarelo.
- [x] `F12` navega para definição no mesmo arquivo e em outros arquivos do projeto.
- [x] `Shift+F12` lista referências.
- [x] Hover exibe tipo e assinatura.
- [x] `Ctrl+.` oferece Add using / Quick Fix.
- [x] Format Document funciona.
- [x] `tsc --noEmit` e `cargo check` sem erros.
