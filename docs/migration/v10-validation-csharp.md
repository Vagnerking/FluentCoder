# Validação manual — Contrato C#/Roslyn após migração `monaco-languageclient` v10 (issue #77)

> Branch: `feat/monaco-v10-migration` (worktree `CodeEditor-v10-integration`).
> Complementa a validação **automatizada** (testes unitários + verificação
> estática do código) com os passos que só podem ser executados com o app real
> (`tauri build` + dev) aberto sobre um workspace `.sln`.
>
> Pré-requisito de build: usar `tauri build`/`tauri dev`, **não** `cargo build`
> (senão o WebView abre em localhost recusado — ver memória do projeto).

## Onde observar os sinais

- **Logs LSP**: `src/lsp/debug.ts` envia tudo com o prefixo `[lsp]` para
  - o **console do WebView** (DevTools → Console), e
  - o painel inferior **"Saída" → canal "LSP"**.
  Abrir os dois; o filtro `[lsp]` isola o tráfego do language client.
- **API Monaco no DevTools**: no Console do WebView, inspecionar via
  `monaco.editor.getModels()`, `monaco.editor.getModelMarkers({})`,
  `monaco.languages.getLanguages()`. (O objeto `monaco` é a instância única
  `@codingame/monaco-vscode-editor-api`.)
- **Requests LSP brutos** (`_vs_getProjectContexts` etc.): usar o Console do
  WebView com `client.sendRequest(...)` se houver handle exposto, ou inspecionar
  a resposta nos logs `[lsp]` correspondentes.

---

## Pré-checagem crítica (risco §4 — instância única do Monaco)

> Se isto falhar, **todos** os demais itens falham silenciosamente. É o maior
> risco da migração v10 (o `monaco-editor` agora é o build `@codingame`, e o
> editor é montado via `@monaco-editor/react` apontado por `loader.config`).

1. **Editor monta após `whenMonacoReady`.**
   - Ação: abrir uma pasta qualquer e abrir um arquivo.
   - Esperado: o placeholder "Carregando editor…" some e o editor aparece.
   - Observar: log `[lsp] @codingame/monaco-vscode-api services initialized`
     (de `vscodeServices.ts`) deve aparecer **uma única vez**.

2. **`getModels()` não vazio (a checagem de instância única).**
   - Ação: com um `.cs` aberto, no Console do WebView rodar
     `monaco.editor.getModels().map(m => ({lang: m.getLanguageId(), uri: m.uri.toString()}))`.
   - Esperado: array **não vazio**, com pelo menos um modelo `csharp` e URI
     `file:///c:/...`.
   - Observar também o log `[lsp] models at start: [...]` (`client.ts`): deve
     listar o(s) modelo(s) com `scheme: "file"`, `lang: "csharp"`. **Vazio aqui =
     duas instâncias do Monaco = sem `didOpen` = sem IntelliSense.**

---

## Inicialização Roslyn (critérios #77 passos 1–4)

3. **Abrir solution com múltiplos projetos.**
   - Ação: abrir uma pasta contendo `.sln` + 2+ `.csproj`; abrir um `.cs` de um
     dos projetos.
   - Esperado/observar (logs `[lsp]`, na ordem):
     - `openRoslynWorkspace: encontrados {slns, csprojs}`
     - `openRoslynWorkspace: enviando solution/open <uri>` seguido de
       `openRoslynWorkspace: solution/open ENVIADO`
       (se não houver `.sln`: `project/open ENVIADO`).
   - A URI no `solution/open` deve ser `file:///c:/...` (nunca `file:///c%3A/...`).

4. **`projectInitializationComplete` chega.**
   - Esperado: log `[lsp] Roslyn project initialization COMPLETE csharp <rootPath>`.
   - Sem este log, os tokens semânticos permanecem desligados (deferidos) para
     sempre — qualquer item de cor abaixo falhará.

5. **Rebind `didClose`/`didOpen` após a init.**
   - Esperado: um ou mais logs `[lsp] Roslyn document rebound after project load <uri>`,
     **depois** do log de `projectInitializationComplete`. Confirma a ordem
     obrigatória do `editor.md` (rebind acontece pós-init, não por timeout).

6. **Contexto de projeto correto (não Miscellaneous).**
   - Ação: emitir `textDocument/_vs_getProjectContexts` para a URI do `.cs`
     aberto (via Console/handle do client).
   - Esperado: retorna o **projeto correto** da solution e
     `_vs_is_miscellaneous: false`.
   - Se vier `true`/`Miscellaneous Files`: investigar URI (formato `file:///c:/...`),
     `solution/open` e o rebind (passos 3–5).

---

## Tokens semânticos (critérios #77 passos 5–6 — risco ALTO)

