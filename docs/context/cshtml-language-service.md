# CSHTML — contratos de integração

> ⚠️ **Direção atualizada por [ADR 0002](../adr/0002-cshtml-projection-roslyn.md) (23/06/2026):** a semântica `.cshtml` vem da **projeção C# + Roslyn padrão** (não do motor homegrown sem Roslyn). Mudança em relação a este documento: o **Roslyn e o compilador Razor do SDK são permitidos** para a semântica (eram proibidos); os métodos privados de cohost `razor/*`/`_vs_*` e o serviço OOP do cohost **continuam proibidos**. **Mantêm-se** as identidades reservadas: id Monaco `cshtml` e owner de markers/diagnósticos `fluent-cshtml` para `.cshtml` (agora servidos pelo broker de projeção). O id `aspnetcorerazor` era transitório do experimento de cohosting e foi **aposentado** para `.cshtml`. As demais regras abaixo (ranges sempre no `.cshtml`, ownership de markers, lifecycle/reset, dedup com `dotnet-build`, separação `.cshtml`×`.razor`) **continuam normativas**.
>
> ⚠️ **Estado atual (Fase E concluída):** o **motor homegrown foi REMOVIDO** — não existem mais o binário `fluent-cshtml-lsp`, o `lsp/fluent_cshtml.rs`, o command `lsp_ensure_fluent_cshtml_server`, o adapter `src/lsp/servers/cshtml.ts` nem a biblioteca Rust `src-tauri/src/cshtml/`. As seções abaixo que descrevem **arquivos** desse motor são **históricas**. O serviço `.cshtml` é hoje: broker Rust `src-tauri/src/razor/` + cliente `src/lsp/servers/razorProjection.ts` (semântica C#), mais `src/lsp/servers/cshtmlHtmlProjection.ts` + `cshtmlHtmlService.ts` (IntelliSense de HTML nas regiões HTML, via `vscode-html-languageservice` in-process — **Fase C**). O owner `fluent-cshtml` permanece como nome do owner de diagnósticos, **não** como servidor.

Este documento é normativo para qualquer alteração relacionada a `.cshtml`.
Leia também:

- [ADR 0001 — Language service CSHTML independente](../adr/0001-cshtml-language-service.md);
- [contratos gerais do editor](editor.md);
- [Paleta de Comandos](command-palette.md);
- [matriz de funcionalidades CSHTML](../roadmap/cshtml-language-service.md).

## Escopo e separação de linguagens

- `.cshtml` representa Views MVC e Razor Pages.
- `.razor` representa componentes Blazor.
- As duas extensões têm language ids, providers, processos e evolução
  independentes.
- O contrato final de `.cshtml` usa language id `cshtml`.
- O serviço usa server/process id e marker owner `fluent-cshtml`.
- O pipeline C# continua usando `csharp`; CSHTML não pode ser adicionado ao
  selector do Roslyn.

O id transitório `aspnetcorerazor` não deve ser usado em código novo.

## Limites de módulos

Estrutura implementada (estado atual da milestone #1):

```text
src-tauri/src/cshtml/
├── ast.rs          # nós da AST: NodeKind, Node, ParseTree
├── binding.rs      # binding @model/@inject/escopos → BindingContext
├── document.rs     # DocumentStore, Snapshot, StoreError
├── engine.rs       # CshtmlEngine — API pública incremental
├── hardening.rs    # CancelToken, BoundedCache, DiagMetrics, WorkspaceSession
├── harness.rs      # corpus de conformidade e golden tests
├── intellisense.rs # completion, hover, definition, semantic tokens
├── lint.rs         # CshtmlLinter, regras FCRZ0001–0009, DiagnosticProvider
├── metadata.rs     # leitor ECMA-335 sem Roslyn, MetadataCache
├── mod.rs
├── parser.rs       # parser Razor incremental com recuperação de erro
├── projection.rs   # projeção HTML/C# e source maps
├── semantics.rs    # SymbolIndex, parse_csharp_symbols
├── types.rs        # Snapshot, TextRange, TextPosition, DiagnosticKind
├── views.rs        # ViewGraph, TagHelperIndex, validate_sections
└── workspace.rs    # ProjectContext, DocumentContext, WorkspaceCache

src-tauri/src/bin/
└── fluent_cshtml_lsp.rs  # servidor LSP 3.17 stdio (processo isolado)

src-tauri/src/lsp/
└── fluent_cshtml.rs      # resolve_launch() para o binário CSHTML

src/lsp/servers/
└── cshtml.ts             # startCshtmlServer(), CSHTML_SERVER_ID
```

Os nomes podem mudar, mas a direção de dependência definida no ADR não pode.

Regras:

- parser/linter não acessam Monaco;
- parser/linter não acessam filesystem diretamente;
- adapters não implementam regras de linguagem;
- infraestrutura implementa portas do core/application;
- nenhum tipo Tree-sitter/ECMA-335 atravessa a porta da engine;
- módulos CSHTML não importam `src/lsp/servers/csharp.ts`.

## Contrato de documentos

Cada documento aberto possui:

- URI canônica;
- `DocumentId` estável durante a sessão;
- versão monotônica;
- conteúdo UTF-8;
- `LineIndex`;
- snapshot imutável;
- revisão do workspace usada na análise.

### Open

- Um `didOpen` cria a versão informada pelo cliente.
- Abrir novamente a mesma URI substitui a sessão anterior somente depois de
  invalidar requests antigos.

### Change

- Changes são aplicadas na ordem recebida.
- Versão igual ou menor que a atual é rejeitada.
- Se um edit incremental não puder ser validado, o adapter solicita/sincroniza
  o texto completo; não tenta reparar offsets silenciosamente.

### Close

- Cancela análises do documento.
- Remove estado transitório e markers daquele documento/owner.
- Índices de workspace podem manter símbolos de arquivos fechados, mas nunca
  conteúdo não salvo como se estivesse persistido.

## Posições e ranges

No core:

- offset UTF-8 em bytes;
- range semiaberto `[start, end)`;
- ranges sempre pertencem a um snapshot específico.

Nas bordas:

- LSP: base zero e unidades UTF-16;
- Monaco: base um e unidades UTF-16.

Toda conversão deve:

1. usar o `LineIndex` do mesmo snapshot;
2. validar início, fim e ordenação;
3. preservar CRLF/LF;
4. tratar surrogate pairs;
5. falhar de forma explícita quando não for possível mapear.

Source maps de projeções devem marcar trechos sintéticos. Resultados originados
exclusivamente em texto sintético não podem virar marker ou `TextEdit`.

## Versionamento, cancelamento e respostas obsoletas

Uma resposta só é aplicável quando todos os campos ainda coincidem:

```text
session_generation
document_id
document_version
workspace_revision
```

Regras obrigatórias:

- cada request é cancelável;
- abrir uma request mais nova para a mesma feature/documento invalida a anterior
  quando os resultados competem;
- alteração de documento invalida resultados da versão anterior;
- alteração de imports/projeto/metadata invalida resultados da revisão anterior;
- restart invalida toda resposta da geração anterior;
- checar cancelamento antes e depois de etapas caras;
- checar a identidade novamente imediatamente antes de publicar/aplicar;
- debounce serve apenas para agendamento;
- timeouts ou refreshes periódicos não podem ser usados como mecanismo de
  consistência.

## Lifecycle, registry e reset

O serviço deve:

1. estar registrado no `SERVER_REGISTRY` para o language id `cshtml`;
2. ser iniciado e parado pelo `LspManager`;
3. usar um único processo `fluent-cshtml` por workspace;
4. participar automaticamente de “Resetar Servidores de Código”;
5. ser idempotente durante React StrictMode;
6. não reiniciar em cada keystroke;
7. limpar recursos na troca/fechamento do workspace.

Se algum componente CSHTML for iniciado fora do `LspManager`, ele deverá
implementar explicitamente o contrato de reset descrito em
[`command-palette.md`](command-palette.md). A preferência é não criar esse
caminho paralelo.

### Ordem de disposal

1. invalidar geração;
2. cancelar requests;
3. dispose de providers/listeners;
4. limpar markers e store de `fluent-cshtml`;
5. parar cliente;
6. parar processo/bridge;
7. liberar caches do workspace.

O disposal deve ser seguro quando executado mais de uma vez.

## Ownership

| Recurso | Owner/id |
|---|---|
| Processo/cliente CSHTML | `fluent-cshtml` |
| Markers locais CSHTML | `fluent-cshtml` |
| Diagnósticos no store | `fluent-cshtml` |
| Diagnósticos de compilação | `dotnet-build` |
| Processo/markers C# | `csharp` |

Um owner só pode limpar recursos que criou. É proibido usar
`setModelMarkers(model, ownerDeOutroServidor, [])` ou limpar todo o store como
efeito colateral de parar apenas CSHTML.

Todos os providers registrados pela sessão devem ser guardados em um conjunto
de `IDisposable` exclusivo e descartados antes de registrar substitutos.

## Política de diagnósticos

### Identidade

- Prefixo: `FCRZ`.
- Formato público: `FCRZ` + quatro dígitos.
- Source apresentada ao usuário: `Fluent CSHTML`.
- Owner técnico: `fluent-cshtml`.

### Faixas

| Faixa | Uso |
|---|---|
| `FCRZ1000–1999` | parser/transições/diretivas Razor |
| `FCRZ2000–2999` | HTML no contexto CSHTML |
| `FCRZ3000–3999` | sintaxe C# projetada |
| `FCRZ4000–4999` | binding, tipos e membros |
| `FCRZ5000–5999` | workspace, projeto e imports |
| `FCRZ6000–6999` | Views, layouts, partials e Tag Helpers |
| `FCRZ9000–9999` | análise degradada/capacidade indisponível |

### Registro de códigos

Quando o primeiro diagnóstico for implementado, deve existir um registro
versionado contendo para cada código:

- título e mensagem;
- categoria;
- severidade padrão;
- condições de emissão e supressão;
- exemplo inválido e válido;
- versão em que foi introduzido.

Depois de publicado:

- um código não muda de significado;
- um código removido não é reutilizado;
- mudança incompatível exige novo código;
- mensagem pode melhorar sem alterar a condição semântica.

### Qualidade

- Range aponta para o `.cshtml` original.
- Erros sintáticos devem preferir o menor range acionável.
- Diagnóstico explica problema e próximo passo quando conhecido.
- `unknown`, projeto não carregado ou resolução ambígua não são tratados como
  “símbolo inexistente”.
- Falha interna da engine é log/status, não uma cascata de markers no documento.
- Corrigir/fechar o documento limpa o diagnóstico sem restart.

### Build versus análise local

`dotnet-build` representa o compilador após uma ação de build. Ele não pertence
à engine CSHTML.

Antes de habilitar build e análise local automaticamente ao mesmo tempo, a
integração deve evitar linhas duplicadas no painel Problemas. A chave mínima de
deduplicação é URI, range, severidade e código; quando não houver código
compatível, os owners permanecem visíveis separadamente.

## Providers Monaco

Providers CSHTML devem usar selector restrito ao language id `cshtml`.

Obrigatório:

- registrar na instância compartilhada de `src/monaco-loader.ts`;
- retornar `null`/vazio quando snapshot ou versão não forem mais atuais;
- respeitar `CancellationToken`;
- guardar todos os disposables;
- não registrar providers para `csharp`, `razor` ou `aspnetcorerazor`;
- não modificar os bridges semânticos/diagnósticos específicos de Roslyn;
- não aplicar `TextEdit` cujo source map inclua trecho sintético não editável.

## Adapter LSP

O adapter pode usar apenas LSP 3.17 público para funcionalidades do produto.
Capabilities customizadas futuras precisam de ADR separado e não podem ser
necessárias para o Monaco funcionar.

O adapter é responsável por:

- converter DTOs e posições;
- sincronizar documentos;
- propagar cancelamento;
- anunciar somente capabilities implementadas;
- converter erros internos em respostas controladas;
- não expor detalhes do parser/metadata.

## Migração sem providers duplicados

Checklist obrigatório para a issue que ativar a engine:

- [ ] `.cshtml` mapeado somente para `cshtml`.
- [ ] `.razor` não usa o mesmo language id.
- [ ] `SERVER_REGISTRY["cshtml"]` aponta somente para `fluent-cshtml`.
- [ ] selector do cliente Roslyn contém somente C#.
- [ ] adapter legado `rzls` não é inicializado.
- [ ] somente um provider por feature reivindica `cshtml`.
- [ ] markers antigos de `csharp`/`razor` para modelos `.cshtml` são limpos uma
      vez durante a migração.
- [ ] restart, StrictMode e troca de workspace não aumentam a contagem de
      providers/listeners.
- [ ] rollback é possível por um único feature flag/ponto de registry.

O código de cohosting e `rzls` só deve ser removido depois que esse checklist e
os testes de não regressão estiverem verdes.

## Dependências de terceiros

Todo parser, gramática ou leitor de metadata deve:

- ter licença compatível registrada;
- ser pinado;
- ficar atrás de interface própria;
- passar pelo corpus de conformidade;
- não executar assemblies do usuário;
- não introduzir código/protocolo privado da Microsoft.

## Critérios de não regressão

Antes de integrar mudanças CSHTML:

- executar testes unitários;
- executar os critérios C#/Roslyn de [`editor.md`](editor.md) quando houver
  qualquer alteração em registry, Monaco ou lifecycle LSP;
- confirmar que TypeScript/JavaScript continuam com um único provider;
- confirmar que `.razor` não foi capturado pelo serviço `.cshtml`;
- confirmar reset e troca de workspace;
- confirmar que a instância Monaco continua única.
