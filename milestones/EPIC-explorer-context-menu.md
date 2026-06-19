# Épico: Menu de Contexto do Explorador

> **Status:** Planejado
> **Owner:** Vagner
> **Stack:** Tauri 2 · Rust · React 18 · TypeScript · Monaco

## Visão

Trazer ao Explorador de Arquivos o menu de contexto (clique direito) do VS Code, tanto
sobre **pastas** quanto sobre **arquivos**, com as operações essenciais de manutenção da
árvore e seus atalhos de teclado:

- **Novo arquivo / Nova pasta** (já existem no cabeçalho; expostas também no menu);
- **Renomear** (inline, **F2**);
- **Excluir** para a Lixeira do sistema (**Del**), com confirmação;
- **Recortar / Copiar / Colar** arquivos e pastas (**Ctrl+X / Ctrl+C / Ctrl+V**);
- **Copiar caminho** (Shift+Alt+C) e **Copiar caminho relativo** (Ctrl+K Ctrl+Shift+C);
- **Revelar no Explorer do Windows** e **Abrir no Terminal Integrado**;
- **Localizar na pasta** (busca escopada);
- Navegação por teclado: **Enter** abre o arquivo selecionado, setas navegam.

As ações usam Codicons, textos e tooltips em português, funcionam por teclado e preservam
os contratos visuais e de acessibilidade do Fluent 2 documentados em
[docs/design/fluent-design.md](../docs/design/fluent-design.md).

## Estado atual

- [FileExplorer.tsx](../src/components/FileExplorer.tsx) centraliza `selectedDirectory`,
  `expandedPaths` e `refreshVersion`, e expõe o componente `InlineCreation` para entrada
  inline de nome (reutilizável por **Renomear**).
- [TreeNode.tsx](../src/components/TreeNode.tsx) renderiza as linhas da árvore, mas **não**
  tem `onContextMenu` nem foco/seleção por teclado.
- [TabBar.tsx](../src/components/TabBar.tsx) já implementa um menu de contexto via
  `createPortal` que fecha em mousedown externo / **Esc** — o padrão a reusar.
- [fs_commands.rs](../src-tauri/src/fs_commands.rs) tem `validate_child_path`, `entry_for`,
  `create_file` e `create_folder`, mas **não** tem renomear, excluir, copiar ou mover.
- [terminal.rs](../src-tauri/src/terminal.rs) (`term_create(id, cwd, …)`) e
  [search.rs](../src-tauri/src/search.rs) (`search_in_dir(root, query)`) já existem.
- Não há clipboard de texto nem componente de modal de confirmação (só `window.alert`).

## Decisões

| Item | Decisão |
| --- | --- |
| Componente de menu | Genérico e reusável (portal, itens/separadores/disabled, submenu), seguindo o padrão do TabBar |
| Alvo do menu | Pasta e arquivo, com conjuntos de itens diferentes por tipo |
| Renomear | Campo inline reusando `InlineCreation`; confirma com Enter, cancela com Esc; **F2** |
| Excluir | Mover para a **Lixeira do SO** (recuperável) via crate `trash`; sempre confirmar em modal; **Del** |
| Recortar/Copiar/Colar | Clipboard interno do app (caminho + modo cut/copy); colar resolve colisão sem sobrescrever; **Ctrl+X/C/V** |
| Copiar caminhos | Clipboard do SO; absoluto (Shift+Alt+C) e relativo à raiz (Ctrl+K Ctrl+Shift+C) |
| Integração SO/terminal | "Revelar no Explorer" abre o shell do SO; "Abrir no Terminal" reusa `term_create` com a cwd |
| Localizar na pasta | Reaproveita SearchPanel/`search_in_dir`, escopado à pasta clicada |
| Navegação | Enter abre, setas movem, Del/F2 só quando a árvore tem foco |
| Validação | Sempre confirmar no backend que origem e destino ficam dentro do workspace |
| Ícones | Codicons do mapa central; nenhum SVG avulso |

## Fora de escopo

