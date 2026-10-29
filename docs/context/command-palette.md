# Paleta de Comandos (Command Palette)

A Paleta de Comandos é o ponto central para executar **ações** no editor, no mesmo
estilo do Quick Open de arquivos. É acionada por **Ctrl+Shift+P** (o Ctrl+P
continua sendo a busca de **arquivos**).

## Componentes

- **UI:** [`src/components/CommandPalette.tsx`](../../src/components/CommandPalette.tsx)
  — overlay flutuante e centralizado que espelha o `QuickOpen` (reusa as classes
  `quick-open-*` do CSS). Filtra por busca fuzzy ([`src/quickOpen/fuzzy.ts`](../../src/quickOpen/fuzzy.ts)),
  navega com as setas, executa no **Enter** e fecha no **Esc**.
- **Registro de comandos:** definido em [`src/App.tsx`](../../src/App.tsx) (memo
  `commands: Command[]`), onde cada comando captura o estado/ações do app. Um
  comando é `{ id, title, detail?, run }`. Adicionar um comando = um objeto novo
  nesse array.
- **Atalho:** registrado no handler de teclado do `App.tsx` (ramo
  `Ctrl+Shift+P`, antes do `Ctrl+P`). Esse handler escuta `keydown` no
  `window` (fase de bubble); para o evento chegar até ele com o editor
  focado, os keybindings padrão do VS Code para `Ctrl+Shift+P`, `Ctrl+P` e
  `F1` são **desregistrados** do Monaco em
  [`src/monaco-loader.ts`](../../src/monaco-loader.ts)
  (`monaco.editor.addKeybindingRules` com `command: null`). Sem isso, o
  editor `@codingame` abre o quick-input interno do VS Code (uma caixa vazia,
  sem providers) e engole a tecla — a paleta do app nunca abre. Não remova
  essas regras.

## Comando: "Resetar Servidores de Código"

Reinicia **todos** os servidores de linguagem/linters (LSP) e demais serviços de
análise. Útil quando um servidor "trava" (para de dar diagnósticos/autocomplete).

Implementação: `restartAll()` em
[`src/lsp/useLspManager.ts`](../../src/lsp/useLspManager.ts) —
`manager.stopAll()` derruba todos os clients, o estado (`status`/`errors`/
`workspaces`) é zerado, e os servidores das **linguagens atualmente abertas**
(`openedLanguages`, derivado das abas) são reiniciados. A StatusBar reflete o
reset (servidores passam por `starting` → `ready`), dando feedback visível.

## REGRA DE EXTENSÃO (obrigatória)

> **Sempre que um novo servidor de linguagem/linter for adicionado, ele DEVE
> continuar coberto pela rotina de reset deste comando (parar + reiniciar).**

Na prática, a cobertura é **automática** desde que o novo servidor siga a
arquitetura existente:

1. O servidor é registrado no `SERVER_REGISTRY`
   ([`src/lsp/servers/index.ts`](../../src/lsp/servers/index.ts)) e iniciado
   **através do `LspManager`** (`manager.start(...)`), nunca de forma ad-hoc.
2. Assim, `manager.stopAll()` o derruba junto com os demais, e — se houver um
   arquivo da sua linguagem aberto — ele volta via `openedLanguages`.

Ao adicionar um servidor que **não** passe pelo `LspManager` (ex.: um processo
iniciado por fora), é obrigatório incluí-lo explicitamente no `restartAll()`
(parada + reinício), para que o reset continue cobrindo 100% dos servidores.

### Exceção: ponte IDE do Claude Code

A ponte IDE do Claude Code (`src-tauri/src/agents/ide_bridge.rs`, ver
[ADR 0006](../adr/0006-claude-ide-bridge.md)) **não** é servidor de
linguagem/linter e fica fora deste reset: reiniciá-la derrubaria a sessão do
`claude` conectado sem ganho para os diagnósticos. Ela tem comando próprio,
**"Reiniciar Integração com o Claude Code (IDE)"** (`claude.restartIdeBridge`),
que troca porta e token e regrava o lock file.

### Exceção: agentes do Fluent Chat (Claude, Codex, ACP)

Os processos dos agentes de IA do Fluent Chat (`claude` stream-json,
`codex app-server` e os CLIs ACP — Gemini, opencode, Qwen Code, Copilot CLI,
Goose…) **não** são servidores de linguagem/linter e ficam fora deste reset:
derrubá-los interromperia um turno em andamento sem ganho para os
diagnósticos. Eles têm comando próprio, **"Fluent Chat: Reiniciar Agentes de
IA"** (`fluentChat.restartAgents` → `acp_stop_all`), que mata todos os
workers; o próximo envio sobe o processo de novo e retoma a sessão nativa.
Todo provedor novo entra pelo registro (`src-tauri/src/agents/registry.rs`) e
fica coberto automaticamente por esse comando. O servidor MCP de conhecimento
(`fluent-coder --mcp`) é filho de cada CLI e morre com ele.

### Exceção: host de extensões VS Code

O host de extensões (`tools/ext-host` + `src-tauri/src/ext_host/`, ver
[Extensões VS Code](extensoes-vscode.md)) também **não** é servidor de
linguagem: fica fora do "Resetar Servidores de Código" (derrubaria as
conversas do Claude Code/Codex). Comandos próprios, montados em
`paletteCommands` no `App.tsx`:

- **"Reiniciar Host de Extensões"** (`extensions.restartHost`) — encerra o
  sidecar (as extensões fazem `deactivate`), sobe de novo e reativa as que
  estavam ativas; as views se re-resolvem sozinhas.
- **"Extensões: Mostrar Saída do Host"** — aba Saída, canal "Extensões".
- **"Extensões: Mostrar Extensões"** / **"Extensões: Checar Atualizações"** —
  abrem a view Extensões (a 2ª força a checagem no catálogo).
- **Comandos contribuídos** pelas extensões suportadas (`contributes.commands`,
  sem os escondidos por `menus.commandPalette` com `when: false`), com o
  título do `package.json` (ex.: "Claude Code: Open in Terminal", "Codex: New
  Chat…"). Executar ativa a extensão se preciso (como o `onCommand` do VS
  Code). Gerados por `extensionPaletteCommands()` (`src/extensions/index.ts`).

## Temas

"Preferências: Tema de Cores", "Preferências: Tema de Ícones de Arquivo" e
"Preferências: Tema de Ícones do Produto" (`themePaletteCommands()` em
`src/theme/ThemePicker.tsx`) abrem o seletor do `themeRegistry` com prévia ao
vivo nas setas (Enter salva, Esc restaura). Ver [Temas](temas.md).

## Como estender com novos comandos

Adicione uma entrada ao array `commands` em `App.tsx`:

```ts
{
  id: "meu.comando",
  title: "Título mostrado e filtrado",
  detail: "Categoria (opcional)",
  run: () => { /* ação */ },
}
```

Nada mais é necessário — a paleta já lista, filtra e executa o novo comando.
