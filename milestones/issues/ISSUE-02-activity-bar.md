# ISSUE-02 · Activity bar (ícones laterais)

**Épico:** [Fluent VSCode Layout](../EPIC-fluent-vscode-layout.md) · **Camada:** Front · **Tamanho:** S · **Depende de:** 01

## Contexto

A barra vertical fina na extrema esquerda do VSCode, com ícones que trocam a view da
sidebar. No print: explorer, search, source control, run/debug, extensions; e embaixo
conta + settings.

## Tarefas

- [ ] Criar `src/components/ActivityBar.tsx` com largura fixa (48px).
- [ ] Ícones (SVG inline, estilo Fluent line-icons): Explorer, Search, Source Control,
      Run & Debug, Extensions. Embaixo: Account, Settings.
- [ ] Estado `activeView` controla qual ícone está ativo (barra de destaque à esquerda do
      ícone ativo, como no VSCode).
- [ ] Clicar no ícone ativo **alterna** (colapsa/expande) a sidebar; clicar em outro troca a view.
- [ ] Por ora **só o Explorer tem conteúdo**; os demais mostram um placeholder "em breve"
      na sidebar (não quebrar, só não implementados).

## Arquivos

- `src/components/ActivityBar.tsx` (novo)
- `src/App.tsx` (ligar `activeView` + toggle da sidebar)
- `src/styles.css` (`.activity-bar`, `.activity-item`, indicador ativo)

## Detalhes técnicos

- Ícone ativo: pseudo-elemento `::before` com barra de 2px na cor de acento à esquerda.
- Acessibilidade: cada item é `<button>` com `aria-label` e `title`.
- Hover: `--fill-subtle-hover`; ativo: ícone em `--text`, inativos em `--text-muted`.

## Critérios de aceite

- [ ] Activity bar renderiza com os ícones e o indicador de ativo.
- [ ] Clicar alterna a view/sidebar conforme descrito.
- [ ] Visual consistente com o print (espaçamento, tamanho ~24px de ícone).
