# ISSUE-39 · Codicons: mapa central + componente

**Épico:** [Icon Pack — Material + Codicons](../EPIC-icon-pack-monaco.md) · **Camada:** Front · **Tamanho:** S · **Depende de:** — · **Status:** ✅ Concluída

## Contexto

A interface usava SVGs desenhados à mão (activity bar) e glyphs unicode (✕ ⚠ ⎇ ↻
↓ ↑ ✓). Queremos **Codicons** (set do VS Code) via um mapeamento central
ação → ícone, para trocar um glyph em um só lugar.

## Tarefas

- [x] Adicionar dependência `@vscode/codicons` (MIT).
- [x] `codicon-map.ts`: tipo `IconAction` (todas as ações/estados da UI) + objeto
      `CODICON_MAP` (ação → nome do codicon) + set `SPINNING` (loading).
- [x] `Codicon.tsx`: `<Codicon name size spin title />`, importando `codicon.css`
      uma única vez. Cor/tamanho herdam do texto (`currentColor`/`font-size`).

## Arquivos

- `src/icons/codicons/codicon-map.ts` (novo)
- `src/icons/codicons/Codicon.tsx` (novo)

## Detalhes técnicos

- Todos os nomes do mapa foram validados contra as 649 classes `.codicon-*` reais
  do pacote (sem typos).
- `aria-hidden` quando sem `title`; `role="img"` + `aria-label` quando houver.

## Critérios de aceite

- [x] `<Codicon name="save" />` renderiza `<span class="codicon codicon-save">`.
- [x] Mapa cobre: ações de arquivo, busca, run/debug, terminal, git, diagnósticos,
      code actions/navegação e chrome (activity bar, chevrons, close).
- [x] Importar `Codicon` é tudo que uma tela precisa para usar qualquer ícone de UI.
- [x] `tsc --noEmit` sem erros.