> Verifica que existe **um único** provider (a bridge manual) e que a feature
> nativa do v10 está desligada — caso contrário a corrida provisório→definitivo
> volta e tipos regridem para `variable`.
>
> **⚠️ Pré-condição (estado atual da stack v10):** o semantic highlighting está
> DESLIGADO por padrão (`'semanticHighlighting.enabled': false` em `EditorPane`),
> porque o caminho de tema standalone não resolve as cores de semantic token (ver
> ADR 0003 e o comentário em `EditorPane`/`vscodeServices.ts`). Assim, os passos
> 8–9 abaixo (classificação fina struct/enum/class) só se aplicam DEPOIS do
> follow-up que reativa o semantic highlighting pelo caminho de tema completo do
> VS Code. Enquanto isso, a coloração de C# vem do Monarch (passo 10) e o passo 7
> (provider único / feature nativa desligada) continua valendo, pois a bridge
> permanece registrada para quando o highlighting voltar.

7. **Apenas um provider responde por `csharp`.**
   - Observar no log: `[lsp] native feature disabled (bridge owns it) csharp textDocument/semanticTokens`
     (de `nativeFeatures.ts`) **e** `[lsp] semantic tokens bridge registered for csharp {...}`.
   - Durante o uso, os logs `[lsp] provideDocumentSemanticTokens csharp ...`
     devem vir **somente da bridge** (uma origem). Não deve haver tokens pintados
     por um provider nativo concorrente.

8. **Classificação final correta.**
   - Ação: abrir um `.cs` que use `DateTime`, um enum do projeto
     (ex.: `StatusTituloEnum`), uma classe base (ex.: `AggregateRoot`) e
     `if`/`return`.
   - Esperado (cores do tema `fluent-acrylic-dark` em `EditorPane.tsx`):
     - `DateTime` → **struct** (verde claro `#86C691`)
     - enum do projeto → **enum** (`#B8D7A3`)
     - classe base → **class** (azul-petróleo `#4EC9B0`)
     - `if` / `return` → **controlKeyword** (roxo `#C586C0`)
   - Observar: log `[lsp] semantic token samples csharp [...]` mostrando
     `DateTime` com `type: "struct"`, o enum com `type: "enum"`, etc.

9. **Sem regressão para `variable` após refresh.**
   - Ação: aguardar **pelo menos mais um refresh** do Roslyn (a bridge tem o
     backoff `stabilizeSemanticTokens` com delays 250/600/1200/2400/4000 ms);
     opcionalmente trocar de aba e voltar.
   - Esperado: as cores do passo 8 **permanecem** — `DateTime` não vira azul de
     variável, enum/classe não viram `variable`.
   - Observar: nos logs `semantic token samples` subsequentes, os mesmos símbolos
     mantêm `struct`/`enum`/`class`. Se viram `variable`, há provider duplicado
     ou resposta antiga sobrescrevendo (quebra de contrato `editor.md`).

