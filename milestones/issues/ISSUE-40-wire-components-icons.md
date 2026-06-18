# ISSUE-40 · Aplicar ícones nos componentes + decorations

**Épico:** [Icon Pack — Material + Codicons](../EPIC-icon-pack-monaco.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** 38, 39 · **Status:** ✅ Concluída

## Contexto

Com a camada Material e os Codicons prontos, plugar nos componentes — e mostrar o
**estado do arquivo** (modificado/novo/erro/warning/conflito) como o VS Code:
cor do label + badge git, derivado de `git status` + diagnósticos do Monaco.

## Tarefas

- [x] `decorations.ts`: `buildDecorations(rootPath, gitStatus, problems)` →
      `Map<path, FileDecoration>`; diagnóstico tem precedência sobre git.
- [x] Tipo `FileDecoration` em [types.ts](../src/types.ts).
- [x] `App.tsx`: buscar `gitStatus` ao abrir pasta; `useMemo` das decorations;
      passar `decorationFor` para Explorer e TabBar.
- [x] **Material** em: TreeNode (arquivo/pasta + chevron Codicon), TabBar,
      SearchPanel (por arquivo), QuickOpen (por resultado), GitPanel (linhas).
- [x] **Codicons** em: ActivityBar (substitui os 6 SVGs), StatusBar (branch/erro/
      warning), ProblemsPanel (severidade), GitPanel (fetch/pull/push/commit/
      stage/unstage/histórico).
- [x] CSS: wrapper `.file-icon`, alinhamento de `.codicon`, cores `.deco-*`,
      badge `.tree-badge`, dirty-dot da aba.

## Arquivos

- `src/icon-theme/decorations.ts` (novo), `src/types.ts`
- `src/App.tsx`, `src/components/{TreeNode,FileExplorer,TabBar,ActivityBar,StatusBar,ProblemsPanel,GitPanel,SearchPanel,QuickOpen}.tsx`
- `src/styles.css`

## Detalhes técnicos

- `decorationFor` normaliza separadores (`\` → `/`) para casar paths do git
  (relativos à raiz) com os absolutos do explorer.
- Caminhos do git são juntados com `rootPath`; diagnósticos já são absolutos.

## Critérios de aceite

- [x] Explorer/abas mostram ícone Material correto; activity bar usa Codicons.
- [x] Arquivo modificado/novo/erro aparece colorido com badge git.
- [x] Status bar e Problems usam Codicons de diagnóstico.
- [x] `tsc --noEmit` sem erros; nada de ícone hard-coded nos componentes.