- **Abrir ao lado** (split do editor), **Open With** e itens de **Git** (Publish, Open
  Changes, Select for Compare, File History, Open Timeline) — tratados no
  [Épico de Ações Avançadas](EPIC-explorer-advanced-actions.md); aparecem aqui apenas como
  itens **desabilitados/futuros** no menu.
- Watcher automático do sistema de arquivos.
- Operações em lote (multi-seleção de itens da árvore).

## Issues

| # | Título | Camada | Depende de | Estimativa |
| --- | --- | --- | --- | --- |
| [56](issues/ISSUE-56-explorer-context-menu-infra.md) | Componente de menu de contexto (infra) | Front | — | M |
| [57](issues/ISSUE-57-fs-mutation-commands.md) | Comandos Rust de mutação (rename/delete/copy/move) | Rust | — | M |
| [58](issues/ISSUE-58-explorer-rename.md) | Renomear inline + F2 | Full | 56, 57 | M |
| [59](issues/ISSUE-59-explorer-delete.md) | Excluir para Lixeira + Del | Full | 56, 57, 66 | M |
| [60](issues/ISSUE-60-explorer-cut-copy-paste.md) | Recortar / Copiar / Colar | Full | 56, 57 | L |
| [61](issues/ISSUE-61-explorer-copy-paths.md) | Copiar caminho e caminho relativo | Full | 56 | S |
| [62](issues/ISSUE-62-explorer-os-terminal-actions.md) | Revelar no Explorer + Abrir no Terminal | Full | 56 | M |
| [63](issues/ISSUE-63-explorer-find-in-folder.md) | Localizar na pasta | Full | 56 | M |
| [64](issues/ISSUE-64-explorer-keyboard-nav.md) | Navegação por teclado (Enter/setas) | Front | 56, 58, 59 | M |
| [65](issues/ISSUE-65-explorer-context-menu-integration.md) | Integração, a11y, build e E2E | Full | 56–64 | M |

`S` = pequeno, `M` = médio, `L` = grande.

## Ordem de implementação

1. Componente de menu de contexto (56) e comandos Rust de mutação (57) em paralelo.
2. Renomear (58), apoiado no inline existente.
3. Excluir (59) — depende do `ConfirmDialog` do [Épico de Não-Salvo](EPIC-unsaved-changes-guard.md) (66).
4. Recortar/Copiar/Colar (60) e Copiar caminhos (61).
5. Ações de SO/terminal (62) e Localizar na pasta (63).
6. Navegação por teclado (64).
7. Integração, montagem dos menus pasta×arquivo, acessibilidade, build e E2E (65).

## Critérios de aceite do épico

- [ ] Clique direito em pasta e em arquivo abre menus com os itens corretos por tipo.
- [ ] Renomear (F2), Excluir (Del), Recortar/Copiar/Colar (Ctrl+X/C/V) funcionam pelo menu e pelo atalho.
- [ ] Excluir move para a Lixeira do SO e sempre pede confirmação.
- [ ] Copiar caminho e caminho relativo colocam o texto correto no clipboard do SO.
- [ ] Revelar no Explorer e Abrir no Terminal abrem na pasta/arquivo correto.
- [ ] Localizar na pasta abre a busca escopada à pasta clicada.
- [ ] Enter abre o arquivo selecionado; navegação por teclado é previsível.
- [ ] Itens fora de escopo aparecem desabilitados, sem quebrar o menu.
- [ ] Estados rest, hover, pressed, focus e disabled seguem o guia Fluent 2.
- [ ] `tsc --noEmit`, testes unitários, `cargo check`/`cargo test` e E2E passam.

## Riscos e notas

- Renomear/mover precisam revalidar no backend que origem **e** destino permanecem dentro do
  workspace (reusar `validate_child_path`), evitando escapar com `..`.
- Excluir para a Lixeira depende do crate `trash`; em falha, **nunca** cair para remoção
  permanente silenciosa — reportar erro.
- Colar deve resolver colisão de nome (ex.: sufixo "cópia") sem sobrescrever arquivos.
- Atalhos globais (Del/F2/Ctrl+*) só podem disparar quando o foco está na árvore, para não
  conflitar com o editor Monaco.
