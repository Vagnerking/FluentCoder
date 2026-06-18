# Épico: Layout completo estilo VSCode com Fluent Design (Windows 11)

> **Status:** Em andamento
> **Owner:** Vagner
> **Stack:** Tauri 2 · Rust · React 18 · TypeScript · Monaco · xterm.js

## Visão

Transformar o editor atual (file explorer + Monaco + abas) em uma réplica funcional do
layout do Visual Studio Code, com a aparência do **Fluent Design do Windows 11** (Mica,
cantos arredondados, Segoe UI Variable, paleta e estados Fluent).

A referência visual é a screenshot do "VS Code Fluent Beta" fornecida pelo usuário: barra
de título translúcida, **activity bar** de ícones à esquerda, file explorer, editor com
**breadcrumbs**, **painel de terminal** funcional embaixo e **status bar** na base.

## Estado atual (baseline)

Já implementado nas sessões anteriores:

- Janela Tauri com **Mica + transparência + barra sem decoração** (`tauri.conf.json`).
- **Barra de título customizada** ([TitleBar.tsx](../src/components/TitleBar.tsx)) com
  botões minimizar/maximizar/fechar e região arrastável.
- **File explorer** colapsável com árvore lazy ([FileExplorer.tsx](../src/components/FileExplorer.tsx),
  [TreeNode.tsx](../src/components/TreeNode.tsx)).
- **Editor Monaco** com syntax highlighting, **abas** com dirty-state e **Ctrl+S**.
- Backend Rust com comandos `read_dir` / `read_file` / `write_file`
  ([fs_commands.rs](../src-tauri/src/fs_commands.rs)).
- **CSS Fluent** base ([styles.css](../src/styles.css)).

## Escopo deste épico

Decisões já confirmadas com o usuário:

| Item | Decisão |
| --- | --- |
| Terminal | **Funcional** — PTY real (portable-pty no Rust + xterm.js no front) |
| Activity bar | **Sim** — ícones à esquerda |
| Breadcrumbs | **Sim** — caminho acima do editor |
| Status bar | **Sim** — barra inferior |
| Menu bar (File/Edit/…) | **Fora de escopo** por ora |

## Issues

| # | Título | Camada | Depende de | Estimativa |
| --- | --- | --- | --- | --- |
| [01](issues/ISSUE-01-app-shell-layout.md) | App shell / grid de layout VSCode | Front | — | M |
| [02](issues/ISSUE-02-activity-bar.md) | Activity bar (ícones laterais) | Front | 01 | S |
| [03](issues/ISSUE-03-breadcrumbs.md) | Breadcrumbs acima do editor | Front | 01 | S |
| [04](issues/ISSUE-04-status-bar.md) | Status bar inferior | Front | 01 | S |
| [05](issues/ISSUE-05-terminal-backend-pty.md) | Backend do terminal (PTY no Rust) | Rust | — | L |
| [06](issues/ISSUE-06-terminal-frontend-xterm.md) | Frontend do terminal (xterm.js + painel) | Front | 01, 05 | L |
| [07](issues/ISSUE-07-fluent-polish.md) | Polimento Fluent (Mica, foco, animações) | Front | 01–06 | M |
| [08](issues/ISSUE-08-integration-build.md) | Integração, validação e build | Full | 01–07 | M |

`S` = pequeno, `M` = médio, `L` = grande.

## Ordem de implementação sugerida

1. **05** (PTY backend) e **01** (shell) em paralelo — são as fundações independentes.
2. **02, 03, 04** (activity bar, breadcrumbs, status bar) — dependem só do shell.
3. **06** (terminal frontend) — precisa do shell e do PTY prontos.
4. **07** (polish) — depois que tudo está posicionado.
5. **08** (integração + build) — fechamento.

## Critérios de aceite do épico

- [ ] Layout idêntico em estrutura ao print: activity bar · explorer · editor (com breadcrumbs) · terminal · status bar.
- [ ] Terminal roda PowerShell de verdade (digitar `dir`, ver saída, resize funciona).
- [ ] Mica visível atrás das superfícies translúcidas; editor e terminal legíveis (opacos).
- [ ] `tsc --noEmit` e `cargo check` sem erros; app abre e fecha limpo.
- [ ] Sidebar e painel de terminal colapsáveis.

## Riscos / notas

- **PTY no Windows**: `portable-pty` usa ConPTY (Win10+). WebView2 já confirmado na máquina.
- **Transparência + Monaco/xterm**: ambos precisam de fundo opaco próprio para legibilidade;
  o Mica fica só nas superfícies de chrome (title bar, activity bar, sidebar).
- **Eventos Tauri**: o stream de saída do PTY vai do Rust pro front via `emit`/`listen`;
  exige throttling/agrupamento para não floodar a IPC.
