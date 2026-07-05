# Agentes de IA (Claude Code / Codex) — contratos de integração

Este documento registra as decisões obrigatórias da integração com os CLIs de
IA. O código vive em `src-tauri/src/agents/` (backend) e
`src/components/AgentSidebar.tsx` + `src/agents/` (frontend).

## Arquitetura

- **Um processo por provedor+workspace**, de longa duração, gerenciado por um
  worker (`AcpState`). Nunca criar processo por mensagem — o custo de startup é
  o que deixava o chat lento.
- O chat abre **somente na sidebar** (view `agents` da activity bar). O centro
  do editor nunca é substituído pelo chat.
- Cada conversa guarda o **id nativo de sessão/thread** do provedor em
  `.project/agents.json` (`conversation.nativeSessionId`). É ele que permite
  retomar a conversa sem reenviar o transcript: o evento `session` do backend
  deve sempre ser persistido pelo frontend.
- O contexto completo (`contextPrompt`, com prompt inicial + histórico da UI) é
  **apenas fallback**, usado quando não existe sessão nativa retomável
  (conversa nova ou sessão apagada/expirada). Com sessão nativa, envia-se só a
  nova mensagem.
- Cada agente guarda o **modelo** escolhido do provedor
  (`AgentDefinition.model`, id do catálogo em `src/acp/providers`). O catálogo é
  a fonte da verdade: `acpModels(provider)` lista as opções (a primeira é o
  padrão) e `acpResolveModel(provider, model)` blinda contra ids antigos/
  removidos caindo no padrão. O modelo é passado ao backend via `acp_prompt`
  (`model`) e daí a cada provedor; vazio ⇒ o CLI usa o modelo padrão dele.
- **Ids de modelo são validados contra os CLIs reais, nunca chutados** (um id
  inválido faz o turno falhar no provedor). Como validar ao atualizar o
  catálogo: Codex → `codex app-server` + request `model/list` (retorna ids,
  displayName e descrição); Claude → `--model` aceita o nome completo do
  modelo da família atual (testar com `claude -p --model <id> "ok"`). Rótulos
  devem exibir a **versão** (ex.: "Opus 4.8", "GPT-5.5").

## Referência do arquivo/seleção ativos no envio

Espelha o Claude Code: ao enviar, o chat pode anexar o **arquivo aberto** e o
**trecho selecionado** no editor.

- A chip de contexto no composer é preenchida pelo botão "anexar" (ícone
  `mention`), que lê `EditorActionsApi.getSelection()` + o `activePath` no
  momento do clique (`readEditorContext` no `App`). Some ao enviar.
- `formatEditorContextReference` (em `src/agents/store.ts`) formata o bloco
  `CONTEXTO DO EDITOR` com o caminho **relativo ao workspace** (separador
  POSIX) e, quando há seleção, o intervalo de linhas + o trecho num code fence.
- O bloco entra no **prompt enviado ao provedor** (tanto no envio incremental da
  sessão retomada quanto no `contextPrompt` da sessão nova), nunca na `content`
  exibida da mensagem — a UI continua mostrando só o que o usuário digitou.

## Claude — CLI direto em stream-json (sem npx, sem adaptador ACP)

Mesmo caminho da extensão oficial do VS Code:

```
claude -p --input-format stream-json --output-format stream-json \
  --verbose --include-partial-messages [flags de modo] [--resume <sessionId>]
```

- **Não reintroduzir** o adaptador `@agentclientprotocol/claude-agent-acp` via
  `npx`: era a causa das mensagens lentas/falhando (resolução npm + cmd.exe +
  camada extra por cima do próprio CLI).
- stdin recebe NDJSON `{"type":"user","message":{"role":"user","content":…}}`;
  o processo fica vivo entre turnos. Fim de turno = evento `{"type":"result"}`.
- Texto parcial vem em `stream_event → content_block_delta → text_delta`.
  Deltas com `parent_tool_use_id` são de sub-agentes/ferramentas — ignorar.
- Raciocínio (extended thinking) vem em `content_block_delta → thinking_delta`
  com o texto em `delta.thinking` — repassado ao frontend como evento
  `thought` (ver "Stream de raciocínio" abaixo).
- O session id chega no evento `system/init` (e no `result`). Ao retomar com
  `--resume`, o CLI pode **criar um id novo**; sempre emitir/persistir o id
  mais recente.
- Um processo atende **uma conversa+modo**; trocar de conversa ou de modo mata
  o processo e retoma a alvo com `--resume` (as permissões são flags de
  processo). Sessões ficam em `~/.claude/projects/…`.
- Interrupção: matar o processo (o protocolo de interrupt por stdin não é
  documentado). A sessão persiste em disco; o próximo envio retoma.
