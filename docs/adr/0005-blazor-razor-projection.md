# ADR 0005 — Semântica de `.razor` (Blazor) via projeção C# + Roslyn

- **Status:** aceito (direção); implementação **faseada** em issues
- **Data:** 09/07/2026
- **Milestone/issue:** #8 (C# Dev Kit parity — Blazor `.razor` semântico);
  Fase 1 → #105, Fase 2 → #106
- **Evidência:** teste empírico do emit do Razor compiler para `.razor`
  (ver "Contexto"); supersede parcialmente a nota de `editor.md`/`language.ts`
  ("`.razor` always cohost").

## Contexto

Hoje `.razor` (componentes Blazor) tem apenas **highlight (Shiki) + lint HTML
client-side**. Toda a semântica (hover, definition, completion, diagnósticos C#,
`@code`, `@bind`, componentes) está **ausente**: `.razor` é roteado para o
**cohost** (`aspnetcorerazor`), que está **bloqueado headless** — o Razor source
generator não roda no processo OOP (ADR 0002 / `FINDINGS-fase0.md`).

A milestone #7 provou que a **projeção in-house** (sidecar emite `.g.cs` + Roslyn
standalone + remap por `#line`) dá semântica real para `.cshtml`. A pergunta do
ADR: **essa projeção serve para `.razor`?**

### Fato empírico decisivo

Compilando um Blazor Web App real com `-p:EmitCompilerGeneratedFiles=true`:

- O Razor compiler **emite `.g.cs` para cada `.razor`** (`Counter_razor.g.cs`,
  `Weather_razor.g.cs`, …), exatamente como para `.cshtml`.
- Os `.g.cs` têm **`#line` mapping** de volta para o `.razor` e a **classe do
  componente** com o `@code` como C# real:
  ```
  #line (12,8)-(19,1) ".../Counter.razor"
      private int currentCount = 0;
      private void IncrementCount() { currentCount++; }
  ```
- O markup Blazor (`@currentCount`, `@onclick="IncrementCount"`) também mapeia.

**Conclusão:** a cadeia `.razor` → Razor compiler → `.g.cs`+`#line` → Roslyn
standalone → hover/def/diagnostics → remap para o `.razor` **é viável** — o mesmo
pipeline da #7, sem bloqueio arquitetural (ao contrário do cohost).

## Decisão

**Estender a projeção C#+Roslyn (Opção A) para `.razor`**, em vez de desbloquear
o cohost. Implementação **faseada** para não arriscar o pipeline `.cshtml` já
entregue:

- **Fase 1 (issue #105) — depende da #7 mergeada:** generalizar o roteamento e o
  broker para serem **extension-agnostic** (`.cshtml` E `.razor`), atrás do mesmo
  feature flag. O broker Rust hoje é acoplado a `.cshtml` (`cshtml_rel`,
  `_ViewImports.cshtml`/`_ViewStart.cshtml`); generalizar para aceitar `.razor`
  com suas diferenças (`_Imports.razor`, sem `_ViewStart`). Dá hover/def/
  diagnostics/completion C# aos componentes reusando os providers da #7.
- **Fase 2 (issue #106):** paridade semântica específica de Blazor — completion
  de componentes (`<Counter />`), atributos de parâmetro `[Parameter]`, `@bind`,
  event handlers.

> **Por que a Fase 1 não é feita junto deste ADR:** o broker é o MESMO código que
> a #7 (projeção `.cshtml`) estende — a #7 precisa mergear antes, senão a
> generalização seria sobre uma base prestes a mudar. Além disso, o contrato
> exige o E2E `razor-projection.e2e.ts` (Windows) como gate de não-regressão do
> `.cshtml` antes de tocar o broker; fazer a refatoração sem esse gate disponível
> (o `tauri-driver` não roda no macOS) seria imprudente. Este ADR fixa a
> **direção com viabilidade provada**; a Fase 1 é executada quando essas
> pré-condições existirem.

## Diferenças Blazor vs MVC que a implementação trata

| Aspecto | `.cshtml` (MVC/Pages) | `.razor` (Blazor) |
|---|---|---|
| Imports | `_ViewImports.cshtml` + `_ViewStart.cshtml` | `_Imports.razor` (sem `_ViewStart`) |
| Diretivas | `@model`, `@page` (MVC) | `@page`, `@code`, `@rendermode`, `@inject` |
| "Tags" próprias | Tag Helpers (`asp-*`) | **Componentes** (`<Counter />`, `@bind-Value`) |
| Base gerada | `RazorPage<TModel>` | `ComponentBase` |

O source map `#line` e a projeção C# são idênticos; a diferença está na
descoberta de imports e nas construções de markup (componentes ≠ tag helpers).

## Alternativas rejeitadas

- **Desbloquear o cohost.** O bloqueio ("Razor source generator not referenced /
  no run result" no OOP) é **host-side do Visual Studio** e não tem passo
  client-side que um LSP headless possa invocar (provado na Fase B do
  `FINDINGS-fase0.md`). Sem caminho.
- **C# Dev Kit / rzls proprietário.** Licença restrita a VS/VS Code.
- **Não fazer.** `.razor` continua sem semântica — o maior gap vs o Dev Kit.

## Consequências

- **Positivas:** Blazor ganha a mesma base semântica do `.cshtml` (hover/def/
  diagnostics/completion C#) reusando toda a infra da #7; sem código proprietário
  nem cohost.
- **Negativas / riscos:** generalizar o broker toca código que serve `.cshtml`
  hoje — precisa de não-regressão do `.cshtml` (o E2E `razor-projection.e2e.ts`).
  A paridade Blazor completa (componentes/`@bind`) é multi-fase.
- **Contratos:** manter `.cshtml` e `.razor` com language ids distintos (o
  `cshtml-language-service.md` exige separação); a projeção pode ser compartilhada
  internamente, mas o registro/selector por linguagem permanece separado.
- **Rollback:** por trás do mesmo feature flag de projeção; `.razor` volta ao
  cohost (comportamento atual) desligando-o.

## Validação

- Emit de `.g.cs` para `.razor` **provado** (acima).
- Fase 1: não-regressão do `.cshtml` (unit + E2E Windows) ao generalizar o
  broker; roteamento de `.razor` para a projeção atrás do flag.
- Aceite semântico ao vivo (hover em `@code`, diagnóstico C# num componente) é
  gate do E2E Windows / passo manual, como no brick 6 da #7.
