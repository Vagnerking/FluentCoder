# Fluent Chat (agentes de IA: Claude Code, Codex, ACP) — contratos de integração

Este documento registra as decisões obrigatórias da integração com os CLIs de
IA. O chat chama-se **Fluent Chat** e é uma view do workbench (padrão: sidebar
secundária; movível — ver [Views & Layout](views-layout.md)). O código
vive em `src-tauri/src/agents/` (backend: `mod.rs`, `registry.rs`,
`events.rs`, `claude.rs`, `codex.rs`, `acp.rs`) e em `src/chat/` (lógica:
hook `useFluentChat`, menções, contexto, transcript) +
`src/components/chat/` (UI) + `src/agents/` (tipos/store) no frontend.
Registro multi-CLI: [ADR 0007](../adr/0007-fluent-chat-provider-registry.md).

## Arquitetura

- **Um processo por provedor+workspace**, de longa duração, gerenciado por um
  worker (`AcpState`). Nunca criar processo por mensagem — o custo de startup é
  o que deixava o chat lento.
- O chat é a view `fluentChat` (padrão: sidebar secundária; o usuário pode
  movê-la para a primária ou o painel). O centro do editor nunca é
  substituído pelo chat.
- Cada conversa guarda o **id nativo de sessão/thread** do provedor em
  `.project/agents.json` (`conversation.nativeSessionId`). É ele que permite
  retomar a conversa sem reenviar o transcript: o evento `session` do backend
  deve sempre ser persistido pelo frontend.
- O contexto completo (`contextPrompt`, com prompt inicial + histórico da UI) é
  **apenas fallback**, usado quando não existe sessão nativa retomável
  (conversa nova ou sessão apagada/expirada). Com sessão nativa, envia-se só a
  nova mensagem.
- O **modelo** vem do catálogo em `src/acp/providers` (fonte da verdade):
  agente personalizado guarda em `AgentDefinition.model`; chat direto com um
  provedor guarda a escolha por alvo nas preferências locais
  (`fluentChat.prefs`). `acpModels(provider, dinâmicos)` lista as opções (a
  primeira é o padrão) e `acpResolveModel` blinda contra ids antigos/removidos
  caindo no padrão. Agentes ACP não têm catálogo fixo: a primeira opção é
  "Padrão do agente" (`""`) e os modelos anunciados pela sessão (evento
  `models`) entram em runtime. Vazio ⇒ o CLI usa o modelo padrão dele.
- **Ids de modelo são validados contra os CLIs reais, nunca chutados** (um id
  inválido faz o turno falhar no provedor). Como validar sem custo ao
  atualizar o catálogo: Codex → `codex app-server` + request `model/list`;
  Claude → `claude -p --input-format stream-json --output-format stream-json
  --verbose --permission-prompt-tool stdio` + `control_request`
  `{"subtype":"initialize"}`: a resposta traz `models[].value` (usamos esses
  aliases — `opus`, `sonnet`… — estáveis entre versões). Rótulos exibem a
  **versão** (ex.: "Opus 5.5", "GPT-6.1-Sol"). Validado em 10/2026: Codex
  0.162.1, Claude 2.1.296.

## Contexto anexado (menções `#`/`@`)

Espelha o Copilot Chat: o usuário anexa contexto por **menções** no composer
(`#`/`@` abre um popup navegável por teclado; o botão `@` da barra insere `#`)
ou pelas sugestões do welcome. Cada menção vira uma **chip**; as chips somem
ao enviar e ficam registradas (só o rótulo) na mensagem do usuário.

| Menção | Conteúdo no prompt |
|---|---|
| `#arquivo` / arquivo do índice | arquivo ativo, ou qualquer arquivo do índice do Quick Open (fuzzy em `mentionSuggestions`), com conteúdo (até 12 mil caracteres) |
| `#seleção` | bloco `CONTEXTO DO EDITOR` (`formatEditorContextReference`) |
| `#problemas` | diagnósticos do workspace (erros primeiro, até 60) |
| `#grafo` | `build_context_bundle` do arquivo ativo (vizinhos no grafo, profundidade 1) |
| `#contexto` | arquivos relevantes à pergunta: índice de conhecimento (`loadIndex`) ranqueado por `rankKnowledge` (termos da pergunta × nome/caminho/títulos/tags + vizinhança do arquivo ativo + hubs) e o conteúdo dos 2 primeiros |
| `#terminal` | saída recente do terminal integrado (escuta global de `term-data`, ANSI removido) |
| `@workspace` | busca no projeto guiada pelo grafo (15 arquivos, motivos, conexões, hubs) |