- Modos → flags (permission modes NATIVOS do CLI, validados no 2.1.162):
  `ask` = `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash` (leitura
  pura — mais limpo que `default` headless, que negaria pedido a pedido);
  `plan` = `--permission-mode plan`; `edit` = `--permission-mode acceptEdits
  --disallowedTools Bash`; `auto` = `--permission-mode auto`; `bypass` =
  `--permission-mode bypassPermissions`.
- Modelo → flag `--model <id>` (omitida quando vazio). Como as flags são
  por-processo, **trocar de modelo derruba e recria o processo** (igual à troca
  de modo), retomando a sessão com `--resume`.
- Windows: o `claude` pode ser `claude.exe` (instalador nativo) ou shim npm
  `claude.cmd`. Preferir `node <…>/claude-code/cli.js` quando o shim é npm;
  spawnar `.cmd` direto só como último recurso. Todo spawn precisa de
  `CREATE_NO_WINDOW`.
- O servidor MCP de conhecimento do editor (`fluent-coder --mcp <root>`) é
  injetado via `--mcp-config <arquivo temporário>`.

## Codex — `codex app-server` (JSON-RPC por stdio)

Mesmo protocolo da extensão IDE oficial (validado no código da tag
`rust-v0.136.0`):

- `initialize` → `initialized` → `thread/start`/`thread/resume` → `turn/start`.
- **Nunca usar `ephemeral: true`** no `thread/start`: threads efêmeras não são
  gravadas em `~/.codex/sessions`, não aparecem em `thread/list` e não podem
  ser retomadas — era a causa do histórico perdido do Codex.
- Retomada: `thread/resume { threadId }` (o CLI reconstrói o histórico do
  rollout). Se falhar (rollout apagado), iniciar thread nova e reenviar o
  contexto completo.
- Streaming: `item/agentMessage/delta`; fim de turno em `turn/completed`
  (`params.turn.status`: `completed | interrupted | failed`); erros na
  notificação `error` (respeitar `params.willRetry`).
- Raciocínio: `item/reasoning/summaryTextDelta` (resumo, o caso comum em
  contas ChatGPT) e `item/reasoning/textDelta` (raciocínio bruto, quando a
  conta o expõe) → evento `thought`; `item/reasoning/summaryPartAdded` com
  `summaryIndex > 0` vira quebra de parágrafo. Os modelos gpt-5.x raciocinam
  por padrão (effort `medium`) antes do primeiro token — esse stream é o que
  preenche a espera percebida.
- Interrupção: `turn/interrupt { threadId, turnId }` — o processo e a thread
  continuam vivos.
- Modos → sandbox + approvalPolicy nativos (variantes validadas no 0.136.0):
  `ask`/`plan` = `read-only`/`never`; `edit` = `workspace-write`
  (`writableRoots=[workspace]`, rede off)/`never`; `auto` = `workspace-write`/
  `on-request` (escalações chegam como requests e este cliente headless as
  nega via `reject_server_request` — equivalente ao Auto sem aprovador);
  `bypass` = `danger-full-access`/`never`.
- Modelo → campo `model` no `thread/start` e no `turn/start` (omitido quando
  vazio). No `turn/start` ele honra a troca de modelo mesmo numa thread já
  retomada, sem recriar a thread.

## Modos sem prompt injetado

**Nenhum prompt de aplicativo é injetado antes do chat.** Os modos são
aplicados exclusivamente pelo mecanismo nativo de cada provedor (permission
modes/tool rules no Claude, sandbox+approvalPolicy no Codex) — o equivalente a
rodar `claude --permission-mode plan` na mão. Não reintroduzir diretivas de
modo, `<system-reminder>`, fronteira de workspace ou dicas de ferramentas no
prompt: o plan mode do Claude, por exemplo, já injeta a própria orientação
nativamente.

Os únicos prefixos possíveis na mensagem enviada, todos originados do usuário:

- o **prompt inicial do agente** (`AgentDefinition.initialPrompt`), quando o
  usuário o definiu ao criar o agente — vai no `contextPrompt` de sessão nova;
- a **referência do editor** (arquivo/seleção), quando o usuário anexa a chip;
- o **histórico da UI**, reenviado apenas quando a sessão nativa se perdeu.

Sem nada disso, `buildAgentPrompt` retorna a mensagem crua.

Os modos são `ask | plan | edit | auto | bypass` (espelham os do Claude Code);
`dev` é o nome legado de `bypass` — aceito no parse do backend e migrado no
store pelo frontend (`normalizeAgentMode`). Modos somente leitura (ask/plan)
não criam snapshot de reversão no envio (`READ_ONLY_MODES`).

## Stream de raciocínio (evento `thought`)

- Ambos os provedores repassam o raciocínio do modelo em streaming pelo evento
  `AcpEvent::Thought` (`{type:"thought", content}`), separado do `text`.
