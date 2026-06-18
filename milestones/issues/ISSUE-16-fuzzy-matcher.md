# ISSUE-16 · Fuzzy matcher + scoring (front)

**Épico:** [Quick Open — busca de arquivos (Ctrl+P)](../EPIC-quick-open-file-search.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** —

## Contexto

O coração do Quick Open é o **fuzzy match**: digitar `aptsx` deve casar `App.tsx`, `idxnd`
deve casar `index.d.ts`, etc. — subsequência com pontuação que privilegia matches no começo
da palavra, em camelCase e após separadores, como o VSCode. Implementamos isso puro em TS,
sem dependência externa, para manter o bundle enxuto e ter controle do ranking.

## Tarefas

- [ ] Criar `src/quickOpen/fuzzy.ts` com `fuzzyMatch(query, target)` →
      `{ score: number; positions: number[] } | null` (null = não casou).
- [ ] Match por **subsequência** case-insensitive (todas as letras da query em ordem).
- [ ] Scoring com bônus para: início do nome, início de palavra (após `/`, `_`, `-`, `.`),
      transição camelCase, e caracteres consecutivos; penalidade para gaps.
- [ ] Match priorizando o **nome do arquivo** sobre o caminho, mas permitindo casar no
      caminho relativo (ex.: `comp/btn` casa `src/components/Button.tsx`).
- [ ] `positions` (índices casados) para o highlight em negrito na UI (ISSUE-17).
- [ ] `rankFiles(query, files)` → lista ordenada por score desc, com desempates estáveis
      (nome mais curto, match mais cedo). Query vazia = ordem natural / recém-abertos.
- [ ] Testes unitários cobrindo os casos acima (`aptsx`→`App.tsx`, ordenação, no-match).

## Arquivos

- `src/quickOpen/fuzzy.ts` (novo)
- `src/quickOpen/fuzzy.test.ts` (novo) — ou em `tests/` conforme o setup do projeto

## Detalhes técnicos

- Função pura, sem React — fácil de testar isolada e de chamar a cada tecla.
- Performance: para milhares de itens, evitar alocações desnecessárias; um filtro rápido
  (subsequência) antes do scoring detalhado ajuda. Limitar a saída exibida no topo (top N)
  é responsabilidade da UI, mas o rank completo pode ser computado aqui.
- Sem libs externas (sem `fuse.js` etc.) por ora — manter dependência zero.

## Critérios de aceite

- [ ] `fuzzyMatch` casa subsequências e retorna `null` quando não casa.
- [ ] Ranking coloca o match "óbvio" no topo (ex.: `app` → `App.tsx` antes de `mapper.ts`).
- [ ] `positions` permite destacar exatamente as letras casadas.
- [ ] Testes passam; sem dependências novas no `package.json` além de dev/test.
