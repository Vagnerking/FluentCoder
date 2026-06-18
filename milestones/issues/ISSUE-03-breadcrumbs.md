# ISSUE-03 · Breadcrumbs acima do editor

**Épico:** [Fluent VSCode Layout](../EPIC-fluent-vscode-layout.md) · **Camada:** Front · **Tamanho:** S · **Depende de:** 01

## Contexto

A trilha de navegação acima do editor (no print: `pages > index.vue > template > div`).
Na primeira versão mostramos o **caminho do arquivo** relativo à pasta aberta (a parte de
símbolos — `template > div` — exige parsing da AST do Monaco e fica para depois).

## Tarefas

- [ ] Criar `src/components/Breadcrumbs.tsx`.
- [ ] Receber o caminho do arquivo ativo + a raiz aberta; renderizar segmentos do path
      relativo separados por `›` com ícone de pasta/arquivo.
- [ ] Cada segmento é clicável (por ora: segmento de arquivo foca o editor; pastas são
      no-op ou abrem no explorer — escopo mínimo: apenas exibir).
- [ ] Esconder a faixa quando não houver arquivo aberto.

## Arquivos

- `src/components/Breadcrumbs.tsx` (novo)
- `src/App.tsx` (passar `activeFile.path` e `rootPath`)
- `src/styles.css` (`.breadcrumbs`, `.crumb`)

## Detalhes técnicos

- Guardar também o **caminho absoluto da raiz** (`rootPath`) — hoje só guardamos
  `rootName`. Ajustar `App.tsx` para manter `rootPath` no estado.
- Computar relativo: `path.replace(rootPath, "")` e dividir por separador (`\` ou `/`).
- Altura ~24px, fonte 12px, `--text-muted`.

## Critérios de aceite

- [ ] Com um arquivo aberto, a trilha mostra os segmentos do caminho relativo.
- [ ] Sem arquivo, a faixa some.
- [ ] Não quebra com caminhos do Windows (`C:\...`).