- O raciocínio é **efêmero**: o `App` o guarda fora do store
  (`agentThought`, amarrado à conversa dona como status/erro), a sidebar o
  exibe num bloco discreto ("Raciocínio", cauda visível via `column-reverse`)
  enquanto o turno roda, e o primeiro delta de `text` o limpa — ele nunca
  entra no transcript persistido em `agents.json`.
- Os deltas são coalescidos por frame no `App` (mesmo padrão do texto) para
  não re-renderizar a cada token.

## Regras de UI

- Prompt inicial do agente é **opcional** (só o nome é obrigatório).
- O composer traz um **seletor de modo de permissão** (Ask/Plan/Edit/Auto/
  Bypass) e um **seletor de modelo**, ambos no popover `ComposerPicker`
  (padrão do seletor de modos do Claude Code: ícone + título + descrição +
  check no selecionado; `align` start/end para não vazar da sidebar), além do
  botão de **anexar contexto** do editor. O modelo também aparece no
  formulário de criação/edição do agente e é persistido em
  `AgentDefinition.model`.
- O chat é uma **sidebar secundária**, ancorada na borda **oposta** à barra
  lateral principal (nunca na principal). Largura redimensionável, padrão
  500px, persistida em `ui.agentsSidebarWidth`. O lado é derivado:
  `agentsSide = oposto de sidebarSide`, então as duas nunca colidem.
- O toggle mostra/oculta essa sidebar e fica na **title bar**, à esquerda dos
  botões de layout (barra lateral / painel).
- Criar/editar agente, histórico e chat acontecem todos dentro dessa sidebar,
  seguindo o [guia Fluent 2](../design/fluent-design.md).
- Texto da conversa em contraste alto (`--text`), não secundário/muted.
- **Status e erro pertencem à conversa que os produziu**: no `App`, os estados
  guardam `{conversationId, message}` (`conversationId: null` = aviso global,
  ex.: falha de load/persist do store) e a UI só exibe o aviso quando a
  conversa dona está selecionada — abrir outro chat nunca mostra o erro alheio.
- **Mensagens de status não expõem detalhes de implementação** (CLI, processo,
  adaptador): o usuário vê "Iniciando o Claude…", "Preparando o Codex…", nunca
  "processo"/"CLI". Erros acionáveis (ex.: "CLI não encontrado, instale…")
  podem citar o CLI porque orientam a correção.
- Arquivos citados pelo agente (`caminho`, `caminho:linha`) são clicáveis e
  abrem no editor. A detecção é pura em `src/agents/fileRef.ts` (`parseFileRef`
  / `resolveWorkspacePath`); só `code` inline sem `language-*` e links cujo
  destino tenha extensão conhecida viram link — evita transformar
  `obj.Metodo()` ou identificadores em falso-positivo.
- **Abrir um arquivo citado tolera referências inexatas**
  (`handleOpenAgentFile` no `App`): se o caminho resolvido não existir, procura
  o melhor candidato no índice do Quick Open (sufixo do caminho relativo >
  nome do arquivo; empate = menos aninhado) antes de mostrar erro — agentes
  costumam citar só o nome (`Controller.cs`).
- **Pré-aquecimento**: selecionar um chat dispara `acp_warm` (idempotente), que
  sobe o worker do provedor — no Codex isso inclui o `app-server` +
  `initialize` — antes do primeiro envio. A latência restante é do turno do
  modelo em si (medida: ~5–6s para um prompt trivial no gpt-5.5 com reasoning
  `medium`), não do pipeline.
- **Blocos de código cercados têm realce de sintaxe** via Shiki
  (`src/agents/codeHighlight.ts`), tema `dark-plus` — a mesma família Dark+ do
  `fluent-acrylic-dark` do editor, então as cores do chat casam com o editor.
  Grammars carregam sob demanda por linguagem; falha/linguagem desconhecida/
  bloco > 20k chars degradam para o bloco plano (mesma moldura, sem salto de
  layout). O override fica no `pre` do ReactMarkdown (`CodeBlock` no
  `AgentSidebar`); o `code` custom segue tratando apenas o inline.
- **Chips de `code` inline têm coloração heurística por token**
  (`src/agents/inlineCode.ts`, função pura `tokenizeInline`): palavra-chave/
  fluxo de controle/`Chamada(`/`PascalCase`/número/string nas cores Dark+ do
  editor — sem linguagem declarada, a heurística de forma é proposital e um
  palpite errado é inofensivo. Base do chip neutra (`#d4d4d4`); classes
  `.tok-*` no styles.css.
- **Tabelas do markdown rolam horizontalmente** no próprio wrapper
  (`.agent-table-wrap`, override de `table`) quando não cabem na sidebar.
  Dentro de células o texto quebra só em espaços (anula o `overflow-wrap:
  anywhere` do chat) e chips de código/cabeçalhos nunca partem no meio.
