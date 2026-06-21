# CSHTML — matriz de funcionalidades e fases

Esta matriz define a sequência da milestone
[CSHTML: Language Service e Linter Independentes](https://github.com/Vagnerking/FluentCoder/milestone/1).
Ela não declara funcionalidades como implementadas; o estado real é controlado
pelas issues vinculadas.

## Fases

| Fase | Resultado utilizável | Issues |
|---|---|---|
| 0 — contratos | arquitetura, limites e corpus definidos | #31, #33, #34 |
| 1 — lint MVP | parser, source maps, diagnósticos e Monaco isolados | #32, #35–#39 |
| 2 — workspace | projetos/imports e índices próprios | #40–#43 |
| 3 — IntelliSense | completion, hover, definition e tokens | #44 |
| 4 — Views | partials, layouts e Tag Helpers | #45 |
| 5 — produção | performance, observabilidade e remoção do legado | #46 |

## Matriz

Legenda:

- **implementado:** código merged e com testes na main (ou PR aberto nesta milestone);
- **MVP:** necessária para validar a engine no editor;
- **planejada:** pertence à milestone, mas depende das fases anteriores;
- **posterior:** exige ADR/issue própria antes da implementação.

| Funcionalidade | Estado alvo | Fase/issue | Módulo Rust | Fallback seguro |
|---|---|---|---|---|
| Language id `.cshtml` separado | implementado | #32 | `cshtml/mod.rs` | highlight léxico |
| Snapshots e edits incrementais | implementado | #33 | `cshtml/document.rs`, `cshtml/engine.rs` | sincronização full text |
| Corpus/golden tests | implementado | #34 | `cshtml/harness.rs` | bloquear avanço do parser |
| Parser Razor tolerante a erro | implementado | #35 | `cshtml/parser.rs`, `cshtml/ast.rs` | texto/markup desconhecido |
| Projeção HTML/C# | implementado | #36 | `cshtml/projection.rs` | região sem semântica |
| Diagnósticos Razor `FCRZ0001–0009` | implementado | #37 | `cshtml/lint.rs` | nenhum falso positivo |
| LSP 3.17 stdio | implementado | #38 | `bin/fluent_cshtml_lsp.rs`, `lsp/fluent_cshtml.rs` | engine testável sem LSP |
| Markers/painel Problemas (adapter) | MVP | #39 | `src/lsp/servers/cshtml.ts` | limpar ao falhar |
| Folding/document symbols | MVP | #38/#39 | AST | retornar vazio |
| Projeto associado ao documento | implementado | #40 | `cshtml/workspace.rs` | contexto desconhecido |
| `_ViewImports.cshtml` | implementado | #40 | `cshtml/workspace.rs` | somente diretivas locais |
| Índice de source C# | implementado | #41 | `cshtml/semantics.rs` | símbolo `unknown` |
| Metadata ECMA-335 | implementado | #42 | `cshtml/metadata.rs` | somente source |
| Binding de `@model` | implementado | #43 | `cshtml/binding.rs` | `Model` desconhecido |
| `@inject` e escopos | implementado | #43 | `cshtml/binding.rs` | sem diagnóstico semântico |
| Completion de diretivas | implementado | #44 | `cshtml/intellisense.rs` | nenhuma suggestion |
| Completion HTML | implementado | #44 | `cshtml/intellisense.rs` | nenhuma suggestion |
| Completion `Model.` | implementado | #44 | `cshtml/intellisense.rs` | nenhuma suggestion |
| Hover e signature help | implementado | #44 | `cshtml/intellisense.rs` | `null` |
| Go to definition | implementado | #44 | `cshtml/intellisense.rs` | lista vazia |
| Semantic tokens | implementado | #44 | `cshtml/intellisense.rs` | Monarch lexical |
| Partials e layouts | implementado | #45 | `cshtml/views.rs` | sem navegação |
| Tag Helpers (builtins + source) | implementado | #45 | `cshtml/views.rs` | tratar como HTML |
| Cancelamento cooperativo | implementado | #46 | `cshtml/hardening.rs` | timeout por resultado |
| Cache com invalidação | implementado | #46 | `cshtml/hardening.rs` | sem cache |
| Métricas e log estruturado | implementado | #46 | `cshtml/hardening.rs` | silencioso |
| Formatação de documento | posterior | issue/ADR futuro | AST + edits seguros | desabilitada |
| Rename | posterior | issue/ADR futuro | referências confiáveis | desabilitado |
| Code actions | posterior | issue futura | diagnósticos estáveis | lista vazia |
| Analyzers/source generators | posterior | fora da milestone | não definido | não suportado |
| Paridade total com compilador C# | não objetivo | fora da milestone | compilador real | `dotnet build` explícito |
| Componentes `.razor`/Blazor | não objetivo | milestone separada | serviço próprio futuro | suporte atual |

## Gates

### Gate A — iniciar implementação do parser

- ADR e contratos aceitos;
- modelo canônico de posições definido;
- corpus mínimo disponível;
- dependências candidatas com licença revisada.

### Gate B — habilitar engine no Monaco

- `.cshtml` e `.razor` separados;
- parser incremental equivalente ao parse completo nas fixtures;
- source maps passam round-trip;
- diagnósticos são versionados/canceláveis;
- server e marker owner exclusivos;
- rollback por feature flag/registry validado.

### Gate C — habilitar diagnósticos semânticos

- workspace revision implementada;
- índices representam `resolved`, `unknown` e `ambiguous`;
- nenhuma ausência de contexto vira falso “símbolo inexistente”;
- source e metadata usam o mesmo modelo de símbolos.

### Gate D — remover cohosting/`rzls`

- lint MVP funcional no editor;
- restart/troca de workspace/StrictMode validados;
- testes de não regressão C#/Roslyn e TS/JS verdes;
- nenhum selector ou registry restante reivindica `.cshtml`;
- documentação e comandos de aquisição antigos atualizados/removidos;
- rollback da versão anterior documentado.

## Definition of Done da milestone

Itens implementados (PRs #53–#64):

- [x] Engine `CshtmlEngine` com documento incremental e snapshots
- [x] Parser Razor com AST própria e recuperação de erro
- [x] Corpus de conformidade e harness de regressão
- [x] Projeções HTML/C# e source maps
- [x] Diagnósticos `FCRZ0001–0009` com regras de lint Razor
- [x] Servidor LSP 3.17 standalone em processo isolado (`fluent-cshtml-lsp`)
- [x] Adapter frontend (`src/lsp/servers/cshtml.ts`) com `startCshtmlServer`
- [x] Workspace SDK-style: `_ViewImports`, `ProjectContext`, `DocumentContext`
- [x] Índice de source C# sem Roslyn (`SymbolIndex`)
- [x] Leitor de metadata ECMA-335 (`MetadataCache`)
- [x] Binding: `@model`, `@inject`, escopos, símbolos implícitos Razor
- [x] IntelliSense: completion, hover, definition, semantic tokens
- [x] Views: `ViewGraph`, `TagHelperIndex` (14 builtins), `validate_sections`
- [x] Hardening: `CancelToken`, `BoundedCache`, `DiagMetrics`, `WorkspaceSession`

Pendentes antes de fechar Gate D (remoção do cohosting):

- [ ] Adapter Monaco `#39` completo (markers, providers, reset command)
- [ ] Testes de não regressão C#/Roslyn e TS/JS verdes em produção
- [ ] Feature flag de migração validada
- [ ] Documentação de rollback
