# claude-ide-probe — aceite da ponte IDE do Claude Code

Probe headless que faz o papel do CLI `claude` contra a ponte IDE do Fluent
Coder (`src-tauri/src/agents/ide_bridge.rs`, decisão no
[ADR 0006](../../docs/adr/0006-claude-ide-bridge.md)). Não substitui o teste
com o CLI real, mas trava os formatos que ele consome.

O que verifica:

- **lock file** `~/.claude/ide/<porta>.lock` (ou `$CLAUDE_CONFIG_DIR/ide`) do
  Fluent Coder cobrindo o workspace: `transport: "ws"`, token de 128 bits em
  hex, pastas absolutas, `runningInWindows` coerente e permissão `0600`;
- **autenticação**: token errado, sem token e header `Origin` são recusados;
  token correto conecta;
- **protocolo**: `initialize` (eco do `protocolVersion`, `serverInfo.name`),
  `tools/list` com todas as ferramentas que o CLI usa, e `tools/call` de
  `getWorkspaceFolders`, `getDiagnostics` (com e sem `uri`, faixas 0-based),
  `getOpenEditors`, `getCurrentSelection`, `closeAllDiffTabs`, ferramenta
  desconhecida (`isError`) e `prompts/list`.

Não chama `openDiff`/`openFile`/`saveDocument` (exigem ação na UI).

## Rodar contra o app

1. Abra a pasta no Fluent Coder (`npm run tauri dev` ou o app instalado).
2. Rode, com Node >= 22 (usa o `WebSocket` global, que aceita headers):

```bash
node tools/claude-ide-probe/probe.mjs /caminho/da/pasta/aberta
# porta específica (vários Fluent Coder abertos):
node tools/claude-ide-probe/probe.mjs /caminho/da/pasta --port 41234
```

Sai com código `0` e `N/N verificações passaram.` quando tudo confere.

## Rodar sem o app (servidor real, lock file isolado)

Um teste `#[ignore]` sobe a ponte real com o lock file num diretório
temporário (não toca em `~/.claude`) e publica um workspace + diagnóstico por
30 s:

```bash
# na raiz do repositório
cfg=$(mktemp -d); root=$PWD
(cd src-tauri && cargo test --lib ide_bridge --no-run)   # compila antes
(cd src-tauri && FC_PROBE_CONFIG_DIR=$cfg FC_PROBE_WORKSPACE=$root \
  cargo test --lib probe_harness -- --ignored --nocapture) &
sleep 3
CLAUDE_CONFIG_DIR=$cfg node tools/claude-ide-probe/probe.mjs "$root"
```

## Aceite com o CLI real

O probe não substitui o teste manual: no terminal integrado do Fluent Coder,
rode `claude` na pasta aberta, confira `/ide` (deve listar "Fluent Coder"),
selecione um trecho e peça uma edição — o diff tem de abrir no editor com
Aceitar/Rejeitar.
