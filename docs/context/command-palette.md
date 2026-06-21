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
  `Ctrl+Shift+P`, antes do `Ctrl+P`).

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
