# Épico: Quick Open — busca de arquivos por nome (Ctrl+P)

> **Status:** Concluído
> **Owner:** Vagner
> **Stack:** Tauri 2 · Rust · React 18 · TypeScript

## Visão

Adicionar um **Quick Open** estilo VSCode: ao pressionar **Ctrl+P** (Cmd+P no Mac), abre
uma palette flutuante no topo-centro da janela onde o usuário digita parte do **nome de um
arquivo** e vê, em tempo real, a lista de arquivos do projeto que combinam (fuzzy match),
ordenados por relevância. Setas ↑/↓ navegam, **Enter** abre o arquivo na aba, **Esc**
fecha. É o atalho mais usado do VSCode para pular entre arquivos sem caçar na árvore.

## Distinção importante

O projeto **já tem** uma busca — mas é de **conteúdo** (grep dentro dos arquivos), exposta
no [SearchPanel.tsx](../src/components/SearchPanel.tsx) via o comando Rust `search_in_dir`
([search.rs](../src-tauri/src/search.rs)).

Este épico é **outra coisa**: busca pelo **caminho/nome do arquivo**, não pelo conteúdo.
São features irmãs no VSCode (Ctrl+Shift+F = conteúdo; Ctrl+P = nome). Vamos construir um
índice de caminhos próprio e um matcher fuzzy — **não** reaproveitar `search_in_dir`, que
lê o conteúdo de cada arquivo e seria lento demais para um índice de nomes.

## Estado atual (baseline)

- Atalhos globais já existem no padrão `window.addEventListener("keydown")` em
  [App.tsx:166-179](../src/App.tsx#L166-L179) (Ctrl+S salva, Ctrl+` alterna terminal).
  **Ctrl+P entra no mesmo lugar.**
- Abrir arquivo já é centralizado em `handleOpenFile(node, line?)`
  ([App.tsx:99-128](../src/App.tsx#L99-L128)) — o Quick Open só precisa chamar isso com um
  `FileNode` (`{ name, path, isDir: false }`).
- A raiz do workspace está em `rootPath` ([App.tsx:45](../src/App.tsx#L45)).
- Backend Rust já varre diretórios pulando pastas pesadas (`SKIP_DIRS` em
  [search.rs:20-28](../src-tauri/src/search.rs#L20-L28)) — reusaremos essa lista de skip.
- Comandos Rust são registrados no `invoke_handler` de
  [lib.rs](../src-tauri/src/lib.rs) e expostos no front por [api.ts](../src/api.ts).

## Escopo deste épico

Decisões a confirmar/assumidas (defaults marcados):

| Item | Decisão |
| --- | --- |
| Gatilho | **Ctrl+P / Cmd+P** abre; **Esc** fecha |
| Match | **Fuzzy** por nome de arquivo (subsequência, como o VSCode) — não só `contains` |
| Ordenação | Por score do fuzzy; desempate por nome mais curto / match mais no começo |
| Escopo do índice | Arquivos sob `rootPath`, pulando `SKIP_DIRS` (node_modules, .git, target…) |
| Construção do índice | No **Rust**, comando `list_project_files(root)` retornando os caminhos |
| Cache/invalidação | **Fora de escopo** por ora — reconstrói o índice ao abrir a palette |
| Busca por símbolo (Ctrl+Shift+O), `@`, `:linha`, `>comando` | **Fora de escopo** por ora |

## Issues

| # | Título | Camada | Depende de | Estimativa |
| --- | --- | --- | --- | --- |
| [15](issues/ISSUE-15-file-index-backend.md) | Índice de arquivos do projeto (Rust) | Rust | — | M |
| [16](issues/ISSUE-16-fuzzy-matcher.md) | Fuzzy matcher + scoring (front) | Front | — | M |
| [17](issues/ISSUE-17-quick-open-palette-ui.md) | Palette Quick Open + Ctrl+P (UI) | Front | 15, 16 | M |
| [18](issues/ISSUE-18-quick-open-integration.md) | Integração, polimento e E2E | Full | 15–17 | S |

`S` = pequeno, `M` = médio, `L` = grande.

## Ordem de implementação sugerida

1. **15** (índice Rust) e **16** (matcher fuzzy) em paralelo — independentes e testáveis isolados.
2. **17** (palette + atalho) — junta o índice e o matcher numa UI.
3. **18** (integração + E2E) — fechamento, performance em projeto grande e teste E2E.

## Critérios de aceite do épico

- [ ] **Ctrl+P** abre a palette; **Esc** / clicar fora fecha; foco já no input.
- [ ] Digitar filtra arquivos do projeto por nome com **fuzzy match**, atualizando ao vivo.
- [ ] ↑/↓ navegam, **Enter** abre o arquivo selecionado na aba (reusa `handleOpenFile`).
- [ ] `node_modules`, `.git`, `target` etc. **não** aparecem nos resultados.
- [ ] Sem projeto aberto (`rootPath` null), o atalho não quebra (no-op ou aviso discreto).
- [ ] `tsc --noEmit` e `cargo check` sem erros.
- [ ] Teste **E2E** (tauri-driver) cobrindo abrir → digitar → Enter → arquivo abre.

## Riscos / notas

- **Projetos grandes**: listar milhares de caminhos pode pesar. O índice vem do Rust de uma
  vez; o fuzzy roda no front. Se travar, paginar/limitar (ex.: top 100 exibidos) e medir.
- **Reuso de skip-dirs**: extrair `SKIP_DIRS` de [search.rs](../src-tauri/src/search.rs)
  para um módulo comum em vez de duplicar a lista nos dois comandos.
- **E2E obrigatório**: pela regra do projeto, ao terminar a feature rodar `tauri build` +
  tauri-driver (ver memória do projeto); não usar Playwright/MCP.
