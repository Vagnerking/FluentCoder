# ISSUE-17 · Palette Quick Open + Ctrl+P (UI)

**Épico:** [Quick Open — busca de arquivos (Ctrl+P)](../EPIC-quick-open-file-search.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** 15, 16

## Contexto

A UI do Quick Open: uma palette flutuante no topo-centro da janela (como o VSCode), com um
input e a lista de resultados. Abre com **Ctrl+P**, filtra ao vivo usando o índice
(ISSUE-15) e o fuzzy matcher (ISSUE-16), e abre o arquivo escolhido reusando o
`handleOpenFile` já existente.

## Tarefas

- [ ] Criar `src/components/QuickOpen.tsx` — overlay modal centrado no topo, input + lista.
- [ ] Estado em [App.tsx](../src/App.tsx): `quickOpenOpen` + handler de toggle.
- [ ] Atalho: no mesmo `onKeyDown` global de [App.tsx:166-179](../src/App.tsx#L166-L179),
      tratar `(ctrl||meta) && key === "p"` → `preventDefault()` + abrir a palette.
      **Esc** fecha; clicar no backdrop fecha.
- [ ] Ao abrir: chamar `listProjectFiles(rootPath)` (novo wrapper em
      [api.ts](../src/api.ts)) e guardar o índice; focar o input automaticamente.
- [ ] A cada tecla: rodar `rankFiles(query, index)` e exibir o **top N** (ex.: 100).
- [ ] Cada item: nome do arquivo em destaque, caminho relativo esmaecido ao lado, ícone
      opcional; **highlight** das letras casadas usando `positions`.
- [ ] Navegação: ↑/↓ movem a seleção (com wrap), **Enter** abre o item selecionado via
      `handleOpenFile({ name, path, isDir: false })`, clique também abre.
- [ ] Sem `rootPath` (nenhum projeto aberto): não abrir ou mostrar estado vazio discreto.

## Arquivos

- `src/components/QuickOpen.tsx` (novo)
- `src/App.tsx` (estado, atalho Ctrl+P, render condicional da palette)
- `src/api.ts` (`listProjectFiles(root)` chamando `invoke("list_project_files")`)
- `src/types.ts` (tipo `ProjectFile`)
- `src/styles.css` (`.quick-open`, backdrop, item, seleção, highlight)

## Detalhes técnicos

- Estilo Fluent consistente com o resto: superfície translúcida/acrílico, cantos
  arredondados, mesma paleta (`--text`, `--text-muted`, acento) usada na activity bar.
- Acessibilidade: input com `aria-label`; lista com `role="listbox"`/`option` e
  `aria-selected`; rolagem mantém o item selecionado visível.
- Debounce não é estritamente necessário (fuzzy é rápido), mas manter a render do top N
  limitada para listas grandes.
- Fechar sempre reseta query e seleção para a próxima abertura.

## Critérios de aceite

- [ ] Ctrl+P abre a palette com foco no input; Esc / clique fora fecham.
- [ ] Digitar filtra e ranqueia ao vivo; letras casadas aparecem destacadas.
- [ ] ↑/↓ + Enter abrem o arquivo na aba (reusa `handleOpenFile`); clique também.
- [ ] Visual coerente com o tema Fluent do app.