- Agentes personalizados podem ter **presets** de contexto (anexados em todo
  envio): `graph`, `context`, `workspace`, `problems`, `selection`.
- Regras: o contexto é **originado do usuário** (chip/menção ou preset do
  agente dele) — nunca um prompt de aplicativo. Os blocos são montados por
  `assemblePrompt` (`src/chat/context.ts`) antes de `MENSAGEM DO USUÁRIO`, no
  mesmo formato do `CONTEXTO DO EDITOR`. Falha ao obter um anexo vira um bloco
  `CONTEXTO INDISPONÍVEL` — nunca impede o envio.

### Referência do arquivo/seleção ativos

- `#seleção`/`#arquivo` leem `EditorActionsApi.getSelection()` + o
  `activePath` no momento em que a menção é escolhida (`readEditorContext` no
  `App`).
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
  `--permission-mode bypassPermissions`. Restrições de agente personalizado
  (`RunOptions`: `--allowedTools`/`--disallowedTools`) somam às do modo e,
  como as demais flags, fazem parte da identidade do processo.
- **Aprovações interativas:** em todos os modos exceto Bypass o processo sobe
  com `--permission-prompt-tool stdio` (o mesmo protocolo de controle do Claude
  Agent SDK). Pedidos de permissão chegam no stdout como
  `{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name","input","permission_suggestions"}}`
  e viram cartão de aprovação; a resposta vai no stdin como
  `{"type":"control_response","response":{"subtype":"success","request_id",…,"response":{"behavior":"allow","updatedInput":…}}}`
  (ou `"deny"` + `message`). "Sempre nesta sessão" devolve as
  `permission_suggestions` em `updatedPermissions` e libera a ferramenta no
  processo. Outros `control_request` recebem `subtype: "error"`. (O caminho
  alternativo `--permission-prompt-tool mcp__…` com uma ferramenta MCP do app
  foi descartado: o stdio já é o canal nativo e não exige servidor extra.)
- Chamadas de ferramenta: blocos `tool_use` das mensagens `assistant` (sem
  `parent_tool_use_id`) viram cartões (`claude_tool_call`: título, tipo ACP,
  diffs de Edit/MultiEdit/Write); `tool_result` das mensagens `user` os
  completam. Consumo: `result.usage` + `total_cost_usd`.
- Modelo → flag `--model <id>` (omitida quando vazio). Como as flags são
  por-processo, **trocar de modelo derruba e recria o processo** (igual à troca
  de modo), retomando a sessão com `--resume`.
- Windows: o `claude` pode ser `claude.exe` (instalador nativo) ou shim npm
  `claude.cmd`. Preferir `node <…>/claude-code/cli.js` quando o shim é npm;
  spawnar `.cmd` direto só como último recurso. Todo spawn precisa de
  `CREATE_NO_WINDOW`.
- O servidor MCP de conhecimento do editor (`fluent-coder --mcp <root>`) é
  injetado via `--mcp-config <arquivo temporário>` (comando em
  `knowledge_mcp_server`, compartilhado por todos os provedores).
- O MCP expõe `get_graph_overview` para dar ao agente uma leitura estrutural do
  workspace antes de pedir arquivos completos: estatísticas, células/pastas,
  hubs de contexto, isolados e, opcionalmente, a vizinhança de um arquivo
  semente. Use essa visão para decidir quais `get_related_files` ou
  `get_context_bundle` chamar, em vez de expandir o projeto inteiro.

## Ponte IDE do Claude Code (CLI interativo)

