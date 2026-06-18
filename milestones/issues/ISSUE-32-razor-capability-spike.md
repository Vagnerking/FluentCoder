# ISSUE-32 · Full: spike de capabilities do rzls

**Épico:** [Razor / .cshtml — IntelliSense no Monaco](../EPIC-lsp-razor-cshtml.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 30

## Contexto

O Razor Language Server (`rzls`) em produção (VS Code C# Dev Kit) usa uma camada de "projeção de
documentos" não-padrão: documentos `.cshtml` são projetados em buffers sintéticos de C# e HTML
para os quais o IntelliSense é calculado separadamente. Essa camada **não faz parte do protocolo
LSP padrão**.

Sem ela, alguns recursos podem não funcionar ou funcionar de forma degradada. Este spike conecta o
`rzls` pelo bridge LSP padrão, captura o response de `initialize` e testa os requests básicos para
determinar o que realmente funciona — **antes** de comprometer escopo e tempo na ISSUE-31.

## Tarefas

- [x] Usar a infra das ISSUEs 23 e 30 para subir o `rzls` via bridge e conectar um client
      com `documentSelector: [{ language: 'razor' }]` — **infra pronta e compilando**
      (`client.ts`/`transport.ts`/`bridge.rs`); execução real bloqueada pela ausência do binário rzls.
- [~] Capturar o response completo de `initialize` e logar as `ServerCapabilities` — `capabilities`
      é exposto em `LanguageClient.capabilities`; **não capturado de verdade** (rzls não executado).
- [~] Testar manualmente os requests — **análise estática** (protocolo + código aberto do `dotnet/razor`
      e `vscode-csharp`), NÃO teste real. Ver tabela em `src/lsp/RAZOR-SPIKE.md`.
- [x] Documentar para cada request (funciona/parcial/não/requer projeção) — em `RAZOR-SPIKE.md`.
- [x] Definir o **escopo real** da ISSUE-31: **REBAIXADO** para "syntax highlight + diagnósticos
      best-effort"; IntelliSense semântico (completion/hover/def/format) fica para milestone futura
      de **projeção de documentos**.

## Arquivos

- `src/lsp/servers/razor.ts` (arquivo temporário de spike, pode ser refinado na ISSUE-31)
- Resultado documentado como seção "Findings" dentro desta issue (editável após o spike)

## Detalhes técnicos

- O spike pode usar um arquivo de teste simples com `razor.ts` temporário — não é necessário
  implementação completa.
- Registrar as `ServerCapabilities` encontradas: `completionProvider`, `hoverProvider`,
  `diagnosticProvider`/`textDocumentSync`, `definitionProvider`, `documentFormattingProvider`.
- Verificar também se o rzls envia notificações customizadas (fora do LSP padrão) que indicam
  a necessidade de projeção de documentos.

## Critérios de aceite

- [~] O `rzls` sobe e responde ao `initialize` — infra capaz disso pronta; **não executado**
      (binário rzls indisponível — download stub).
- [x] `ServerCapabilities` do rzls documentadas (esperadas/analisadas) em `RAZOR-SPIKE.md`.
- [x] Resultado de cada request documentado (funciona/parcial/não/requer projeção) em `RAZOR-SPIKE.md`.
- [x] Decisão de escopo da ISSUE-31 registrada com justificativa (REBAIXADA).

> **Spike PARCIAL/ESTÁTICO (honesto).** Conclusões baseadas em protocolo + código aberto do
> `rzls`, sem captura real de `initialize` (restrição: não baixar/rodar rzls). Conclusão central:
> sem a camada de **projeção de documentos** (lado cliente), o IntelliSense semântico não vem via
> LSP puro; apenas highlight (já entregue) e, possivelmente, diagnósticos básicos. Detalhes e
> findings completos em [src/lsp/RAZOR-SPIKE.md](../../src/lsp/RAZOR-SPIKE.md).
