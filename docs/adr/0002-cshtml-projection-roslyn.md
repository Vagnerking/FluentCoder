# ADR 0002 — CSHTML/Razor via projeção C# + Roslyn (supersede ADR 0001)

- **Status:** aceito
- **Data:** 23/06/2026
- **Supersede:** [ADR 0001 — Language service CSHTML independente](0001-cshtml-language-service.md)
- **Evidência:** [tools/razor-lsp-probe/FINDINGS-fase0.md](../../tools/razor-lsp-probe/FINDINGS-fase0.md)

## Contexto

O [ADR 0001](0001-cshtml-language-service.md) decidiu implementar uma engine `.cshtml` própria em Rust, **sem Roslyn**, sem `rzls`, sem cohosting. Após a milestone #1, `.cshtml`/`.razor` continuavam **sem lint de erros C#, sem cores corretas e sem ctrl+click/identificação de tipos**. A causa raiz é estrutural: análise de tipo real (tipos, generics, overloads, TagHelpers, membros do `@model`) exige um **modelo semântico C# real**; um scanner de tokens + leitor ECMA-335 não entrega isso, e o servidor homegrown nem expõe hover/definition/semanticTokens/completion (só diagnostics de sintaxe).

Foram avaliadas três direções (ver FINDINGS): **(A) cohosting Roslyn** (o cohost serve `.cshtml` mas, na versão disponível, o gerador Razor não executa no processo OOP → toda feature falha com "no run result"; esgotadas as alavancas client-side, é um bug host-side não acionável por um cliente LSP); **(B) projeção in-house**; **(C) continuar o homegrown** (não alcança semântica real). O usuário autorizou abandonar a abordagem atual.

Provou-se empiricamente (spike b1) que o caminho de projeção funciona end-to-end.

## Decisão

Adotar a **Opção B (variante b1): projeção C# alimentando o Roslyn C# padrão.**

1. O **compilador Razor real** (`Microsoft.CodeAnalysis.Razor.Compiler`, o source generator do SDK) produz o C# projetado (`.g.cs`) a partir do `.cshtml`, já com diretivas **`#line (l,c)-(l,c)`** mapeando cada trecho de volta ao `.cshtml` e a base `RazorPage<TModel>` tipada.
2. Esse C# projetado é analisado pelo **`Microsoft.CodeAnalysis.LanguageServer` (Roslyn) padrão** — o mesmo que o app já usa para `.cs` — dentro de uma compilação com as **referências do projeto do usuário**.
3. Um **broker** encaminha hover/definition/completion/diagnostics/semanticTokens para o doc projetado e **remapeia ranges** de volta ao `.cshtml` pelos `#line` (reusando/estendendo [projection.rs](../../src-tauri/src/cshtml/projection.rs)); resultados em texto sintético/não-mapeável são descartados (contrato da [cshtml-language-service.md](../context/cshtml-language-service.md)).
4. O motor homegrown `fluent-cshtml` é **aposentado atrás de feature flag** (ponto único de rollback) e removido após os testes de não regressão.

Prova de viabilidade (spike b1, commit `0c2659c`): sobre o `.g.cs` projetado, o Roslyn padrão devolve `textDocument/diagnostic` → **CS1061**, hover em `Model.City` → **`string WeatherModel.City { get; set; }`**, definition → **`WeatherModel.cs`**; e `dotnet build` já reporta o erro em **`Index.cshtml(16,15)`** (mapeado por `#line`).

### O que muda em relação ao ADR 0001
- **Permitido** depender do Roslyn (C#) e do compilador Razor do SDK para a semântica — eram proibidos no ADR 0001. **Continua proibido** depender dos métodos privados/cohost (`razor/*`, `_vs_*`) e do serviço OOP do cohost.
- Mantém-se: id Monaco e ownership, política de diagnósticos/ranges sempre no `.cshtml`, lifecycle/reset, separação `.cshtml`×`.razor`, e a dedup com `dotnet-build`.

## Consequências

**Positivas:** entrega semântica C# real reusando binários Microsoft já presentes; o mapeamento vem do próprio compilador (não reimplementamos codegen nem source map). **Provado no spike b1:** diagnostics, hover e definition. **Alvo/esperado** (mesmo mecanismo Roslyn, a validar na implementação): completion, semantic tokens, references, signature help.

**Custos / riscos:** manter uma "shadow compilation" com as refs exatas do projeto do usuário; evitar duplicação com o gerador do SDK; regenerar a projeção ao vivo em edições de `.cshtml`/`_ViewImports`/model/refs; mapear corretamente os `#line` (inclusive a forma estendida) e rejeitar ranges sintéticos; regiões **HTML/TagHelper** ficam para a delegação HTML (fase separada). Licença: os binários Roslyn/Razor são baixados em runtime (mesmo modelo do VS Code), não redistribuídos no app.

## Alternativas rejeitadas
- **Cohosting (A):** bloqueado na versão disponível (gerador não roda no OOP; fix é host-side do VS). Reavaliar se um build futuro corrigir o caminho OSS.
- **Codegen Razor à mão (b2):** frágil demais (MVC views, `_ViewImports`, TagHelpers, base types, mapeamento).
- **Continuar o homegrown (C):** não alcança semântica real.

## Migração
Incremental e reversível por flag única, conforme o checklist da [cshtml-language-service.md](../context/cshtml-language-service.md). O código homegrown só é removido após não-regressão verde.
