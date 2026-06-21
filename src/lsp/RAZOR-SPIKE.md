# ISSUE-32 — Spike: capabilities reais do `rzls` via LSP puro

> **Documento histórico.** A decisão vigente desde 21/06/2026 é implementar uma
> engine `.cshtml` própria, sem Roslyn/`rzls` para Razor. Consulte
> [`docs/adr/0001-cshtml-language-service.md`](../../docs/adr/0001-cshtml-language-service.md)
> e
> [`docs/context/cshtml-language-service.md`](../../docs/context/cshtml-language-service.md).
> Os TODOs de aquisição/integração de `rzls` abaixo não devem ser executados.

> **Status do spike:** PARCIAL / ESTÁTICO. O servidor `rzls` **não** foi baixado
> nem executado neste worktree (restrição explícita da tarefa: não baixar
> Roslyn/rzls de verdade, não pendurar em downloads grandes). As conclusões
> abaixo são baseadas no protocolo LSP, no código aberto do `rzls`
> (`dotnet/razor`) e do `vscode-csharp`, e na arquitetura conhecida do Razor
> tooling. **Nenhum response real de `initialize` foi capturado.** O que está
> marcado como "confirmado" refere-se ao que a infra entrega; o comportamento do
> `rzls` em si está marcado como "esperado / não testado".

## Objetivo

Determinar, antes de fechar a ISSUE-31, quanto do IntelliSense Razor é viável
conectando o `rzls` pelo **bridge LSP padrão** (sem a camada de *projeção de
documentos*), e definir o escopo realista da ISSUE-31.

## Como o spike seria executado (procedimento, para quando o rzls existir)

