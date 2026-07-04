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
- O session id chega no evento `system/init` (e no `result`). Ao retomar com
  `--resume`, o CLI pode **criar um id novo**; sempre emitir/persistir o id
  mais recente.
- Um processo atende **uma conversa+modo**; trocar de conversa ou de modo mata
  o processo e retoma a alvo com `--resume` (as permissões são flags de
  processo). Sessões ficam em `~/.claude/projects/…`.
- Interrupção: matar o processo (o protocolo de interrupt por stdin não é
  documentado). A sessão persiste em disco; o próximo envio retoma.
- Modos → flags: `ask` = `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash`;
  `plan` = `--allowedTools "Write(**/*.md),Edit(**/*.md)" --disallowedTools Bash`;
  `dev` = `--permission-mode bypassPermissions`.
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
- Interrupção: `turn/interrupt { threadId, turnId }` — o processo e a thread
  continuam vivos.
- Modos → sandbox nativo: `ask`/`plan` = `read-only`; `dev` =
  `workspace-write` com `writableRoots=[workspace]` e rede desligada.

## Regras de UI

- Prompt inicial do agente é **opcional** (só o nome é obrigatório).
- Criar/editar agente, histórico e chat acontecem todos dentro do painel da
  sidebar, seguindo o [guia Fluent 2](../design/fluent-design.md).
