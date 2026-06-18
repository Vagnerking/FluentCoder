# ISSUE-62 · Revelar no Explorer + Abrir no Terminal

**Épico:** [Menu de Contexto do Explorador](../EPIC-explorer-context-menu.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 56 · **Status:** ⬜ Pendente

## Contexto

O menu de contexto do VS Code integra o item ao SO com duas ações: **Revelar no Explorer do Windows** (abre o gerenciador de arquivos do SO já com o item selecionado) e **Abrir no Terminal Integrado** (abre o painel de terminal numa nova sessão com a pasta como diretório de trabalho). Esta issue traz ambas para pasta e arquivo.

O componente de menu reusável existe — [TreeContextMenu.tsx](../../src/components/TreeContextMenu.tsx) (issue 56) — e o backend de terminal já está pronto: [terminal.rs](../../src-tauri/src/terminal.rs) expõe `term_create(id, cwd, cols, rows, command)` que spawna PowerShell na `cwd`, e o frontend [TerminalPanel.tsx](../../src/components/TerminalPanel.tsx) / [TerminalView.tsx](../../src/components/TerminalView.tsx) renderiza as sessões com xterm. Falta apenas a ponte de UI: registrar os itens, abrir/focar o painel e criar a sessão na cwd correta.

Para "Revelar no Explorer" não há equivalente direto pronto: é preciso um comando Rust que invoque `explorer /select,<path>` no Windows (selecionando o item), pois o plugin de opener apenas abre uma pasta/URL, sem destacar o arquivo dentro dela.

## Tarefas

- [ ] Adicionar item "Revelar no Explorer do Windows" ao menu de pasta e de arquivo via [TreeContextMenu.tsx](../../src/components/TreeContextMenu.tsx).
- [ ] Criar comando Rust `reveal_in_explorer(path: String)` em [fs_commands.rs](../../src-tauri/src/fs_commands.rs) (ou novo módulo) que, no Windows, executa `explorer /select,<path>`; validar que `path` está dentro do workspace antes de invocar.
- [ ] Expor o comando em [api.ts](../../src/api.ts) (`revealInExplorer(path)`).
- [ ] Adicionar item "Abrir no Terminal Integrado" ao menu de pasta e de arquivo.
- [ ] Resolver a `cwd`: para pasta, a própria pasta; para arquivo, a **pasta-pai**.
- [ ] Abrir/focar o [TerminalPanel.tsx](../../src/components/TerminalPanel.tsx) e criar uma nova sessão PTY via `term_create` com a `cwd` resolvida.
- [ ] Garantir Codicons do mapa central nos itens (ícone de terminal e de "abrir pasta externa").

## Arquivos

- `src/components/TreeContextMenu.tsx` (modificado — registra os itens)
- `src/components/FileExplorer.tsx` (modificado — handlers, resolução de cwd)
- `src/components/TerminalPanel.tsx` (modificado — API para abrir/focar e criar sessão na cwd)
- `src-tauri/src/fs_commands.rs` (modificado — comando `reveal_in_explorer`)
- `src-tauri/src/lib.rs` (modificado — registrar o comando no handler)
- `src/api.ts` (modificado — wrapper `revealInExplorer`)

## Detalhes técnicos

- **Revelar no Explorer:** no Windows, `Command::new("explorer").args(["/select,", &path])` — atenção que `explorer /select,<path>` espera o caminho no formato nativo (`\`); usar o `path` absoluto do nó como veio do backend. O `explorer.exe` retorna código de saída não-zero mesmo em sucesso, então **não** tratar exit code != 0 como erro fatal. Validar `path` com `validate_child_path` antes de executar, evitando revelar fora do workspace.
- **Abrir no Terminal:** o [TerminalPanel.tsx](../../src/components/TerminalPanel.tsx) deve oferecer um método imperativo (via callback/contexto/ref no App) tipo `openTerminalAt(cwd: string)` que: 1) torna o painel visível e focado; 2) gera um `id` de sessão único; 3) chama `term_create(id, cwd, cols, rows)` reusando o caminho de criação já existente das sessões; 4) seleciona a nova aba de terminal. Não duplicar a lógica de PTY — reusar o fluxo de criação de sessão que o painel já tem.
- **cwd de arquivo:** derivar a pasta-pai a partir do caminho absoluto (último separador). Manter separadores nativos.
- Tooltips e rótulos em pt-BR; Fluent 2 nos estados do item de menu.

## Critérios de aceite

- [ ] Menu de pasta e de arquivo mostram "Revelar no Explorer do Windows" e "Abrir no Terminal Integrado".
- [ ] "Revelar no Explorer" abre o Explorer do Windows com o item selecionado.
- [ ] "Abrir no Terminal" torna o painel de terminal visível e focado.
- [ ] A sessão PTY criada usa a pasta correta como cwd (pasta-pai quando o alvo é arquivo).
- [ ] `reveal_in_explorer` valida que o caminho está dentro do workspace.
- [ ] Sucesso do `explorer` não é tratado como erro apesar do exit code não-zero.
- [ ] `tsc --noEmit` e `cargo check` sem erros.
