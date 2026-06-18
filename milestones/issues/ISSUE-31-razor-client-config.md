# ISSUE-31 · Full: configuração do client Razor (best-effort)

**Épico:** [Razor / .cshtml — IntelliSense no Monaco](../EPIC-lsp-razor-cshtml.md) · **Camada:** Full · **Tamanho:** L · **Depende de:** 23, 25, 30, 27, 32

## Contexto

Com o spike (ISSUE-32) definindo o escopo realista do `rzls`, esta issue implementa o client Razor
completo — ativando os recursos que efetivamente funcionam via LSP padrão e documentando
explicitamente o que ficou fora de escopo (projeção de documentos embutidos).

O escopo exato desta issue **depende do resultado da ISSUE-32**: se poucos recursos funcionarem,
a implementação é simplificada; se completions e diagnósticos funcionarem bem, implementar tudo.

## Tarefas

- [x] Criar `src/lsp/servers/razor.ts`:
      - `export const RAZOR_SERVER_ID = 'razor'`.
      - `startRazorServer(monaco, rootPath, ctx)`:
        - Chama `ensureRazorServer()` de `api.ts`.
        - Chama `startLspServer({ id: RAZOR_SERVER_ID, program, args, cwd: rootPath })`.
        - Chama `createLanguageClient` com `languages: ['razor']`, `rootUri` e
          `initializationOptions` (conservadoras conforme o spike).
- [x] Registrar `razor → startRazorServer` no manager (ISSUE-25).
- [~] Implementar os recursos que o spike confirmou funcionarem:
      - Diagnósticos → pipeline pronto (`publishDiagnostics` → markers + `Problem[]`); entrega valor
        se o rzls publicar via LSP puro. ✅ código pronto.
      - Completions / Hover / Go-to-definition → **fora de escopo** (spike: requerem projeção).
      - Formatação → **desabilitada** (risco de corromper Razor; spike).
- [x] Documentar implementado vs. fora de escopo (projeção) — em `RAZOR-SPIKE.md`.
- [x] Adicionar `razor` ao lifecycle do `useLspManager` (start lazy ao abrir `.cshtml`).

## Arquivos

- `src/lsp/servers/razor.ts` (novo)
- `src/lsp/manager.ts` (registrar server Razor)
- `src/lsp/useLspManager.ts` (adicionar linguagem 'razor')

## Detalhes técnicos

- **Fora de escopo:** projeção de documentos embutidos (synthetic C#/HTML buffers, request forwarding).
  Isso requer uma camada acima do LSP padrão e é uma milestone futura se o spike mostrar que é necessário.
- O `documentSelector` usa `language: 'razor'` — o id registrado na ISSUE-29.
- Se o rzls exigir que o C# LSP esteja ativo como "host", garantir que o manager inicie o Roslyn
  antes do rzls (dependência de ordem no lifecycle).
- O status do servidor Razor deve aparecer na StatusBar (ISSUE-28 já define o padrão).

## Critérios de aceite

- [~] Abrir um arquivo `.cshtml` inicia o rzls automaticamente — o manager **tenta** iniciar;
      sem o binário (download stub) marca `unavailable` sem quebrar o editor. Não testado com rzls real.
- [~] Diagnósticos de Razor/C# aparecem no arquivo — pipeline pronto; depende do rzls publicar via LSP puro.
- [x] IntelliSense limitado ao confirmado pelo spike — apenas highlight + (potencialmente) diagnósticos;
      completion/hover/def fora de escopo (projeção).
- [x] Formatação de `.cshtml` não corrompe Razor — **desabilitada** (não habilitada por segurança).
- [x] Implementado vs. excluído documentado (`RAZOR-SPIKE.md`).
- [x] `tsc --noEmit` e `cargo check` sem erros.
- [ ] Teste E2E (tauri-driver) — **não executado** (restrição: não rodar tauri build/E2E neste worktree).

> **Best-effort, rebaixado conforme spike (honesto).** Wiring completo e compilando: rzls é iniciado
> via bridge, client conectado, diagnósticos roteados. IntelliSense semântico (completion/hover/def/
> format) é milestone futura (projeção de documentos). Não testado contra um rzls real.