10. **[fallback léxico do C#] Coloração de keyword ANTES (e independente) dos
    tokens semânticos.**
    > **Contexto da migração (RESOLVIDO na implementação):** o build
    > `@codingame/monaco-vscode-editor-api` mapeia `./esm/vs/basic-languages/*`
    > para `./empty.js` (`export {}`), então a contribution C# embutida do Monaco
    > virou no-op na v10. Por isso `monacoSetup.ts` registra um Monarch C#
    > explícito — `setMonarchTokensProvider("csharp", csharpMonarch())`
    > (`ensureCsharpMonarchFallback`) — para repor a camada léxica. **Além disso,
    > na stack v10 o semantic highlighting do Roslyn está DESLIGADO**
    > (`'semanticHighlighting.enabled': false`, ver `EditorPane`), então a
    > coloração de C# vem inteiramente do Monarch — este passo valida exatamente
    > essa camada.
    - Ação: abrir um `.cs` e observar **no primeiro instante**, antes de
      `projectInitializationComplete` (ou com o servidor Roslyn desconectado): as
      palavras-chave `if`, `return`, `public`, `class` etc.
    - **Esperado:** keywords já coloridas IMEDIATAMENTE pelo Monarch (não
      dependem do Roslyn). Strings, char literals, números e comentários também.
    - **Anotar o resultado.** Se as keywords ficarem sem cor (texto plano), o
      Monarch C# de `monacoSetup.ts` não registrou — regressão da camada léxica
      esperada pelo `editor.md` §"tokens léxicos e semânticos". Como o semantic
      highlighting está off (ver nota da seção anterior), a cor de keywords/
      tipos/strings deve PERMANECER a do Monarch o tempo todo — não há mais um
      passo semântico que a substitua.

---

## Navegação cross-file (critério #77 passo 7 — risco MÉDIO)

11. **Ctrl+Click em tipo de outro arquivo.**
    - Ação: Ctrl+Click (ou F12) sobre um tipo definido em **outro** `.cs`.
    - Esperado: abre a aba do arquivo de destino na posição correta.
    - Observar: o `registerEditorOpener` (`EditorPane.tsx`) trata o salto
      cross-file (retorna `true`); saltos no mesmo arquivo retornam `false` e o
      Monaco revela a posição. Risco v10: a stack `@codingame` tem serviço de
      editor próprio — como **não** habilitamos o `editor-service-override`
      (ver `vscodeServices.ts`), o opener custom deve continuar valendo.
      Confirmar que a aba certa abre.

---

## Diagnósticos (critério #77 passo 8 — risco ALTO)

12. **Squiggles aparecem e somem ao corrigir.**
    - Ação: introduzir um erro de compilação (ex.: tipo inexistente); salvar/editar.
    - Esperado: squiggle vermelho + linha no painel **Problemas**; ao corrigir,
      ambos somem.

13. **Marcadores únicos (sem duplicação).**
    - Ação: com o erro presente, no Console do WebView rodar
      `monaco.editor.getModelMarkers({ resource: monaco.editor.getModels().find(m=>m.getLanguageId()==="csharp").uri })`.
    - Esperado: **um** marcador por diagnóstico (sem pares duplicados).
    - Observar: log `[lsp] native feature disabled (bridge owns it) csharp textDocument/diagnostic`
      garante que só a bridge manual (pull, owner `csharp`) escreve marcadores. Se
      houver marcadores duplicados, a feature `DiagnosticFeature` nativa do v10
      escapou da neutralização.

14. **Pull, não build automático.**
    - Esperado: nenhum log de `dotnet build` disparado ao abrir/salvar; os
      diagnósticos vêm via `textDocument/diagnostic` (identifiers `syntax` e
      `DocumentCompilerSemantic`).

---

## Tema semântico (risco MÉDIO)

15. **As cores semânticas realmente aplicam no stack v10.**
    - Ação: confirmar visualmente as cores do passo 8.
    - Observar: o app **não** habilitou os serviços de theme/textmate do VS Code
      (`vscodeServices.ts` mantém o caminho standalone), então o
      `monaco.editor.defineTheme("fluent-acrylic-dark", ...)` +
      `"semanticHighlighting.enabled": true` (`EditorPane.tsx`) devem continuar
      governando as cores.
    - Diagnóstico de falha: se o log `semantic token samples` mostra `type:
      "class"`/`"enum"`/`"struct"` corretos **mas** a cor na tela é o foreground
      default, o tema semântico não está aplicando → investigar o caminho de
      tema na stack v10 (não as categorias do Roslyn).

---

## Lifecycle / "Resetar Servidores de Código" (risco ALTO)

16. **Reset não vaza providers/marcadores.**
    - Ação: rodar "Resetar Servidores de Código" pela Paleta de Comandos 3–5
      vezes seguidas; reabrir o `.cs`.
    - Esperado: cada reset reinicia o C# limpo; cores e diagnósticos voltam a
      funcionar; **nenhuma** duplicação de marcadores ou de tokens piscando.
    - Observar: `disposeLanguageClientContributions` (`client.ts`/`manager.ts`)
      descarta os providers da bridge a cada stop; a contagem de marcadores
      (`getModelMarkers`) não cresce a cada ciclo.

---

## Resumo de aceite #77

| # | Critério | Como confirmar |
|---|---|---|
| 1–2 | Instância única / `getModels()` não vazio | `monaco.editor.getModels()`, log `models at start` |
| 3–4 | `solution/open` + `projectInitializationComplete` | logs `[lsp]` |
| 5 | Rebind `didClose`/`didOpen` pós-init | log `Roslyn document rebound after project load` |
| 6 | `_vs_getProjectContexts` projeto certo, `_vs_is_miscellaneous:false` | request LSP |
| 7 | Um único provider de semantic tokens | logs `native feature disabled` + `bridge registered` |
| 8 | `DateTime`=struct, enum=enum, classe=class, `if`/`return`=controlKeyword | log `semantic token samples` + cores |
| 9 | Sem regressão para `variable` após refresh | observar após o backoff de stabilize |
| 10 | (CONCERN) fallback léxico de keyword C# | observar pré-Roslyn; **provavelmente quebrado** |
| 11 | Ctrl+Click cross-file | abre aba destino |
| 12–14 | Diagnósticos únicos, squiggle some ao corrigir | `getModelMarkers`, painel Problemas |
| 15 | Cores semânticas aplicam no stack v10 | comparar categoria no log vs cor na tela |
| 16 | Reset sem vazamento | repetir reset, contar marcadores/providers |