Decisão e protocolo no [ADR 0006](../adr/0006-claude-ide-bridge.md). Faz o
`claude` interativo (terminal integrado ou externo) tratar o Fluent Coder como
IDE, igual à extensão do VS Code. Código: `src-tauri/src/agents/ide_bridge.rs`
(servidor), `src/agents/ideBridge.ts` + `ideBridgeModel.ts` (estado/requests)
e `src/components/ClaudeDiffReview.tsx` (diff).

- **Não ligar ao Fluent Chat**: `claude -p` nunca conecta na IDE
  (limitação do CLI). A ponte atende só o CLI interativo.
- Um servidor WS por processo do app, em `127.0.0.1`. Lock file
  `~/.claude/ide/<porta>.lock` (`$CLAUDE_CONFIG_DIR/ide` se definido) com
  permissão **0600** e token de 128 bits do CSPRNG; existe só enquanto há
  pasta aberta (união das janelas locais; janelas SSH não publicam).
- Handshake: recusar token errado e **qualquer `Origin`**. Não afrouxar.
- Estado é **empurrado** pelo frontend (`ide_bridge_update`): pastas, abas
  (dirty/ativa), seleção do editor com foco (debounce 150ms → notificação
  `selection_changed`) e diagnósticos dos markers `file://` do Monaco
  (debounce 300ms). Linhas/colunas **0-based** no protocolo — converter só em
  `ideBridgeModel.ts`.
- `openDiff` bloqueia o CLI até Aceitar/Rejeitar: sem timeout no backend. Os
  modelos do diff usam o esquema `fluent-diff:` para nunca entrarem no LSP, na
  ponte nem em Problemas. Aceitar grava preservando encoding/EOL/BOM e
  responde `FILE_SAVED` + conteúdo final; rejeitar/fechar responde
  `DIFF_REJECTED`. `close_tab`/`closeAllDiffTabs` e queda da conexão
  dispensam o diff da UI.
- O terminal integrado exporta `CLAUDE_CODE_SSE_PORT` e
  `ENABLE_IDE_INTEGRATION=true` quando a ponte está no ar.
- A status bar mostra "Claude conectado" com ≥1 CLI conectado. Reiniciar
  (porta/token novos) pela Paleta: "Reiniciar Integração com o Claude Code
  (IDE)" — fora do reset de servidores de código.
- Aceite: `node tools/claude-ide-probe/probe.mjs <pasta>` (todas as
  verificações passando) + teste manual com o `claude` real (`/ide`, seleção,
  diff com Aceitar/Rejeitar).

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
  `on-request`; `bypass` = `danger-full-access`/`never`. Agente personalizado
  pode liberar a rede do `workspace-write` (`RunOptions.networkAccess`).
- **Aprovações interativas (modo Agente):** os requests do servidor
  `item/commandExecution/requestApproval` e `item/fileChange/requestApproval`
  (e os legados `execCommandApproval`/`applyPatchApproval`) viram cartões; a
  resposta é `{"decision": "accept" | "acceptForSession" | "decline" |
  "cancel"}` (legado: `approved`/`approved_for_session`/`{denied}`/`abort`).
  O diff do `fileChange` vem do `item/started` do mesmo `itemId`.
  `serverRequest/resolved` e o cancelamento tiram o cartão da tela. Outros
  requests continuam recusados (`reject_server_request`).
- Chamadas de ferramenta: `item/started|completed` de `commandExecution`,
  `fileChange` (diff unificado), `mcpToolCall` e `webSearch`. Consumo:
  `thread/tokenUsage/updated` (último turno + janela de contexto).
- MCP de conhecimento: `codex app-server -c
  mcp_servers.fluent_knowledge.command=<exe> -c
  mcp_servers.fluent_knowledge.args=["--mcp","<root>"]` (valores TOML;
  validado com `mcpServerStatus/list` no 0.162.1).
- Modelo → campo `model` no `thread/start` e no `turn/start` (omitido quando
  vazio). No `turn/start` ele honra a troca de modelo mesmo numa thread já
  retomada, sem recriar a thread.

## Agentes ACP (Agent Client Protocol)

