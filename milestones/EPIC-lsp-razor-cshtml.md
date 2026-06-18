# Épico: Razor / .cshtml — IntelliSense no Monaco

> **Status:** Parcial — highlight + infra LSP + diagnósticos best-effort entregues;
> IntelliSense semântico rebaixado para milestone futura (projeção de documentos).
> **Owner:** Vagner
> **Stack:** Tauri 2 · Rust · React 18 · TypeScript · Monaco · monaco-languageclient · rzls

## Visão

Adicionar suporte de desenvolvimento para arquivos **Razor Views** (`.cshtml`) no Monaco Editor,
combinando corretamente os contextos de **C#, HTML, CSS, JavaScript** e sintaxe Razor — Tag Helpers,
`@model`, `ViewBag`, `ViewData`, Partial Views, Layouts, Sections e `_ViewImports.cshtml`.

O objetivo não é tratar `.cshtml` como HTML comum, mas entregar uma experiência real de
desenvolvimento Razor com diagnósticos, IntelliSense (dentro do limite do servidor) e formatação.

Este épico **reusa integralmente** a infraestrutura LSP criada no épico
[IntelliSense C# via LSP](EPIC-lsp-intellisense-csharp.md): bridge WebSocket, `monaco-languageclient`
factory, pipeline de diagnósticos → `Problem[]` e lifecycle manager. Só é necessário registrar a
linguagem, adquirir o servidor `rzls` e configurar o client Razor.

## Estado atual (baseline)

- Arquivos `.cshtml` abrem no Monaco como "plaintext" — sem mapeamento de linguagem em
  [language.ts](../src/language.ts), sem syntax highlight Razor, sem IntelliSense.
- Monaco não tem linguagem `razor` embutida (diferente de `html`, `typescript`, etc.).
- O `rzls` (Razor Language Server) é distribuído junto com o pacote Roslyn/C# tooling —
  o download já feito pela ISSUE-26 do épico C# pode incluí-lo.
- Toda a infra de bridge, transport e lifecycle virá do épico C# (ISSUE-20–25).

## Escopo deste épico

| Item | Decisão |
| --- | --- |
| Servidor | **rzls** (Razor Language Server), extraído do pacote Roslyn da ISSUE-26 |
| Linguagem Monaco | Registrar `razor` como nova linguagem (Monaco não tem nativo) com tokenizer básico |
| Profundidade do IntelliSense | **Best-effort** — spike (ISSUE-32) define o escopo realista antes de fechar a implementação |
| Projeção de documentos embutidos | **Fora de escopo** (C#/HTML/CSS projetados em buffers separados) salvo se o rzls fizer sozinho |
| Recursos LSP | Diagnósticos, hover, completions básicas — conforme capabilities do rzls |
| Tag Helpers / @model / ViewModel | Quando suportado pelo servidor |
| Formatação .cshtml | Quando suportada pelo servidor sem quebrar sintaxe Razor |

## Issues

| # | Título | Camada | Depende de | Estimativa |
| --- | --- | --- | --- | --- |
| [29](issues/ISSUE-29-razor-language-registration.md) | Front: registrar linguagem razor no Monaco | Front | 24 | S |
| [30](issues/ISSUE-30-razor-server-acquisition.md) | Rust: aquisição e launch do rzls | Rust | 26 | M |
| [32](issues/ISSUE-32-razor-capability-spike.md) | Full: spike de capabilities do rzls | Full | 30 | M |
| [31](issues/ISSUE-31-razor-client-config.md) | Full: Razor client config (best-effort) | Full | 23, 25, 30, 27, 32 | L |

`S` = pequeno, `M` = médio, `L` = grande.

## Ordem de implementação sugerida

1. **29** (registro da linguagem) — pode rodar logo que ISSUE-24 do épico C# estiver pronta.
2. **30** (aquisição do rzls) — paralelo com 29, depende do download Roslyn (ISSUE-26).
3. **32** (spike) — **obrigatório antes de fechar a 31**; determina o escopo realista do IntelliSense Razor.
4. **31** (client config completo) — implementação final, podendo ser rebaixada a "diagnostics only" conforme spike.

## Critérios de aceite do épico

- [x] Arquivos `.cshtml` abrem corretamente no Monaco com reconhecimento de linguagem `razor`.
- [x] Syntax highlight básico diferencia blocos C# (`@{ }`), HTML e Razor syntax.
- [~] Diagnósticos de erro Razor aparecem no editor e no ProblemsPanel — pipeline pronto (markers +
      `Problem[]`); depende do rzls publicar via LSP puro. ProblemsPanel não existe ainda neste
      worktree (dados expostos para painel futuro). Não testado com rzls real.
- [ ] Diagnósticos de erro C# dentro da View — **fora de escopo** (requer projeção; ver spike).
- [ ] IntelliSense dentro de blocos `@{ }` — **fora de escopo** (requer projeção; ver spike).
- [ ] Hover de membros do ViewModel — **fora de escopo** (requer projeção; ver spike).
- [ ] `_ViewImports.cshtml` — **fora de escopo** (requer projeção; ver spike).
- [ ] Formatação de `.cshtml` — **desabilitada** por segurança (risco de corromper Razor).
- [x] Escopo real das features documentado — [src/lsp/RAZOR-SPIKE.md](../src/lsp/RAZOR-SPIKE.md) (ISSUE-32).
- [x] `tsc --noEmit` e `cargo check` sem erros.
- [ ] Teste E2E (tauri-driver) — **não executado** (restrição do worktree isolado).

> **Resultado honesto:** entregue **syntax highlight Razor** + **infra LSP genérica completa**
> (spawn/codec/bridge WS loopback/client factory/diagnostics) + **lifecycle Razor best-effort**.
> O IntelliSense semântico do Razor exige a camada de **projeção de documentos** (milestone futura),
> conforme conclusão do spike ISSUE-32. rzls não foi baixado/executado neste worktree.

## Riscos / notas

- **Profundidade real do rzls via LSP puro:** em produção, o suporte a Razor no VS Code usa
  "projeção de documentos" (synthetic C#/HTML buffers com request forwarding) — uma camada
  acima do LSP padrão. Sem essa camada, muitas features podem não funcionar. O spike (ISSUE-32)
  decide o que é entregável antes de qualquer comprometimento com ISSUE-31.
- **Se o spike mostrar pouco valor:** rebaixar o épico para "syntax highlight + diagnósticos básicos"
  e abrir uma milestone futura para projeção de documentos completa.
- **Dependência do épico C#:** este épico **não** implementa antes que ISSUE-23, 25 e 26 estejam
  prontas. O rzls depende do mesmo download do Roslyn.
- **E2E obrigatório (regra do projeto):** ao concluir o épico, rodar `tauri build` + tauri-driver;
  não usar Playwright/MCP.
