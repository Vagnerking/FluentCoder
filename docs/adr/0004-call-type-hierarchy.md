# ADR 0004 — Call Hierarchy e Type Hierarchy para C# (`.cs`)

- **Status:** aceito
- **Data:** 09/07/2026
- **Milestone/issue:** #6 (C# Dev Kit parity — Call/Type hierarchy)
- **Evidência:** probe empírico contra o Roslyn standalone 5.0.0-1.25277.114
  (osx-arm64) — ver "Contexto" abaixo.

## Contexto

O C# Dev Kit oferece **Call Hierarchy** ("quem chama este método / o que ele
chama") e **Type Hierarchy** ("supertipos / subtipos de um tipo"). O FluentCoder
serve `.cs` pelo **Roslyn standalone** (`Microsoft.CodeAnalysis.LanguageServer`),
cujas features nativas o `monaco-languageclient` auto-registra a partir das
capabilities do `initialize`.

### Fato empírico decisivo

Um probe (projeto com hierarquia real: `interface IShape` → `abstract Base` →
`Circle`, e `Main` chamando `Describe`) contra o binário Roslyn que o app usa
mostrou:

| Capability / request | Resultado |
|---|---|
| `callHierarchyProvider` anunciado no `initialize` | **não** |
| `typeHierarchyProvider` anunciado no `initialize` | **não** |
| `textDocument/prepareCallHierarchy` | **`-32601` method not found** |
| `textDocument/prepareTypeHierarchy` | **`-32601` method not found** |

Ou seja: diferente dos diagnostics (que o Roslyn **aceita** via
`textDocument/diagnostic` mesmo sem anunciar `diagnosticProvider` — ver
`editor.md`), aqui os endpoints de hierarquia **não existem** neste build. Não há
como "ligar" a feature nativa: o servidor não a implementa.

O que o Roslyn standalone **anuncia e responde** (confirmado na milestone #5):
`definition`, `typeDefinition`, `implementation`, `references`, `documentSymbol`,
`workspace/symbol`, `hover`.

## Decisão

**Implementar Call/Type Hierarchy no cliente ("client-side"), derivando das
capabilities que o Roslyn ANUNCIA**, em vez de trocar de servidor. Os providers
Monaco (`registerTypeHierarchyProvider`, `registerCallHierarchyProvider`) são
alimentados por composição dos requests padrão:

### Type Hierarchy
- **prepare**: `textDocument/documentSymbol` (ou o símbolo sob o cursor) para
  identificar o tipo alvo.
- **supertypes**: `textDocument/definition` no cabeçalho do tipo → o Roslyn
  navega para a base/interface; ampliado por `hover` (a assinatura mostra
  `: Base, IShape`) parseada para nomes de supertipos, resolvidos por
  `workspace/symbol`.
- **subtypes**: `textDocument/implementation` no tipo → dá as implementações /
  classes derivadas diretas.

### Call Hierarchy
- **prepare**: símbolo do método sob o cursor.
- **incoming calls** ("quem me chama"): `textDocument/references` no método,
  filtrando as ocorrências que são de fato chamadas (heurística: o token é
  seguido de `(`, ou está num contexto de invocação). Cada referência é
  agrupada pelo método que a contém (resolvido por `documentSymbol` do arquivo
  da referência).
- **outgoing calls** ("o que eu chamo"): analisar o corpo do método (via
  `documentSymbol` para o range + scan de identificadores seguidos de `(`),
  resolvendo cada alvo por `definition`.

### Escopo e limitações aceitas (documentadas na UI/ADR)
- É uma **aproximação**, não a análise semântica completa do Roslyn: `references`
  não distingue com 100% de precisão "chamada" de "menção" (ex.: method group
  passado como delegate), e o scan de outgoing calls é textual dentro do range do
  método. Falsos positivos/negativos raros são aceitáveis para navegação.
- **supertypes/subtypes** cobrem os diretos com alta confiança
  (`definition`/`implementation` do Roslyn); a árvore transitiva é montada por
  expansão sob demanda (o usuário expande cada nó).

## Alternativas rejeitadas

- **A. Trocar/adicionar servidor (cohost / C# Dev Kit).** O cohost está
  **bloqueado headless** (ADR 0002 / `FINDINGS-fase0.md`: o source generator não
  roda no OOP). O componente que dá hierarquia no VS Code é o **C# Dev Kit**, que
  é **proprietário** e licenciado só para VS/VS Code — não podemos redistribuir.
  Inviável.
- **B. Capability custom no Roslyn** (`_vs_*`). Proibido pelos contratos (só LSP
  3.17 público); e exigiria um servidor diferente de qualquer forma.
- **C. Não fazer.** Deixa um gap visível vs o Dev Kit sem necessidade — a
  composição client-side entrega a navegação essencial.

## Nota de API (superfície de registro)

O `monaco.languages` **standalone não expõe** `registerCallHierarchyProvider`/
`registerTypeHierarchyProvider` (são internos ao extension host do VS Code).
Porém, na stack v10 (`@codingame/monaco-vscode-api`), o módulo **`vscode`** (que
o próprio `monaco-vscode-api` registra) expõe `vscode.languages.register{Call,
Type}HierarchyProvider`. Portanto os providers são registrados via `import * as
vscode from "vscode"` — a primeira vez que o app usa a API `vscode` diretamente
(até então só o cliente LSP a usava internamente). Os `CallHierarchyProvider`/
`TypeHierarchyProvider` operam com tipos `vscode` (`TextDocument`/`Position`/
`Location`), então há uma fina camada de conversão. A **lógica de composição**
(agrupar referências por método, parsear supertipos, heurística de chamada) fica
em módulos puros testáveis; o wiring `vscode` é fino e sem lógica.

## Consequências

- **Positivas:** navegação de hierarquia funciona sem trocar o servidor nem
  código proprietário; reusa requests já testados (definition/implementation/
  references/documentSymbol). Providers Monaco padrão → UI nativa (peek/tree).
- **Negativas:** precisão inferior à do Dev Kit em casos de borda; mais round-
  trips LSP por expansão (mitigado por lazy expand + a rapidez do Roslyn local).
- **Rollback:** os providers são registrados por trás dos bridges do cliente C#
  (entram no reset de servidores); remover = não registrar. Sem impacto no resto.

## Validação

- Probe de aceite: contra o Roslyn real, confirmar que `definition` no tipo dá o
  supertipo, `implementation` dá os subtipos, e `references` no método dá os
  chamadores — as primitivas da composição.
- Testes unitários da lógica pura (agrupamento de referências por método
  container; parse de supertipos do hover; heurística de "é chamada").