Cliente genérico em `src-tauri/src/agents/acp.rs` para os CLIs do registro
(`registry.rs`, `ACP_AGENTS`): Gemini CLI (`gemini --acp`, fallback
`--experimental-acp`), GitHub Copilot CLI (`copilot --acp --stdio`), opencode
(`opencode acp`), Qwen Code (`qwen --acp`, fallback `--experimental-acp`),
Goose (`goose acp`), Kimi (`kimi acp`), Augment (`auggie --acp`) e Cursor
Agent (`cursor-agent acp`). Comandos conferidos no registro oficial do ACP em
10/2026 — revalidar ao atualizar.

- **Um processo por provedor+workspace**; cada conversa é uma sessão ACP
  (`session/new` com `cwd` + `mcpServers: [fluent-knowledge]`). Retomada:
  `session/load` (quando o agente anuncia `loadSession`) com o id salvo em
  `nativeSessionId`; o replay do histórico em `session/update` é ignorado (a UI
  já tem a conversa). Falhou ⇒ sessão nova com o `contextPrompt`.
- `initialize` declara as **capacidades de cliente** `fs.readTextFile`,
  `fs.writeTextFile` e `terminal` (`agents/acp_client.rs`). Os pedidos do
  agente chegam no meio do `session/prompt` e são atendidos em tarefas
  próprias (respostas pelo loop da chamada) — `terminal/wait_for_exit` não
  trava o streaming:
  - `fs/read_text_file` (`path` absoluto, `line` 1-based, `limit` em linhas):
    arquivo com modelo aberto no Monaco ⇒ o texto do **buffer** (edições não
    salvas incluídas); senão o disco. As janelas respondem pelo evento
    `acp-client://request` → `acp_client_respond` (`src/agents/
    acpClientServices.ts`, montado no App; cada janela se registra com
    `acp_client_register` para o backend saber quantas respostas esperar,
    teto 1,5 s).
  - `fs/write_text_file`: **só dentro do workspace** da sessão (fora ⇒ erro
    `-32000`); arquivo aberto ⇒ UMA edição desfazível no modelo (Ctrl+Z volta)
    + salvar do app; fechado ⇒ grava no disco (cria pastas) e atualiza o
    Explorer.
  - `terminal/create|output|wait_for_exit|kill|release`: PTY real
    (portable-pty) com `command`+`args` (linha de shell num só `command` roda
    por `/bin/sh -c`), `env` `[{name,value}]`, `cwd` absoluto (padrão: o
    workspace) e `outputByteLimit` (padrão 1 MiB; corta do começo em
    fronteira de caractere, `truncated: true`). `output` vai ao agente sem
    sequências ANSI/OSC; `exitStatus`/`wait_for_exit` = `{exitCode, signal}`.
    Com o app, o PTY aparece como aba **"Agente: <comando>"** no painel de
    terminais (`acp-terminal://created`; a aba conecta ao PTY existente —
    replay de `acp_terminal_snapshot` + `term-data` com `seq`) e continua
    visível depois do `release`; fechar a aba encerra o processo. Conexão
    encerrada ⇒ terminais mortos.
- Streaming: `agent_message_chunk` → `text`, `agent_thought_chunk` →
  `thought`, `tool_call`/`tool_call_update` → `toolCall` (diffs `oldText`/
  `newText`), `plan` → cartão "Plano", `usage_update` → `usage`. Variantes
  desconhecidas são ignoradas.
- Modos: o modo nativo do agente é aplicado quando existe
  (`configOptions` de categoria `mode` via `session/set_config_option`, ou
  `modes` via `session/set_mode`), casando por vocabulário (`pick_native_mode`:
  plan, acceptEdits/auto_edit, default, bypassPermissions/yolo…). Além disso,
  `session/request_permission` segue a política do modo
  (`permission_policy`): Bypass permite tudo; Perguntar/Planejar negam
  escrita/execução; Editar permite edições e nega comandos; Agente pergunta.
- Modelo: `configOptions` de categoria `model` (ou `models` instável via
  `session/set_model`) quando o id escolhido está entre os anunciados.
- Cancelamento: notificação `session/cancel`; pedidos de permissão pendentes
  recebem `{"outcome":{"outcome":"cancelled"}}`; o turno termina `cancelled`.