1. Garantir o rzls em cache (depende da ISSUE-26 do épico C# — ainda não feita).
2. `ensureRazorServer()` → `startLspServer({ id: "razor", program, args, cwd })`.
3. `createLanguageClient(monaco, { serverId: "razor", languages: ["razor"], rootPath })`.
4. Logar `initializeResult.capabilities` (já exposto em `LanguageClient.capabilities`).
5. Abrir um `.cshtml` de um projeto ASP.NET Core real e exercitar
   `completion`, `hover`, `publishDiagnostics`, `definition`, `formatting`.

A infra para tudo isso **já está implementada e compila** (`client.ts`,
`transport.ts`, `bridge.rs`). Falta apenas o binário do `rzls`.

## Contexto arquitetural (o ponto central do risco)

O `rzls` **não foi projetado para funcionar sozinho via LSP puro**. Em produção
(C# Dev Kit / `vscode-csharp`), o fluxo Razor é:

```
Editor (.cshtml)
   │  documento Razor
   ▼
Razor tooling (cliente especial)  ── projeção ──►  buffers sintéticos C# e HTML
   │                                                  │
   │  requests Razor (custom)                         │  requests LSP padrão
   ▼                                                  ▼
   rzls  ◄──── coordena ────►  Roslyn (C#)        servidor HTML/CSS
```

Ou seja: o cliente (não o servidor) gera **documentos virtuais** de C# e HTML a
partir do `.cshtml`, calcula posições projetadas, encaminha completion/hover para
o Roslyn/HTML server e **re-mapeia** os resultados de volta para o `.cshtml`. O
`rzls` orquestra isso por meio de **requests/notifications customizados** (fora
do LSP padrão), por exemplo `razor/...`, `razor/provideSemanticTokensRange`,
`textDocument/_vs_*`, dynamic file info, etc.

**Implicação:** conectar o `rzls` por um `MonacoLanguageClient` (ou pelo nosso
client) falando **apenas LSP padrão**, sem implementar essa camada de projeção
no cliente, deixa a maior parte do IntelliSense semântico inoperante.

## Avaliação por request (esperado, NÃO testado)

| Request | Resultado esperado via LSP puro | Justificativa |
| --- | --- | --- |
| `initialize` | **Funciona** | `rzls` responde e anuncia capabilities. |
| `textDocument/publishDiagnostics` | **Parcial / talvez** | Diagnósticos de sintaxe Razor podem ser publicados pelo próprio rzls; diagnósticos de C# semântico geralmente dependem da projeção + Roslyn. Mais provável feature a entregar algum valor. |
| `textDocument/completion` | **Não funciona / requer projeção** | Completions de C#/HTML são calculadas nos buffers projetados; sem projeção o rzls não tem onde delegar. |
| `textDocument/hover` | **Não funciona / requer projeção** | Idem — tipos do `Model` vêm do Roslyn via projeção. |
| `textDocument/definition` | **Não funciona / requer projeção** | Idem. |
| `textDocument/formatting` | **Incerto / arriscado** | rzls tem formatador próprio, mas pode depender de sincronização com os buffers projetados; risco de corromper Razor. Manter desabilitado até teste real. |
| Semantic tokens | **Custom / não-padrão** | rzls usa `razor/provideSemanticTokensRange` (não o `textDocument/semanticTokens` padrão). Não aproveitável sem código específico. |

Além disso, o `rzls` provavelmente **exige o Roslyn (C# LSP) ativo como host** e
emite notificações de *dynamic file info* / *project configuration* que o cliente
precisa atender — sem isso ele pode nem inicializar projetos corretamente.

## Decisão de escopo da ISSUE-31 (REBAIXADA — honesto)

Com base no acima, a ISSUE-31 foi **rebaixada** de "IntelliSense Razor completo"
para:

### Entregue de verdade (compila, integra na infra)
- ✅ **Syntax highlight** Razor no Monaco (tokenizer Monarch — ISSUE-29).
  Independente do `rzls`; funciona hoje, offline, sem servidor.
- ✅ **Infra LSP genérica** (spawn + codec + bridge WS loopback + client factory
  + diagnostics→`Problem[]`) pronta e reusável por C#/TS.
- ✅ **Lifecycle do Razor**: ao abrir `.cshtml`, o manager tenta subir o `rzls`;
  se indisponível (download stub / não cacheado), marca status `unavailable`
  sem quebrar o editor.
- ✅ **Pipeline de diagnósticos** pronto: se/quando o `rzls` publicar
  `publishDiagnostics` via LSP puro, eles já viram markers + `Problem[]`
  automaticamente, sem mais código.

### Fora de escopo (milestone futura — requer projeção de documentos)
- ❌ Completions, hover, go-to-definition dentro de regiões C#/HTML projetadas.
- ❌ IntelliSense de membros do `Model`/`ViewBag`/Tag Helpers.
- ❌ Formatação de `.cshtml` (desabilitada por risco de corrupção).
- ❌ Suporte a `_ViewImports.cshtml` / Layouts via semântica do servidor.

Esses itens exigem implementar a **camada de projeção de documentos**
(buffers sintéticos C#/HTML + forwarding/remapping de requests + handlers para os
métodos custom do `rzls` + coordenação com o Roslyn). Isso é uma milestone
dedicada, fora do orçamento deste épico.

## TODOs para validar/elevar o escopo no futuro

1. Concluir ISSUE-26 (download/cache do Roslyn) e localizar o `rzls` real;
   implementar `download_rzls` em `src-tauri/src/lsp/razor.rs` (hoje é stub).
2. Capturar o `initialize` real e substituir a tabela "esperado" por medições.
3. Confirmar os args de launch corretos do `rzls` (`razor.rs` usa best-effort).
4. Avaliar adoção do `monaco-languageclient` + `vscode-ws-jsonrpc` (depende do
   spike de compatibilidade da ISSUE-19, fora deste worktree) em vez do client
   JSON-RPC artesanal atual — o `transport.ts` foi isolado para essa troca.
5. Abrir milestone "Razor: projeção de documentos" se o passo 2 confirmar que o
   IntelliSense semântico não vem via LSP puro.

## Nota sobre o client JSON-RPC artesanal

A ISSUE-23 pedia `monaco-languageclient` + `vscode-ws-jsonrpc`. Aqui foi usado um
client JSON-RPC mínimo próprio (`client.ts`) porque:
- O spike de compatibilidade (ISSUE-19) que **fixa a versão** do
  `monaco-languageclient` não faz parte deste worktree isolado.
- `monaco-languageclient` v8+ exige `@codingame/monaco-vscode-api`, que conflita
  com `@monaco-editor/react@4.6` + `monaco-editor@0.52` (risco citado no épico C#).
- Restrição da tarefa de não pendurar em instalações grandes/arriscadas.

O `transport.ts` encapsula 100% do detalhe de transporte, então migrar para
`monaco-languageclient` depois é uma mudança localizada.
