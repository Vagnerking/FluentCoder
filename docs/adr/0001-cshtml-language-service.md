# ADR 0001 — Language service CSHTML independente

- **Status:** aceito
- **Data:** 21/06/2026
- **Milestone:** [CSHTML: Language Service e Linter Independentes](https://github.com/Vagnerking/FluentCoder/milestone/1)
- **Issue:** [#31](https://github.com/Vagnerking/FluentCoder/issues/31)

## Contexto

O editor precisa analisar arquivos `.cshtml` sem depender de Roslyn para Razor,
do `rzls`, de métodos `_vs_*`/`razor/*` ou do cliente especial distribuído pela
Microsoft para VS Code.

O código atual contém dois caminhos experimentais:

1. cohosting de `.cshtml` no processo Roslyn usado por C#;
2. um adapter legado para um executável `rzls` cuja aquisição nunca foi
   concluída.

Esses caminhos acoplam o lifecycle de CSHTML ao C#, não entregam um protocolo
Razor público e completo e podem registrar providers concorrentes. O spike que
documentou essa limitação permanece em
[`src/lsp/RAZOR-SPIKE.md`](../../src/lsp/RAZOR-SPIKE.md) apenas como histórico.

## Decisão

Será criada uma engine própria em Rust, chamada neste documento de
`CshtmlEngine`. A engine será o único lugar onde vivem regras de parsing,
projeção, lint, workspace e semântica de CSHTML.

```text
┌──────────────────────────── processo do app ────────────────────────────┐
│                                                                        │
│  Monaco ─► adapter Monaco ─► cliente LSP ─► bridge WS/stdio             │
│                                                                        │
└──────────────────────────────────────────────┬─────────────────────────┘
                                               │ LSP 3.17 público
┌──────────────────────── processo CSHTML ─────▼─────────────────────────┐
│                                                                        │
│  adapter LSP ─► portas da CshtmlEngine                                 │
│                    │                                                   │
│                    ├── documentos e snapshots                          │
│                    ├── parser Razor/HTML/C#                             │
│                    ├── projeções e source maps                          │
│                    ├── workspace e índices                              │
│                    ├── binding/semântica                                │
│                    └── lint e diagnósticos                              │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

O diagrama representa duas bordas independentes:

- o adapter Monaco converte modelos, posições, providers e markers;
- o adapter LSP converte JSON-RPC/LSP para as portas da engine.

No produto desktop, a comunicação entre eles usa o bridge já existente. Testes
da engine não iniciam Monaco, Tauri, WebSocket ou um processo LSP.

## Direção das dependências

As dependências só podem apontar para dentro:

```text
Monaco/Tauri/LSP
       │
       ▼
adapters e infraestrutura
       │
       ▼
application/ports
       │
       ▼
domain/core
```

### Camadas

| Camada | Responsabilidade | Pode depender de |
|---|---|---|
| `domain/core` | snapshots, ranges, AST estável, símbolos, diagnósticos, regras | biblioteca padrão e tipos internos |
| `application/ports` | casos de uso e interfaces para parser, filesystem, workspace e metadata | `domain/core` |
| `infrastructure` | Tree-sitter, leitura de arquivos/projetos/assemblies, caches | portas + dependências auditadas |
| `adapter/lsp` | LSP 3.17, JSON-RPC, cancelamento e conversão de DTOs | application + framework LSP |
| `adapter/monaco` | language id, providers, markers, status e disposal | Monaco + cliente de protocolo |

### Dependências proibidas no core

`CshtmlEngine`, seus tipos de domínio e suas regras não podem importar:

- Monaco ou tipos TypeScript;
- Tauri;
- JSON-RPC ou tipos LSP;
- Roslyn, `Microsoft.CodeAnalysis` ou APIs de workspace da Microsoft;
- `rzls`, métodos `_vs_*` ou `razor/*`;
- detalhes do bridge WebSocket/stdio;
- tipos concretos de uma crate de parser ou metadata.

Tree-sitter, parsers C#/HTML e leitores ECMA-335 devem ficar atrás de portas
próprias. Trocar uma dessas bibliotecas não pode alterar contratos de domínio.

## Identidades reservadas

Após a migração:

| Conceito | Identidade |
|---|---|
| Extensão MVC/Razor Pages | `.cshtml` |
| Monaco language id | `cshtml` |
| Server/process id | `fluent-cshtml` |
| Owner de markers/diagnósticos | `fluent-cshtml` |
| `Diagnostic.source` | `Fluent CSHTML` |
| Componentes Blazor | language id `razor`, lifecycle separado |

`aspnetcorerazor` é uma identidade transitória do experimento de cohosting e não
faz parte do contrato final. O server id `csharp` e o owner `dotnet-build`
continuam reservados aos respectivos pipelines existentes.

## Contratos estáveis da engine

A API concreta será definida durante a implementação, mas deve preservar estas
portas conceituais:

```rust
trait CshtmlDocuments {
    fn open(&self, document: OpenDocument) -> Result<SnapshotId, EngineError>;
    fn change(&self, change: DocumentChange) -> Result<SnapshotId, EngineError>;
    fn close(&self, document: DocumentId);
}

trait CshtmlAnalysis {
    fn diagnostics(&self, request: AnalysisRequest)
        -> Result<AnalysisResult<Vec<Diagnostic>>, EngineError>;
    fn semantic_tokens(&self, request: RangeRequest)
        -> Result<AnalysisResult<Vec<SemanticToken>>, EngineError>;
    fn completions(&self, request: PositionRequest)
        -> Result<AnalysisResult<Vec<Completion>>, EngineError>;
    fn hover(&self, request: PositionRequest)
        -> Result<AnalysisResult<Option<Hover>>, EngineError>;
    fn definition(&self, request: PositionRequest)
        -> Result<AnalysisResult<Vec<Location>>, EngineError>;
}
```

Toda requisição de análise carrega, no mínimo:

- `DocumentId`;
- versão esperada do documento;
- revisão do workspace;
- token de cancelamento;
- posição/range no modelo canônico quando aplicável.

Todo resultado carrega a identidade do snapshot usado. O adapter deve rejeitar
um resultado que não corresponda mais ao documento, workspace ou processo
atuais.

## Modelo de texto e posições

O modelo canônico da engine usa:

- texto UTF-8;
- offsets em bytes;
- ranges semiabertos `[start, end)`;
- `LineIndex` pertencente ao snapshot para conversões.

Somente adapters convertem:

| Borda | Linha/coluna |
|---|---|
| Engine | offset UTF-8 em bytes |
| LSP 3.17 | linha e `character` UTF-16, base zero |
| Monaco | linha e coluna UTF-16, base um |

Conversões devem validar limites, CRLF/LF, Unicode e surrogate pairs. Posições
inválidas retornam erro controlado; nunca são truncadas silenciosamente.

## Snapshots, concorrência e cancelamento

- Snapshots são imutáveis.
- A versão do documento cresce monotonicamente por URI.
- A revisão do workspace cresce quando imports, projetos, fontes ou metadata
  relevantes mudam.
- Cada start/restart do processo recebe uma geração de sessão.
- A identidade completa de um resultado é
  `(session, document, version, workspace_revision)`.
- Mudanças cancelam trabalhos obsoletos de forma cooperativa.
- Debounce pode reduzir trabalho, mas nunca pode ser usado para decidir se uma
  resposta ainda é válida.
- Refreshes temporizados arbitrários são proibidos.

## Lifecycle e isolamento

O serviço terá um processo por workspace, iniciado pelo `LspManager` e
registrado no `SERVER_REGISTRY`. Assim ele permanece coberto por “Resetar
Servidores de Código”.

Ordem de teardown:

1. incrementar/inutilizar a geração da sessão;
2. cancelar requests em andamento;
3. descartar providers/listeners Monaco da sessão;
4. limpar markers e diagnósticos cujo owner é `fluent-cshtml`;
5. parar o cliente;
6. parar o processo/bridge;
7. liberar caches exclusivos do workspace.

Falha ou restart de CSHTML não pode:

- parar o server id `csharp`;
- limpar markers pertencentes a outros owners;
- remover providers de outras linguagens;
- recriar a instância global do Monaco;
- alterar status/workspace de outro servidor.

## Diagnósticos

Os códigos públicos usam o prefixo `FCRZ` e quatro dígitos:

| Faixa | Categoria |
|---|---|
| `FCRZ1xxx` | sintaxe e transições Razor |
| `FCRZ2xxx` | estrutura HTML no contexto CSHTML |
| `FCRZ3xxx` | sintaxe C# projetada |
| `FCRZ4xxx` | binding e semântica |
| `FCRZ5xxx` | projeto, imports e configuração |
| `FCRZ6xxx` | Views, layouts, partials e Tag Helpers |
| `FCRZ9xxx` | capacidade indisponível/degradação controlada |

Um código publicado não pode mudar de significado nem ser reutilizado. Ranges
sempre apontam para o `.cshtml` original, nunca para texto sintético. Estado
`unknown` ou `ambiguous` não deve virar erro de símbolo inexistente.

A política normativa completa está em
[`docs/context/cshtml-language-service.md`](../context/cshtml-language-service.md).

## Dependências externas e licenças

Antes de adicionar parser, gramática ou leitor de metadata:

1. registrar projeto, versão/commit e licença SPDX;
2. confirmar compatibilidade com GPL-3.0-only;
3. piná-lo por versão ou commit reproduzível;
4. documentar se há código gerado/vendorizado;
5. executar testes do corpus contra a versão pinada;
6. esconder seus tipos atrás de uma porta do projeto.

Não serão copiados código, fixtures ou protocolos privados da Microsoft. Specs e
documentação públicas podem ser usadas como referência com atribuição.

## Migração do estado atual

A migração é incremental e cada etapa precisa ser reversível:

1. **Documentar e testar o estado atual.** Nenhum comportamento muda neste ADR.
2. **Separar identidades.** `.cshtml` passa a `cshtml`; `.razor` permanece
   separado. Somente um registry pode reivindicar cada language id.
3. **Introduzir a engine sob feature flag.** Server, markers e providers usam
   exclusivamente `fluent-cshtml`.
4. **Retirar `.cshtml` do selector Roslyn.** Isso ocorre no mesmo merge que
   ativa o novo registry, evitando janela sem serviço ou providers duplicados.
5. **Tratar diagnósticos de build.** `dotnet-build` continua representando o
   resultado de uma compilação explícita; duplicatas com diagnósticos locais
   devem ser suprimidas antes de habilitar ambos automaticamente.
6. **Remover o legado.** Só depois dos testes de não regressão podem ser
   removidos cohosting Razor, adapter/comandos `rzls` e downloads associados.

Rollback durante a migração desativa a feature flag e restaura o roteamento
anterior em um único ponto. Nunca devem existir simultaneamente dois processos
ou dois providers semânticos reivindicando `cshtml`.

## Consequências

### Positivas

- CSHTML deixa de depender de protocolos privados e do release cadence da
  Microsoft.
- Parser, linter e semântica podem ser testados sem UI.
- Falhas de CSHTML ficam isoladas do C#.
- Monaco e LSP tornam-se adapters substituíveis.

### Custos

- O projeto passa a manter parser Razor, source maps e um modelo semântico C#
  limitado.
- Paridade com Visual Studio não é objetivo imediato.
- MSBuild, source generators, analyzers e resolução C# completa continuarão fora
  do escopo até haver contratos e testes específicos.

## Alternativas rejeitadas

### Continuar com cohosting no Roslyn

Rejeitada porque mantém CSHTML acoplado ao processo C#, exige uma extensão
específica e não fornece uma abstração pública controlada pelo projeto.

### Integrar `rzls` e reproduzir o cliente do VS Code

Rejeitada porque depende de projeções e métodos privados/customizados, além de
manter o projeto subordinado ao empacotamento da Microsoft.

### Implementar análise no frontend TypeScript

Rejeitada porque colocaria parsing/indexação no processo de UI e dificultaria
isolamento, concorrência, testes e reuso via LSP.
