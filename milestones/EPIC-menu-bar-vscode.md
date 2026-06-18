# Épico: Barra de Menu estilo VSCode (File, Edit, Selection, View, Go, Run, Terminal, Help)

> **Status:** Planejado
> **Owner:** Vagner
> **Stack:** Tauri 2 · React 18 · TypeScript · Monaco

## Visão

Adicionar uma **barra de menu** no topo da janela, estilo VSCode, com os **8 menus**
clássicos — **File, Edit, Selection, View, Go, Run, Terminal, Help** — cada um abrindo um
**dropdown** com as ações da categoria. A barra **substitui** o atual botão "Abrir pasta"
do explorador: abrir uma pasta passa a ser feito pelo menu **File** (mais o atalho de
teclado). O MenuBar fica na **title bar customizada**, logo **após o botão de toggle da
sidebar** (à esquerda), exatamente como no VSCode.

## Estado atual (baseline)

- A janela usa `decorations: false` + efeito **Mica**; já existe uma title bar customizada
  em [TitleBar.tsx](../src/components/TitleBar.tsx) com `data-tauri-drag-region`, o toggle
  da sidebar à esquerda, o título centralizado e os window controls à direita. **O MenuBar
  entra logo após o toggle.**
- Estado e handlers ficam centralizados em [App.tsx](../src/App.tsx) (props drilling). Já
  existem: `handleOpenFolder`, `handleSave`, `handleCloseTab/All/Others`, `setSidebarOpen`,
  `setPanelOpen` (terminal), `setQuickOpenOpen` (Quick Open), `setActiveView` e `handleRun`.
- O padrão de **dropdown reusável** está em [TabBar.tsx](../src/components/TabBar.tsx)
  (`createPortal` + fechar no `mousedown` externo + Escape).
- O Monaco **não expõe** suas ações ao App (`editorRef` é privado em
  [EditorPane.tsx](../src/components/EditorPane.tsx)); **Edit/Selection** precisam de uma
  **ponte de comandos** nova, análoga ao `revealRef`.
- Atalhos globais ficam no `window.addEventListener("keydown")` em
  [App.tsx](../src/App.tsx) (Ctrl+S, Ctrl+`, Ctrl+P).
- **"Exit"** = `getCurrentWindow().close()`.

## Escopo deste épico

| Item | Decisão |
| --- | --- |
| Posição | MenuBar na title bar, após o toggle da sidebar (à esquerda) |
| Menus | Os 8 do VSCode: File, Edit, Selection, View, Go, Run, Terminal, Help |
| Botão "Abrir pasta" | **Removido completamente** — abrir pasta só via menu File + atalho |
| Dropdown | Reusa o padrão de portal/fechar-fora do TabBar; navegação por teclado + Alt |
| Edit/Selection | Via nova ponte de comandos do Monaco (ref imperativa do EditorPane) |
| Itens sem backend hoje | Aparecem **desabilitados** (fidelidade visual) ou omitidos quando a categoria inteira inexiste (ex.: Debug) |
| Untitled buffers ("New Text File") | Em escopo, mas marcado como risco; pode ser cortado p/ v2 |

## Issues

| # | Título | Camada | Depende de | Estimativa |
| --- | --- | --- | --- | --- |
| [47](issues/ISSUE-47-menubar-component-infra.md) | Componente MenuBar: modelo de dados + dropdown (portal) | Front | — | M |
| [48](issues/ISSUE-48-menubar-keyboard-a11y.md) | Navegação por teclado + Alt + acessibilidade | Front | 47 | M |
| [49](issues/ISSUE-49-menubar-titlebar-integration.md) | Integrar MenuBar na TitleBar | Front | 47 | S |
| [50](issues/ISSUE-50-editor-command-bridge.md) | Ponte de comandos do Monaco (ref do EditorPane) | Front | — | M |
| [51](issues/ISSUE-51-menu-file.md) | Menu File | Full | 47, 49 | M |
| [52](issues/ISSUE-52-menu-edit-selection.md) | Menus Edit + Selection | Front | 47, 49, 50 | M |
| [53](issues/ISSUE-53-menu-view-go-run-terminal.md) | Menus View / Go / Run / Terminal | Front | 47, 49 | M |
| [54](issues/ISSUE-54-menu-help-remove-open-button.md) | Menu Help + remover botão "Abrir pasta" | Full | 51 | S |
| [55](issues/ISSUE-55-menubar-integration-e2e.md) | Integração, atalhos e E2E | Full | todas | M |

`S` = pequeno, `M` = médio, `L` = grande.

## Ordem de implementação sugerida

1. **47 → 48 → 49** (infra do MenuBar e integração na title bar) e **50** (bridge de
   comandos do Monaco) **em paralelo** — independentes e testáveis isolados.
2. **51** (File), **52** (Edit/Selection, após 50), **53** (View/Go/Run/Terminal) e **54**
   (Help + remoção do botão "Abrir pasta").
3. **55** (integração + atalhos + E2E) por último.

**MVP mínimo:** **47 + 49 + 51 + 54** — MenuBar na title bar com o menu **File** funcional
e o botão "Abrir pasta" já removido.

## Critérios de aceite do épico

- [ ] Barra com os **8 menus** (File, Edit, Selection, View, Go, Run, Terminal, Help) na title bar.
- [ ] Dropdowns **abrem/fecham** por clique e por **Alt/teclado**.
- [ ] Menu **File** abre pasta/arquivo, salva e fecha.
- [ ] **Edit/Selection** operam sobre o **editor ativo** (via ponte de comandos do Monaco).
- [ ] **View/Go/Run/Terminal** reusam os toggles/handlers existentes.
- [ ] O botão **"Abrir pasta"** **não existe mais** no explorador.
- [ ] `tsc --noEmit` sem erros.
- [ ] Teste **E2E** (tauri-driver) cobrindo **abrir menu → Open Folder → picker**.

## Riscos / notas

- A **ponte de comandos do Monaco** (issue 50) é o bloqueio que habilita **2 menus**
  (Edit e Selection) — **priorizar**.
- **Untitled buffers** (issue 51) são invasivos: hoje todo `OpenFile` tem `path` real,
  usado como key/URI — **pode ser cortado p/ v2**.
- **Drag-region da title bar**: cliques no menu **não podem arrastar** a janela — fazer
  opt-out como já fazem os botões/window controls atuais.
- **Alt** pode colidir com comportamento do navegador/Tauri — **testar**.
- A **regra do projeto** exige **E2E com tauri-driver + WebdriverIO** (não Playwright/MCP)
  ao terminar a feature.