- Erro de autenticação no `session/new` ⇒ mensagem acionável ("rode `<cli>` no
  terminal para autenticar").
- **Não usar ACP para o Claude** (o adaptador `npx` continua proibido) nem
  para o Codex: os caminhos nativos acima prevalecem.
- Teste sem custo: `tools/acp-fixture/fake-agent.mjs` (agente falso; um
  prompt com "cliente" exercita fs/* e terminal/* do cliente — escrita fora
  do workspace precisa ser recusada e o `node -e` do terminal sai com 5);
  `cargo test fake_agent_end_to_end` dirige o cliente real contra ele e
  `FLUENT_ACP_FAKE=1 npm run tauri dev` o mostra no seletor como "Agente ACP
  de teste".

## Aprovações interativas

- Todos os provedores emitem `approval {requestId, title, detail, toolKind,
  options, diffs}`; o cartão (Permitir uma vez / Sempre nesta sessão / Negar,
  ou as opções do agente ACP) responde por `chat_respond_approval(requestId,
  optionId)`. O `ApprovalBroker` do `AcpState` roteia a resposta ao turno que
  espera; `approvalResolved` remove o cartão.
- Aprovações são **efêmeras** (fora do store) e pertencem à conversa dona;
  terminar/cancelar o turno descarta as pendentes.

## Transcript rico

- `toolCall` é upsert por `id` (`upsertToolCall`): a chamada guarda o offset do
  texto em que começou e o transcript intercala texto e grupos de cartões
  (`interleaveTranscript`). Persistidas em `AgentMessage.toolCalls` (diffs
  capados em 20 mil caracteres); chamadas abertas no fim do turno são
  encerradas (`settleToolCalls`).
- "Abrir diff" abre o DiffEditor do Monaco (modal somente leitura); diffs
  unificados do Codex são reconstruídos por `unifiedDiffToTexts`.
- `usage` é mesclado em `AgentMessage.usage` e exibido no rodapé da resposta.
- Ações: copiar (mensagem/resposta/bloco de código), **tentar de novo** e
  **editar a última pergunta**. As duas últimas criam um *fork* da conversa
  (novo id, sem a última troca e sem `nativeSessionId`): a sessão nativa não
  pode ser rebobinada, então o provedor recebe o `contextPrompt` com o
  histórico da UI até ali.
- Desempenho: mensagens memoizadas (o streaming só re-renderiza a resposta em
  andamento), deltas coalescidos por frame, só as últimas 40 mensagens
  montadas ("Mostrar anteriores") e `content-visibility: auto`.

## Agentes personalizados e store

- `.project/agents.json` **v2** (migração aditiva do v1 em
  `normalizeAgentStore`; um v1 válido sai idêntico, só com `version: 2`):
  `AgentDefinition` ganha `description`, `icon`, `defaultMode`,
  `contextPresets`, `allowedTools`/`disallowedTools` (Claude), `networkAccess`
  (Codex) e `scope`; `provider` é qualquer id do registro.
- Agentes **globais** (`scope: "global"`) ficam em
  `<app_data>/fluent-chat/agents.json` (`chat_global_agents_load|save`).
- Conversa aponta para `agentId` = id do agente **ou** `provider:<id>` (chat
  direto, zero-setup). Excluir um agente mantém as conversas dele com o
  provedor base.
- As instruções do agente são o `initialPrompt` (definido pelo usuário) e vão
  só no `contextPrompt` de sessão nova.

## Modos sem prompt injetado

**Nenhum prompt de aplicativo é injetado antes do chat.** Os modos são
aplicados exclusivamente pelo mecanismo nativo de cada provedor (permission
modes/tool rules no Claude, sandbox+approvalPolicy no Codex) — o equivalente a
rodar `claude --permission-mode plan` na mão. Não reintroduzir diretivas de
modo, `<system-reminder>`, fronteira de workspace ou dicas de ferramentas no
prompt: o plan mode do Claude, por exemplo, já injeta a própria orientação
nativamente.

Os únicos prefixos possíveis na mensagem enviada, todos originados do usuário:

- o **prompt inicial do agente** (`AgentDefinition.initialPrompt`, as
  "Instruções" do agente personalizado), quando o usuário o definiu — vai no
  `contextPrompt` de sessão nova;
- os **blocos de contexto** que o usuário anexou (menções/chips) ou que o
  agente personalizado dele define como preset;
- o **histórico da UI**, reenviado apenas quando a sessão nativa se perdeu.

Sem nada disso, `buildAgentPrompt` retorna a mensagem crua.

Os modos são `ask | plan | edit | auto | bypass` (espelham os do Claude Code)
e aparecem na UI com os nomes do Copilot: **Perguntar** (ask), **Planejar**
(plan), **Editar** (edit), **Agente** (auto) e **Bypass** (com aviso fixo no
composer);
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

- **Zero-setup:** abrir o Fluent Chat mostra o composer pronto (welcome com
  sugestões); a conversa é criada no primeiro envio com o alvo escolhido. Não
  é preciso criar agente. Se o último alvo não está instalado, o chat novo cai
  no primeiro provedor instalado.
- Instruções do agente são **opcionais** (só o nome é obrigatório).
- Composer: textarea com auto-altura (até 240px), **Enter envia /
  Shift+Enter quebra linha**, botão Parar durante o streaming, chips de
  contexto e a barra inferior com os seletores no popover `ComposerPicker`
  (WAI-ARIA de menu: setas/Home/End, Enter, Esc devolve o foco): **agente**
  (provedores instalados, não instalados desabilitados com a dica de
  instalação, agentes personalizados e "Gerenciar agentes…"), **modo** e
  **modelo**. Trocar de agente numa conversa com mensagens abre uma conversa
  nova (a sessão nativa pertence ao alvo anterior).
- Fluent Chat, Claude Code (`ext:anthropic.claude-code`) e Codex
  (`ext:openai.chatgpt`) são **views independentes** do registro — por
  padrão abas da sidebar secundária, cada uma movível sozinha ("Mover
  para…"/arrastar; [Views & Layout](views-layout.md)). As de extensão são a
  UI **real** hospedada pelo mini extension host — contratos em
  [Extensões VS Code hospedadas](extensoes-vscode.md); elas não mudam nada
  deste chat.
- **Não existe mais a aba "Agentes"**: o gerenciador (agentes personalizados
  + provedores detectados) abre no diálogo **"Configurar agentes"**
  (`AgentsSettingsDialog`) — engrenagem no cabeçalho do chat, item
  "Gerenciar agentes…" do seletor do composer e Paleta "Fluent Chat:
  Gerenciar Agentes". A aba antiga lembrada (`ui.agentsDockTab`) migra para a
  view `fluentChat`.
- Paleta: "Fluent Chat: Abrir", "Nova Conversa", "Histórico de Conversas",
  "Gerenciar Agentes" e "Reiniciar Agentes de IA" (`acp_stop_all`; os
  processos de agentes não são servidores de linguagem e ficam fora do
  "Resetar Servidores de Código" — ver
  [Paleta de Comandos](command-palette.md)).
- Histórico: busca (título + mensagens, sem acento), grupos por data,
  renomear inline e excluir com confirmação.
- A sidebar secundária fica ancorada na borda **oposta** à barra lateral
  principal. Largura redimensionável, padrão 500px, persistida em
  `ui.agentsSidebarWidth`. O lado é derivado: `agentsSide = oposto de
  sidebarSide`, então as duas nunca colidem.
- O toggle "Mostrar/Ocultar barra lateral secundária" fica na **title bar**,
  à esquerda dos botões de layout (barra lateral / painel). A Paleta
  "Fluent Chat: Abrir" revela a view onde ela estiver.
- Histórico e chat acontecem na view; criar/editar agente no diálogo
  "Configurar agentes", seguindo o [guia Fluent 2](../design/fluent-design.md).
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
- **Pré-aquecimento**: com o Fluent Chat visível, o alvo atual dispara `acp_warm` (idempotente), que
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
  `ChatMarkdown`, que também ganha a barra com linguagem + "Copiar"); o `code` custom segue tratando apenas o inline.
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
