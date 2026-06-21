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

- **MVP:** necessária para validar a engine no editor;
- **planejada:** pertence à milestone, mas depende das fases anteriores;
- **posterior:** exige ADR/issue própria antes da implementação.

| Funcionalidade | Estado alvo | Fase/issue | Fonte de verdade | Fallback seguro |
|---|---|---|---|---|
| Language id `.cshtml` separado | MVP | #32 | registry do editor | highlight léxico |
| Snapshots e edits incrementais | MVP | #33 | `CshtmlEngine` | sincronização full text |
| Corpus/golden tests | MVP | #34 | fixtures versionadas | bloquear avanço do parser |
| Parser Razor tolerante a erro | MVP | #35 | AST própria | texto/markup desconhecido |
| Projeção HTML/C# | MVP | #36 | source maps da engine | região sem semântica |
| Diagnósticos Razor | MVP | #37 | regras `FCRZ1xxx` | nenhum falso positivo |
| Diagnósticos HTML seguros | MVP | #37 | regras `FCRZ2xxx` | omitir quando ambíguo |
| Diagnósticos de sintaxe C# | MVP | #37 | parser C# projetado | omitir trecho não mapeável |
| LSP 3.17 stdio | MVP | #38 | adapter LSP | engine testável sem LSP |
| Markers/painel Problemas | MVP | #39 | owner `fluent-cshtml` | limpar ao falhar |
| Folding/document symbols | MVP | #38/#39 | AST | retornar vazio |
| Projeto associado ao documento | planejada | #40 | workspace próprio | contexto desconhecido |
| `_ViewImports.cshtml` | planejada | #40 | hierarquia de diretórios | somente diretivas locais |
| Índice de source C# | planejada | #41 | `SymbolIndex` | símbolo `unknown` |
| Metadata ECMA-335 | planejada | #42 | `MetadataIndex` | somente source |
| Binding de `@model` | planejada | #43 | binder da engine | `Model` desconhecido |
| `@inject` e escopos | planejada | #43 | binder da engine | sem diagnóstico semântico |
| Completion de diretivas | planejada | #44 | tabela/AST Razor | nenhuma suggestion |
| Completion HTML | planejada | #44 | contexto markup | nenhuma suggestion |
| Completion `Model.` | planejada | #44 | binder + índices | nenhuma suggestion |
| Hover e signature help | planejada | #44 | símbolos resolvidos | `null` |
| Go to definition | planejada | #44 | localização do símbolo | lista vazia |
| Semantic tokens | planejada | #44 | AST + binder | Monarch lexical |
| Partials e layouts | planejada | #45 | `ViewGraph` | sem navegação |
| Tag Helpers | planejada | #45 | `TagHelperIndex` | tratar como HTML |
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

- erro Razor/C# sintático aparece e desaparece sem restart;
- `Model.` oferece membros conhecidos sem Roslyn para `.cshtml`;
- hover e definition funcionam para símbolos suportados;
- `_ViewImports`, partials, layouts e Tag Helpers atendem às issues respectivas;
- providers, markers e processos não vazam entre sessões/workspaces;
- falha do serviço CSHTML não interrompe C#, TS/JS ou o editor;
- o caminho legado não é mais iniciado para `.cshtml`;
- métricas e limites de performance da #46 estão validados.
