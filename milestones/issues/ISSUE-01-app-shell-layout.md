# ISSUE-01 · App shell / grid de layout VSCode

**Épico:** [Fluent VSCode Layout](../EPIC-fluent-vscode-layout.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** —

## Contexto

Hoje o [App.tsx](../../src/App.tsx) tem um layout simples: title bar + (sidebar | main).
Precisamos do esqueleto de regiões do VSCode para que as demais issues encaixem cada peça:

```
┌───────────────────────────────────────────────┐
│ TitleBar                                        │
├──┬─────────────┬──────────────────────────────┤
│A │             │ Breadcrumbs                    │
│c │  Explorer   ├──────────────────────────────┤
│t │  (sidebar)  │ TabBar                         │
│i │             │ Editor                         │
│v │             ├──────────────────────────────┤
│  │             │ Terminal panel (colapsável)    │
├──┴─────────────┴──────────────────────────────┤
│ StatusBar                                       │
└───────────────────────────────────────────────┘
```

## Tarefas

- [ ] Reestruturar [App.tsx](../../src/App.tsx) para o grid acima usando CSS grid/flex.
- [ ] Criar uma camada de estado de UI (zonas visíveis: `sidebarOpen`, `panelOpen`,
      `activeView`, `panelHeight`) — manter em `App.tsx` por ora (sem store externo).
- [ ] Adicionar slot vazio para **ActivityBar** (ISSUE-02), **Breadcrumbs** (03),
      **TerminalPanel** (06) e **StatusBar** (04) — placeholders que as issues preenchem.
- [ ] Painel inferior **redimensionável** por arraste (handle entre editor e terminal) e
      **colapsável**.
- [ ] Garantir que o editor preencha o espaço restante e o Monaco faça `automaticLayout`.

## Arquivos

- `src/App.tsx` (refatorar)
- `src/styles.css` (regiões de grid)
- (novos placeholders) `src/components/ActivityBar.tsx`, `Breadcrumbs.tsx`,
  `TerminalPanel.tsx`, `StatusBar.tsx` — versões mínimas, detalhadas nas issues próprias.

## Detalhes técnicos

- Layout raiz: `display: grid` com linhas `[titlebar] auto / [body] 1fr / [statusbar] auto`.
- Body interno: `grid-template-columns: [activitybar] 48px [sidebar] auto [main] 1fr`.
- Resize do painel: handle de 4px com `onPointerDown` → `pointermove` ajustando
  `panelHeight` em px (clamp entre 80 e 70% da altura).
- Não introduzir libs de layout; manter componível.

## Critérios de aceite

- [ ] Todas as regiões existem e ficam no lugar certo, mesmo que algumas vazias.
- [ ] Painel de terminal abre/fecha e redimensiona suavemente.
- [ ] Nenhuma regressão no explorer/editor/abas existentes.
- [ ] `tsc --noEmit` limpo.
