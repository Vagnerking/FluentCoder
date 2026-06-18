# ISSUE-25 · Front: lifecycle do workspace LSP (manager)

**Épico:** [IntelliSense C# via LSP (Roslyn)](../EPIC-lsp-intellisense-csharp.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** 23

## Contexto

Com o `createLanguageClient` pronto (ISSUE-23), é preciso uma camada que **decide quando ligar e
desligar** cada servidor LSP: ao abrir a pasta, ao trocar de workspace, ao fechar o editor. Sem
esse manager, os clientes LSP seriam instanciados de forma ad-hoc por cada componente, levando a
múltiplas instâncias do mesmo servidor ou servidores zumbis.

O manager também é o ponto central para passar `rootUri` ao cliente — informação que vem de
`rootPath` em [App.tsx](../../src/App.tsx).

## Tarefas

- [x] Criar `src/lsp/manager.ts`:
      - `LspManager` com métodos `start(serverId, config)` e `stop(serverId)` e `stopAll()`.
      - Mantém um mapa interno `Map<string, MonacoLanguageClient>` de clients ativos.
      - `start`: chama `startLspServer` de `api.ts` → depois `createLanguageClient`.
        Se já houver um client para o `serverId`, ignora (idempotente).
      - `stop`: chama `client.stop()` → depois `stopLspServer` de `api.ts`.
      - `stopAll`: para todos os clients (usado ao fechar a pasta / encerrar o app).
- [x] Criar hook `src/lsp/useLspManager.ts`:
      - `useLspManager(rootPath: string | null, openedLanguages: Set<string>)`.
      - Reage ao `rootPath`: quando muda, para todos os clients anteriores e inicia os novos
        (para as linguagens já abertas).
      - Reage a `openedLanguages`: quando uma nova linguagem entra no set (ex: usuário abre um `.cs`
        pela primeira vez), inicia o servidor correspondente se ainda não estiver rodando.
      - Retorna `{ status: Map<string, 'starting' | 'ready' | 'error'> }` para a StatusBar.
- [x] Em [App.tsx](../../src/App.tsx): usar `useLspManager(rootPath, openedLanguages)`.
      - `openedLanguages` derivado das abas abertas (`openFiles` já existe no estado).
      - Passar `status` para a `StatusBar`.
- [x] Garantir que `stopAll` seja chamado no `beforeunload` do window (ou equivalente Tauri).

## Arquivos

- `src/lsp/manager.ts` (novo)
- `src/lsp/useLspManager.ts` (novo)
- `src/App.tsx` (usar hook + passar status para StatusBar)

## Detalhes técnicos

- A configuração de qual servidor iniciar para cada linguagem (`csharp → roslyn`, `typescript → tsserver`)
  fica em `src/lsp/servers/` (criado nas issues específicas: 27, 34, etc.). O manager recebe a
  linguagem e delega para o registry de servers.
- `openedLanguages` deve ser derivado do `languageForFile` de [language.ts](../../src/language.ts)
  aplicado sobre `openFiles` — não é uma nova fonte de verdade.
- Não iniciar LSP sem `rootPath` (workspace não aberto): se `rootPath` for null, o manager fica inativo.
- O manager não deve reiniciar o servidor a cada keystroke ou mudança de arquivo — só em mudanças
  de workspace ou abertura de nova linguagem.

## Critérios de aceite

- [x] Abrir uma pasta inicia o(s) servidor(es) LSP da(s) linguagem(ns) já abertas.
- [x] Fechar e reabrir outra pasta encerra os servers anteriores e inicia novos.
- [x] Abrir o primeiro arquivo `.cs` quando a pasta já está aberta inicia o Roslyn (se não estava ativo).
- [x] Nenhum servidor duplicado (dois clientes para o mesmo server id).
- [x] `stopAll` chamado ao fechar o editor encerra todos os processos LSP no backend.
- [x] `tsc --noEmit` sem erros.
