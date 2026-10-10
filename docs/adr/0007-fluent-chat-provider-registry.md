# ADR 0007 — Registro multi-CLI de provedores do Fluent Chat

- **Status:** aceito
- **Data:** 10/10/2026
- **Evidência:** `cargo test` (cliente ACP ponta a ponta contra o agente falso
  `tools/acp-fixture/fake-agent.mjs`); `codex app-server` 0.162.1 com
  `-c mcp_servers.fluent_knowledge.*` listando as 6 ferramentas do servidor de
  conhecimento em `mcpServerStatus/list`; `claude` 2.1.296 aceitando
  `--permission-prompt-tool stdio` + `control_request/initialize` (sem chamada
  de modelo).

## Contexto

O chat de agentes conhecia dois provedores fixos (`"codex" | "claude"`), com o
despacho espalhado em `match`es no backend e no frontend. Queríamos:

1. vários CLIs de IA (Gemini CLI, opencode, Qwen Code, Copilot CLI, Goose…)
   sem reescrever a sidebar a cada um;
2. manter os caminhos nativos que já funcionam bem (Claude em stream-json,
   Codex em app-server) — o adaptador ACP do Claude via `npx` foi a causa do
   chat lento e **não** pode voltar;
3. recursos comuns a todos: chamadas de ferramenta, aprovações, consumo.

Boa parte do ecossistema convergiu para o **Agent Client Protocol** (ACP,
agentclientprotocol.com): JSON-RPC por stdio com `initialize` →
`session/new|load` → `session/prompt` e streaming em `session/update`.

## Decisão

- **Backend:** trait `AgentProvider` (`src-tauri/src/agents/registry.rs`) com
  `descriptor()` (id, rótulo, protocolo, binário, args, dica de instalação),
  `detect()` (CLI no PATH) e `spawn_worker(root, jobs)`. O registro tem os
  nativos (`ClaudeProvider`, `CodexProvider`) e um `AcpProvider` genérico
  parametrizado por linha de comando. `AcpState` só conhece o trait: um worker
  por provedor+workspace, como antes.
- **Agentes ACP conhecidos** são linhas de dados (`ACP_AGENTS`), com comandos
  conferidos no registro oficial do ACP e na documentação de cada CLI:
  `gemini --acp` (fallback `--experimental-acp`), `copilot --acp --stdio`,
  `opencode acp`, `qwen --acp` (fallback `--experimental-acp`), `goose acp`,
  `kimi acp`, `auggie --acp`, `cursor-agent acp`. Não instalado ⇒ aparece no
  seletor desabilitado, com a dica de instalação.
- **Vocabulário único de eventos** (`AcpEvent`): `text`, `thought`, `status`,
  `session`, `done`, `error` + `toolCall` (upsert por id, com diffs),
  `approval`/`approvalResolved`, `usage` e `models`. Cada provedor traduz o
  próprio protocolo para ele; o frontend nunca conhece o protocolo do CLI.
- **Aprovações** passam por um `ApprovalBroker` (request id → canal do turno)
  e pelo comando `chat_respond_approval`.
- **Frontend:** `src/acp/providers` vira o catálogo (rótulos, modelos) mesclado
  com o status do backend (`chat_providers`); provedores desconhecidos viram um
  ACP genérico. Os alvos do seletor (`src/chat/targets.ts`) são provedores
  diretos (`provider:<id>`) + agentes personalizados.
- **Teste sem custo:** `tools/acp-fixture/fake-agent.mjs` implementa o lado
  agente do ACP; o `cargo test` dirige o cliente Rust real contra ele, e
  `FLUENT_ACP_FAKE=1` o registra como "Agente ACP de teste" no app.

## Consequências

- Adicionar um CLI que fala ACP = uma linha em `ACP_AGENTS` (+ entrada no
  catálogo do frontend para rótulo/ícone). Um protocolo novo = um novo
  `impl AgentProvider`.
- O cliente ACP **serve** `fs/read_text_file`/`fs/write_text_file` (dos
  buffers abertos no Monaco — edições não salvas visíveis, escrita desfazível;
  escrita só dentro do workspace) e `terminal/*` (PTY real, visível no painel)
  — `agents/acp_client.rs`, detalhes em `docs/context/agentes-ia.md`.
  (Atualização de 10/10/2026; antes declarava ambos como não suportados.) O
  "sandbox" é o mesmo do agente: as aprovações por modo continuam valendo para
  as ferramentas dele.
- Modos no ACP usam o mecanismo nativo do agente quando existe
  (`configOptions` de categoria `mode` ou `session/set_mode`, casando por
  vocabulário conhecido) **e** uma política de aprovação por modo; nenhum texto
  de modo é injetado no prompt.
- Os processos dos agentes não são servidores de linguagem: ficam fora do
  "Resetar Servidores de Código" e têm o comando próprio "Fluent Chat:
  Reiniciar Agentes de IA".
- Os comandos dos CLIs ACP e os ids de modelo regridem quando os projetos
  mudam; revalidar ao atualizar (ver `docs/context/agentes-ia.md`).
