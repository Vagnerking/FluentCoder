# ISSUE-53 · Menus View / Go / Run / Terminal

**Épico:** [Barra de Menu estilo VSCode](../EPIC-menu-bar-vscode.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** 47, 49

## Contexto

Os menus **View**, **Go**, **Run** e **Terminal** reaproveitam toggles e handlers que já existem
em [App.tsx](../../src/App.tsx) (`setActiveView`, `setSidebarOpen`, `setPanelOpen`,
`setQuickOpenOpen`, `handleRun`). Itens que dependem de backend ainda inexistente (debug DAP real,
split/kill de terminal, run task) entram **desabilitados** (`enabled: false`). Go-to-Line e
Go-to-Definition dependem da ponte de comandos do Monaco (ISSUE-50).

## Tarefas

- [ ] **View**:
      - Explorer / Search / Git / Run → `setActiveView("explorer" | "search" | "git" | "debug")`.
      - Toggle Sidebar → `setSidebarOpen(v => !v)`.
      - Toggle Terminal / Panel → `setPanelOpen(v => !v)`.
      - Command Palette / Quick Open → `setQuickOpenOpen(true)`.
- [ ] **Go**:
      - Go to File → `setQuickOpenOpen(true)`.
      - Go to Line / Go to Definition → via `editorActionsRef` (ISSUE-50) se disponível;
        senão renderizar **desabilitado**.
- [ ] **Run**:
      - Start → `handleRun(command)` da config ativa, **ou** abrir o painel Run via
        `setActiveView("debug")`.
      - Stack de Debug real (breakpoints, step) **omitida/desabilitada** (sem DAP ainda).
- [ ] **Terminal**:
      - New Terminal → `setPanelOpen(true)`.
      - Split / Kill / Run Task → **desabilitados** (PTY único por painel hoje).
- [ ] Adicionar as definições dos menus View/Go/Run/Terminal ao modelo consumido pelo [MenuBar.tsx](../../src/components/MenuBar.tsx).

## Arquivos

- `src/App.tsx` (definições dos menus View/Go/Run/Terminal usando os toggles/handlers existentes)

## Detalhes técnicos

- Itens **sem backend** (Debug DAP, Split/Kill/Run Task) ficam `enabled: false`, seguindo o
  padrão da ISSUE-47 para itens fora de escopo.
- **Go to Line** depende da ponte de comandos do Monaco (`editorActionsRef`, ISSUE-50); sem editor
  ativo ou sem a ref, fica desabilitado.
- Reaproveitar exatamente os mesmos toggles já usados pela ActivityBar/atalhos (`setActiveView`,
  `setSidebarOpen`, `setPanelOpen`, `setQuickOpenOpen`) — sem duplicar lógica.

## Critérios de aceite

- [ ] View dispara os toggles corretos (views, sidebar, terminal, quick open).
- [ ] Go to File abre o Quick Open; Go to Line/Definition funcionam quando a ref existe, senão desabilitados.
- [ ] Run inicia a config ativa (ou abre o painel Run); stack de debug aparece desabilitada.
- [ ] Terminal abre um novo painel; Split/Kill/Run Task aparecem desabilitados.
- [ ] `tsc --noEmit` sem erros.
