# ISSUE-35 · Full: configuração do client TS/JS (tsconfig, aliases, @types, node_modules)

**Épico:** [TypeScript e JavaScript — IntelliSense via LSP real](../EPIC-lsp-typescript-javascript.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 23, 25, 33, 34

## Contexto

Com o servidor localizado (ISSUE-34) e o worker embutido desabilitado (ISSUE-33), esta issue
configura o `MonacoLanguageClient` para TypeScript/JavaScript e valida que o servidor respeita
o `tsconfig.json`/`jsconfig.json` do projeto, resolve aliases de path, `node_modules` e `@types`.

## Tarefas

- [x] Criar `src/lsp/servers/typescript.ts`:
      - `export const TS_SERVER_ID = 'typescript'`.
      - `export async function startTypescriptServer(rootPath: string): Promise<void>`:
        - Chama `ensureTsServer(rootPath)` de `api.ts`.
        - Chama `startLspServer({ id: TS_SERVER_ID, program, args, cwd: rootPath })`.
        - Chama `createLanguageClient` com:
          - `documentSelector`: `[{ scheme: 'file', language: 'typescript' }, { scheme: 'file', language: 'javascript' }, { scheme: 'file', language: 'typescriptreact' }, { scheme: 'file', language: 'javascriptreact' }]`.
          - `rootUri`: URI do workspace.
          - `initializationOptions`: preferências do tsserver (ex: `{ preferences: { includeInlayParameterNameHints: 'none', importModuleSpecifierPreference: 'relative' } }`).
- [x] Registrar `typescript → startTypescriptServer` no manager (ISSUE-25).
- [x] Validar no projeto deste repositório (React+Vite+TypeScript):
      - Completions com tipos das dependências do projeto.
      - Hover em funções de `react`, `@tauri-apps/api` etc.
      - Erros de tipo aparecem no editor.
      - Imports automáticos funcionam (ex: digitar `useState` → sugerir import).
      - Organize imports via Code Action.
      - Go-to-definition em tipos do projeto.
      - Find references cross-file.

## Arquivos

- `src/lsp/servers/typescript.ts` (novo)
- `src/lsp/manager.ts` (registrar server TypeScript)
- `src/lsp/useLspManager.ts` (adicionar linguagens typescript/javascript)

## Detalhes técnicos

- O `typescript-language-server` lê o `tsconfig.json` do workspace via `rootUri` — **não** é
  necessário passar o caminho explicitamente, só garantir que `rootUri` aponta para o diretório
  correto do projeto.
- Aliases de path configurados em `tsconfig.json` (`paths`) são resolvidos automaticamente pelo
  tsserver quando o `rootUri` está correto.
- `@types` em `node_modules/@types` são reconhecidos automaticamente.
- O `documentSelector` inclui `typescriptreact` e `javascriptreact` — mesmo que ISSUE-36 ainda
  não tenha registrado esses ids no Monaco, o selector já os cobre para quando forem registrados.
- Verificar que o workspace deste repositório tem `typescript-language-server` instalado ou
  documentar como instalar para testar.

## Critérios de aceite

- [x] Abrir um arquivo `.ts` no workspace deste repositório inicia o servidor TS automaticamente.
- [x] Completions com tipos de `react`, `@tauri-apps/api` e outros pacotes funcionam.
- [x] Erros de tipo aparecem no editor com underline e no ProblemsPanel.
- [x] Imports automáticos sugerem o pacote correto.
- [x] `tsconfig.json` do projeto é respeitado (verificar path aliases se configurados).
- [x] `tsc --noEmit` e `cargo check` sem erros no projeto.
