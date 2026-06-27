# Validação dos servidores não-Roslyn após a migração `monaco-languageclient` v10 (issue #79)

> Regressão dos language servers **não-Roslyn** (TypeScript/JavaScript, JSON/NPM,
> system) após a migração `monaco-languageclient` 1.1.0 → 10.7.0
> (branch `feat/monaco-v10-migration`, worktree `CodeEditor-v10-integration`).
>
> Critérios de aceite: [`monaco-v10-audit.md` §5](monaco-v10-audit.md) (TS/JS e
> JSON/NPM) e §4 (matriz de riscos). Rotina de reset obrigatória:
> [`command-palette.md`](../context/command-palette.md) ("Resetar Servidores de
> Código").
>
> Este documento separa a validação em **automatizada/estática** (já feita) e
> **manual/runtime** (checklist abaixo, exige o app real via `tauri build` +
> `tauri-driver`, conforme a memória de E2E do projeto).

---

## 1. Resultado automatizado/estático

### 1.1 `npm run test:unit`

`191 pass / 0 fail` (191 testes, ~440 ms). Nenhum teste falhou.

**Cobertura relevante a #79:** os arquivos de teste atuais NÃO incluem testes
específicos de TS/JS, npm, system ou do `SERVER_REGISTRY`. Os testes LSP
existentes cobrem: `diagnosticMode.test.ts` (push vs pull), `uri.test.ts`
(serialização Windows), `csharpConfiguration.test.ts`, `cshtmlHtmlProjection.test.ts`,
`razorProjectionRouting.test.ts`. Portanto, a verificação dos servidores
não-Roslyn é **estrutural** (leitura do código) + **manual** (checklist §2);
não há regressão automatizada que prove startup/shutdown desses servidores.

### 1.2 Checks estáticos (PASS/FAIL/UNCERTAIN com evidência)

| # | Check | Veredito | Evidência |
|---|---|---|---|
| 1 | Todo server no `SERVER_REGISTRY` tem starter que passa por `createLanguageClient` e inicia ou falha controladamente (sem crash "unsupported") | **PASS** | `servers/index.ts:48-109` monta o registry; `typescript.ts:67` (`startTypescriptServer` → `createLanguageClient`), `npm.ts:38` (`makeNpmServerStarter` → `createLanguageClient`), `system.ts:35` (`makeSystemServerStarter` → `createLanguageClient`), `csharp.ts` e `razorProjection.ts:159+`. Todos chamam `createLanguageClient`. O `client.start()` é envolto em try/catch (`client.ts:159-172`) que loga stack e relança; o erro sobe pelo `manager.start` (`manager.ts:75-80`) e vira status `error` na UI (`useLspManager.ts:85-87`) — sem crash não tratado. A causa histórica do "unsupported" (shim 1.x) foi removida: `nativeFeatures.ts` só faz no-op das features nativas e nunca lança (`nativeFeatures.ts:88-92`, `catch` que retorna false). |
| 2 | `disableBuiltinTsWorker` ainda desliga o worker TS embutido / leitura sobre o no-op defensivo | **PASS (com ressalva — ver §1.3)** | `monacoSetup.ts:127-152`. Lê `monaco.languages.typescript` via cast; `if (!ts) return` (`:130`). Quando presente, desliga diagnostics (`:137-138`), `setEagerModelSync(false)` (`:142-143`) e zera extraLibs (`:150-151`). Na build `@codingame` o objeto `typescript` não é empacotado → o guard torna a função no-op. |
| 3 | Push diagnostics (TS/JS/npm/system) passam pela bridge manual COM a feature nativa de diagnostics desabilitada → sem markers duplicados | **PASS** | `client.ts:152-156`: para todo client sem `suppressGenericBridges`, `disableNativeClientFeature(... "textDocument/diagnostic")` roda ANTES do `start()`. `diagnostics.ts:190-201` instala o listener `textDocument/publishDiagnostics` → `recordDiagnostics` → `monaco.editor.setModelMarkers(model, serverId, ...)` (owner = serverId, `diagnostics.ts:148`). Como TS/JS/npm/system não passam `diagnosticMode`, ficam em `auto` (`client.ts:203-205` repassa `config.diagnosticMode` = undefined → default `"auto"` em `installDiagnosticsBridge`), e `shouldUsePullDiagnostics("auto", false)` = false para servers que não anunciam `diagnosticProvider` (`diagnosticMode.ts:10-15`) → push-only. Um único caminho (push) + feature nativa desligada = markers únicos por owner. |
| 4 | A rotina de reset descarta contribuições e para sessões de backend para TODO server id | **PASS** | `LspManager.stopAll` (`manager.ts:121-126`) une `clients` + `chains` e chama `stop(id)` para cada um. `stop` (`manager.ts:98-118`): `bump` (invalida starts em voo), `disposeLanguageClientContributions(client)` (descarta providers Monaco globais, `client.ts:237-243`), `client.stop()` e `stopLspServer(serverId)` (encerra a sessão de backend). A bridge de diagnostics adiciona um disposable que limpa markers e store no teardown (`diagnostics.ts:483-490`). `restartAll` em `useLspManager.ts:205-213` chama `stopAll()`, zera o estado e reinicia os servers das linguagens abertas. Cobertura é automática porque todo server passa pelo `LspManager` (regra de extensão de `command-palette.md`). |

### 1.3 Leitura sobre a pergunta do worker TS embutido (risco runtime nº 1)

O agente de implementação sinalizou que a build `@codingame` pode não empacotar
`monaco.languages.typescript`, tornando `disableBuiltinTsWorker` um no-op
defensivo (`monacoSetup.ts:102-130`). Minha leitura:

- **Cenário bom (provável e desejado):** se a stack `@codingame/monaco-vscode-editor-api`
  não empacota o worker TS embutido, então **não existe um segundo provedor de
  IntelliSense competindo** com o `typescript-language-server`. O guard `if (!ts) return`
  apenas confirma que não há nada a desligar. Não há duplicação de markers nem de
  completions porque o worker simplesmente não está presente. O comentário no
  código (`:104-109`) descreve exatamente isso: "TS/JS IntelliSense there comes
  from the real `typescript-language-server`".
- **Não implica diagnostics ausentes:** os diagnostics de TS/JS vêm da bridge de
  push (`diagnostics.ts`), totalmente independente do worker embutido. A ausência
  do worker não tira a fonte de diagnostics — apenas remove a fonte concorrente.
- **Ressalva a verificar em runtime:** isso é uma INFERÊNCIA estática. Não há teste
  que prove que (a) o worker embutido está mesmo ausente na build v10 e (b) que
  ele não foi reintroduzido por algum override de serviço. Em `vscodeServices.ts:79`
  o `configureDefaultWorkerFactory(undefined)` registra só editor+textmate workers
  e o comentário afirma não empacotar os language workers vanilla — mas isso
  precisa ser confirmado no app real (passo 7 do checklist). **Se** por algum
  motivo o worker embutido ESTIVER presente e o `if (!ts)` continuar caindo no
  no-op (ex.: a API existe mas com shape diferente), aí sim haveria competição /
  markers duplicados — é o motivo de o passo de TS/JS ser o primeiro a checar.

**Conclusão:** estruturalmente, a ausência do worker é benéfica (sem competição).
O risco residual é apenas confirmar empiricamente que o worker está ausente E que
os diagnostics/completions chegam pelo LSP. Ver checklist §2 passos 6-8.

### 1.4 Lista completa de server ids no `SERVER_REGISTRY`

Montado em `servers/index.ts:90-109` a partir de `BASE_REGISTRY` (`:48-61`),
`NPM_REGISTRY` (`npm.ts:55-71`) e `SYSTEM_REGISTRY` (`system.ts:52-55`).

Mapeado por **server id** (uma sessão por id) → linguagens Monaco que o disparam:

| Server id | Origem | Linguagens (ids Monaco) | Starter |
|---|---|---|---|
| `csharp` | base | `csharp` | `startCsharpServer` |
| `typescript` | base | `typescript`, `javascript`, `typescriptreact`, `javascriptreact` | `startTypescriptServer` |
| `razor` | base | `aspnetcorerazor` (`.razor`, cohost Roslyn) | `startRazorServer` |
| `razor-projection` (`RAZOR_PROJECTION_SERVER_ID`) | base | `cshtml` (`.cshtml`, projeção ADR 0002) | `startRazorProjectionServer` |
| `python` | npm | `python` | Pyright (`makeNpmServerStarter`) |
| `yaml` | npm | `yaml` | YAML LS |
| `json` | npm | `json` | JSON LS |
| `html` | npm | `html` | HTML LS |
| `css` | npm | `css`, `scss`, `less` | CSS LS |
| `shell` | npm | `shell` | Bash LS |
| `dockerfile` | npm | `dockerfile` | Dockerfile LS |
| `dart` | system | `dart` | Dart LS (PATH) |
| `go` | system | `go` | gopls (PATH) |

> Observação: `csharp` e `razor-projection`/`razor` são Roslyn (escopo das
> issues #77/#78), incluídos aqui só para completar a lista do registry. Os
> servidores **não-Roslyn** alvo de #79 são: `typescript`, `python`, `yaml`,
> `json`, `html`, `css`, `shell`, `dockerfile`, `dart`, `go`.
>
> Nota: `servers/cshtml.ts` (`startCshtmlServer`, id `fluent-cshtml`) é um STUB
> legado que apenas lança erro e **não está no registry** — o `cshtml` é servido
> por `startRazorProjectionServer`. Não precisa ser validado em runtime.

---

## 2. Checklist manual de runtime (issue #79)

> Requer o app real. Conforme a memória do projeto, E2E usa **`tauri build`** (não
> `cargo build`) + `tauri-driver` + WebdriverIO. Cada item: **Ação / Esperado /
> Como observar**. Logs LSP saem por `lspLog` (`src/lsp/debug.ts`) — abrir o
> DevTools/console para acompanhar `client.start() RESOLVED` / `THREW`,
> `diagnostics bridge: push-only`, `provideDocumentSemanticTokens`, etc.

### A. Startup + shutdown de CADA server registrado (sem crash)

Para cada server abaixo: abrir um arquivo da linguagem em uma pasta de projeto;
confirmar que sobe (`ready` na StatusBar) **ou** falha com mensagem controlada
(`error` na StatusBar + mensagem no console, sem travar o app). Depois fechar a
pasta/abas e confirmar que para sem deixar markers.

1. **`typescript`** — abrir `.ts`/`.tsx`/`.js`/`.jsx`.
   - Esperado: server `typescript-language-server` em `ready` (uma sessão cobre os
     4 dialetos). Sem crash "unsupported".
   - Observar: StatusBar mostra "TypeScript Language Server"; console loga
     `client.start() RESOLVED for typescript`.
2. **`json`** — abrir um `.json` (ex.: `package.json`).
   - Esperado: JSON Language Server em `ready`.
   - Observar: StatusBar + `client.start() RESOLVED for json`.
3. **`python`** (Pyright) — abrir um `.py`.
   - Esperado: instala via npm na 1ª vez (status `downloading` → `ready`) ou
     falha com mensagem se não houver Node/instalação.
4. **`yaml`** — abrir um `.yaml`/`.yml`.
   - Esperado: `ready` ou falha controlada.
5. **`html`** — abrir um `.html`.
6. **`css` / `scss` / `less`** — abrir um `.css`/`.scss`/`.less` (um único server `css`).
7. **`shell`** — abrir um `.sh`.
8. **`dockerfile`** — abrir um `Dockerfile`.
9. **`dart`** — abrir um `.dart` (server do SDK pelo PATH).
   - Esperado: se o Dart SDK estiver no PATH, `ready`; senão **falha controlada**
     (ver passo D).
10. **`go`** (gopls) — abrir um `.go`.
    - Esperado: se `gopls`/Go no PATH, `ready`; senão falha controlada.

> Critério global: NENHUM dos passos acima pode derrubar o app ou lançar exceção
> não tratada de "unsupported provider". Falha aceitável = status `error` +
> mensagem.

### B. TypeScript / JavaScript (foco da regressão)

11. **Completions** — em um `.ts`, digitar e acionar `Ctrl+Espaço` em um membro
    (`obj.`).
    - Esperado: sugestões vindas do `typescript-language-server`.
    - Observar: as sugestões respeitam o tsconfig/aliases do projeto (resolvidos
      pelo server via `rootUri`).
12. **Hover** — passar o mouse sobre um símbolo tipado.
    - Esperado: tooltip com o tipo/JSDoc do tsserver.
13. **Diagnostics do LSP (não do worker embutido)** — introduzir um erro de tipo
    (ex.: `const x: number = "a"`).
    - Esperado: squiggle vermelho + linha no painel Problemas, vindos do LSP.
    - Observar: o owner do marker é `typescript` (não `typescript`/`javascript`
      do worker embutido). `monaco.editor.getModelMarkers({ owner: "typescript" })`
      deve listar exatamente o(s) erro(s).
14. **Markers NÃO duplicados** — para o mesmo erro, contar os markers.
    - Esperado: **um** marker por diagnóstico (sem cópia do worker embutido).
    - Observar: no console, `diagnostics bridge: push-only for typescript`;
      `monaco.editor.getModelMarkers(...)` não mostra duplicatas com owners
      diferentes para a mesma posição.

### C. JSON

15. **Completions / hover** — em um `.json` com schema (ex.: `package.json`,
    `tsconfig.json`), acionar completion de chave/valor e hover.
    - Esperado: sugestões e descrições do JSON Language Server.
16. **Validação** — inserir JSON inválido (vírgula sobrando, chave fora do schema).
    - Esperado: squiggle + Problemas com **um** marker por erro (owner `json`).

### D. Server NÃO instalado falha graciosamente

17. **Linguagem cujo server não está disponível** — abrir um arquivo de um server
    de PATH ausente (ex.: `.go` sem `gopls`, ou `.dart` sem Dart SDK), ou um npm
    server cuja instalação falhe (sem Node).
    - Esperado: NENHUM crash; StatusBar marca `error`; console loga a mensagem
      descritiva (ex.: o erro de `ensureSystemLspServer`/`ensureNpmLspServer`).
    - Observar: o app continua usável; `provideDocument...`/providers não lançam
      "unsupported". O `client.start() THREW` (se houver) é logado com stack e
      tratado em `manager.start FAILED`.

### E. "Resetar Servidores de Código" / fechar workspace — limpeza total

18. **Reset único** — com vários servers `ready` e markers visíveis, executar
    `Ctrl+Shift+P` → "Resetar Servidores de Código".
    - Esperado: todos os servers passam por `starting` → `ready`; markers somem e
      reaparecem (recomputados); painel Problemas não fica com linhas órfãs.
    - Observar: console mostra `manager.stop CALLED` para cada server id e
      `manager.start DONE` na volta. `monaco.editor.getModelMarkers({})` zera no
      momento do stop (a bridge limpa markers no teardown — `diagnostics.ts:483-490`).
19. **Reset repetido (vazamento)** — executar o reset 3-5 vezes seguidas.
    - Esperado: a contagem de providers/markers/listeners NÃO cresce a cada reset.
    - Observar: o número de markers para um mesmo arquivo de erro permanece igual
      após cada ciclo; não surgem providers concorrentes (completions/hover não
      passam a aparecer em dobro). `disposeLanguageClientContributions` é chamado
      em cada stop (`manager.ts:105`).
20. **Fechar / trocar workspace** — abrir outra pasta.
    - Esperado: `manager.stopAll()` derruba os servers da pasta anterior; markers
      e status são zerados (`useLspManager.ts:118-124`); a nova pasta repopula.
    - Observar: nenhum marker/Problema da pasta antiga sobra; sem providers da
      sessão anterior respondendo na nova pasta.

---

## 3. Veredito estrutural

- **Servidores não-Roslyn estruturalmente preservados:** SIM, com ressalva. Cada
  server do `SERVER_REGISTRY` passa por `createLanguageClient`, é iniciado pelo
  `LspManager` (logo coberto por `stopAll`/reset) e tem teardown que descarta
  providers e limpa markers. A bridge de push diagnostics + desligamento da
  feature nativa garante markers únicos por owner. Não há mais a fonte do crash
  "unsupported" (substituído por no-op que nunca lança).
- **Ressalva:** a validação automatizada é só estrutural — não há teste de
  startup/shutdown nem de markers para TS/JS/npm/system. Os comportamentos de
  runtime (completions, hover, diagnostics únicos, falha graciosa, reset sem
  vazamento) só estão cobertos pelo checklist manual §2.
- **Maior risco runtime a checar primeiro:** a questão do **worker TS embutido**.
  Estaticamente, a ausência dele na build `@codingame` é benéfica (sem
  competição) e `disableBuiltinTsWorker` vira no-op seguro. Mas isso é inferência
  — o primeiro teste a rodar no app real deve confirmar que (1) os diagnostics e
  completions de TS/JS chegam pelo `typescript-language-server` e (2) NÃO há
  markers duplicados (worker embutido ausente ou desligado). Passos 6-8 e 11-14
  do checklist.
