# ADR 0006 — Ponte IDE nativa do Claude Code

- **Status:** aceito
- **Data:** 10/10/2026
- **Evidência:** protótipo Node (servidor WS fingindo ser o "Fluent Coder")
  contra o CLI `claude` 2.1.296 em modo interativo, registrando todo o tráfego
  JSON-RPC; e o probe `tools/claude-ide-probe/probe.mjs` contra a implementação
  Rust (25/25).

## Contexto

Com a extensão oficial do VS Code, o `claude` rodando no terminal enxerga a
IDE: recebe a seleção atual e os diagnósticos como contexto e mostra cada
edição proposta como **diff na IDE**, com aceitar/rejeitar. Queríamos o mesmo
no Fluent Coder.

O CLI descobre IDEs por **lock files** em `~/.claude/ide/<porta>.lock` (ou
`$CLAUDE_CONFIG_DIR/ide`) e fala com elas por **WebSocket + JSON-RPC 2.0/MCP**.
O protótipo mostrou o fluxo real:

| Direção | Mensagem | Observação |
|---|---|---|
| CLI → IDE | handshake com `x-claude-code-ide-authorization: <authToken>` | sem `Origin` |
| CLI → IDE | `initialize` (`protocolVersion: "2025-11-25"`) | resposta ecoa a versão |
| CLI → IDE | `notifications/initialized`, `ide_connected {pid}` | notificações |
| CLI → IDE | `tools/list`, `tools/call` | resultados `{content:[{type:"text",text}]}` |
| CLI → IDE | `closeAllDiffTabs` no startup | `CLOSED_<n>_DIFF_TABS` |
| CLI → IDE | `getDiagnostics` antes/depois de editar | array `{uri, diagnostics[]}`, faixas 0-based |
| CLI → IDE | `openDiff` — **bloqueia até o usuário decidir** | `FILE_SAVED` ou `DIFF_REJECTED` ("User rejected update") |
| IDE → CLI | `selection_changed` | seleção ao vivo |

## Decisão

Implementar o **protocolo IDE do CLI nativamente** (Rust + React), em vez de
hospedar a extensão `.vsix` do VS Code:

- **Rust** — `src-tauri/src/agents/ide_bridge.rs`: servidor WS em
  `127.0.0.1:<porta aleatória>`, um por processo do app; lock file `0600` com
  token de 128 bits do CSPRNG do SO (`getrandom`); handshake recusa token
  errado (comparação em tempo constante) e qualquer `Origin` (CSRF de
  navegador). As ferramentas de consulta respondem de um cache que o frontend
  empurra; `openDiff`/`openFile`/`saveDocument` vão para a janela dona do
  arquivo (pasta de workspace mais específica, senão a focada por último) e
  voltam por `ide_bridge_respond`. `openDiff` espera sem timeout; as demais
  têm 15 s. Conexão caída ⇒ diffs pendentes dela são dispensados na UI.
- **Lock file** só existe enquanto há pasta aberta: `workspaceFolders` é a
  união das janelas, regravado quando muda; removido ao fechar o workspace, ao
  sair do app e no reinício da ponte.
- **Terminal integrado** exporta `CLAUDE_CODE_SSE_PORT` e
  `ENABLE_IDE_INTEGRATION=true` quando a ponte está no ar (como o terminal do
  VS Code), então `claude` iniciado ali conecta sozinho.
- **Frontend** — `src/agents/ideBridge.ts` publica estado e atende requests;
  `ClaudeDiffReview` mostra o diff (Monaco diff editor) sobre a área do editor.
  Aceitar grava o arquivo (preservando encoding/EOL/BOM) e responde
  `FILE_SAVED` + conteúdo final (o lado direito é editável).

### Por que não hospedar a extensão do VS Code

- **Sem extension host:** a `.vsix` precisa de um host Node com a API
  `vscode` completa (comandos, `TextDocumentContentProvider`, webviews do
  painel de chat). O Fluent Coder usa só os serviços `@codingame` necessários
  ao editor; emular o host seria um projeto à parte, frágil a cada versão.
- **Tamanho e processo extra:** um Node embutido + a extensão aumentariam o
  bundle e o consumo de memória para obter o que o protocolo entrega com um
  socket.
- **Licença:** a extensão oficial é proprietária (termos da Anthropic), não
  uma licença que permita redistribuí-la empacotada num app GPL-3.0.
- **Identidade e desempenho:** com a ponte nativa o CLI vê "Fluent Coder", o
  diff segue o tema/atalhos do app e nada passa por camadas de emulação.

## Limitação conhecida: `claude -p`

O modo print/headless (`claude -p`, usado pelo chat da sidebar em
`stream-json`) **nunca conecta na IDE** — limitação do CLI. Por isso a ponte
**não** é ligada ao chat de agentes; ela atende o `claude` interativo
(terminal integrado ou externo na pasta do workspace).

## Consequências

- O protocolo é do CLI, não documentado publicamente: mudanças nele exigem
  repetir o protótipo/probe. O probe (`tools/claude-ide-probe/`) trava os
  formatos; o aceite final é sempre com o CLI real.
- A ponte não é servidor de linguagem: fica **fora** do "Resetar Servidores de
  Código" (reiniciar derrubaria a sessão do `claude`). Tem comando próprio na
  Paleta: "Reiniciar Integração com o Claude Code (IDE)".
- Janelas remotas (SSH) não publicam pastas: o CLI local não enxerga caminhos
  remotos.
