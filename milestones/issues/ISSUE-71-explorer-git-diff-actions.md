# ISSUE-71 · Ações de Git no menu de contexto do arquivo (diff/compare/history/timeline)

**Épico:** [Ações Avançadas do Explorador](../EPIC-explorer-advanced-actions.md) · **Camada:** Full · **Tamanho:** L · **Depende de:** — · **Status:** ⬜ Pendente

## Contexto

Esta issue adiciona ao menu de contexto do arquivo (explorador) um grupo de ações de Git: **Open Changes**
(diff do arquivo vs HEAD), **Select for Compare** + **Compare with Selected** (diff entre dois arquivos),
**File History** (log do arquivo) e **Open Timeline**. Essas ações reaproveitam o backend Git já existente
em [git.rs](../../src-tauri/src/git.rs) (`git_status`, `git_log`, `git_blame`...) e o painel
[GitPanel.tsx](../../src/components/GitPanel.tsx) (histórico textual).

O ponto central: **a DIFF/COMPARE VIEW e a TIMELINE ainda NÃO existem** no app — hoje há apenas o
histórico textual em [GitPanel.tsx](../../src/components/GitPanel.tsx), sem visualização de diff lado a
lado nem linha do tempo. Por isso, as ações que dependem dessas features base devem entrar
**DESABILITADAS** no menu (item esmaecido, com tooltip "em breve"), sem disparar nada, até que as features
base sejam implementadas. Marca-se "Depende de: —" porque essas bases ainda não têm issue própria; o que
falta está descrito abaixo.

O acoplamento deve ser **mínimo**: o menu apenas dispara comandos ("abrir diff de X", "comparar X com Y",
"histórico de X", "timeline de X"); ele não conhece a implementação da view nem do backend. **File History**
pode funcionar desde já reusando `git_log` filtrado pelo arquivo e o GitPanel; os demais ficam desabilitados.

## Tarefas

- [ ] Adicionar ao menu de contexto do arquivo os itens: **Open Changes**, **Select for Compare**,
      **Compare with Selected**, **File History** e **Open Timeline** (com seus codicons do mapa central).
- [ ] **File History**: reusar `git_log` de [git.rs](../../src-tauri/src/git.rs) filtrado pelo arquivo e
      exibir no [GitPanel.tsx](../../src/components/GitPanel.tsx) — esta ação **funciona** nesta issue.
- [ ] **Open Changes / Select for Compare / Compare with Selected / Open Timeline**: entrar **desabilitados**
      (esmaecidos) com tooltip "em breve", **sem** disparar comando, enquanto as features base não existirem.
- [ ] Manter o estado "Select for Compare" (arquivo memorizado) modelado, mesmo que "Compare with Selected"
      esteja desabilitado, para facilitar a ativação futura.
- [ ] Definir os comandos como handlers finos: o item só emite "comando + path(s)"; nenhuma lógica de view no menu.
- [ ] Documentar no próprio item/tooltip que a habilitação depende da Diff View / Timeline.

## Arquivos

- `src/components/TabBar.tsx` ou o componente de menu de contexto do explorador (itens de Git, modificado)
- `src/components/GitPanel.tsx` (exibir File History via `git_log` filtrado, modificado)
- `src-tauri/src/git.rs` (reuso de `git_log`/`git_blame`; novo comando para diff vs HEAD se necessário no futuro)
- `src/App.tsx` (roteamento dos comandos de Git para os destinos, modificado)
- `src/types.ts` (tipos dos comandos/estado "select for compare", modificado)

## Detalhes técnicos

- **Acoplamento mínimo**: cada item do menu apenas dispara um comando com o(s) caminho(s) do arquivo. A
  resolução (abrir GitPanel, abrir diff, etc.) é decidida fora do menu.
- **File History** (funciona já): chamar `git_log` filtrando pelo caminho do arquivo e renderizar o
  resultado em [GitPanel.tsx](../../src/components/GitPanel.tsx) (que já mostra histórico textual).
- **Itens desabilitados**: renderizar esmaecidos (como o estado `enabled: false` dos menus), com tooltip
  "em breve", e **não** disparar `run`. Não criar telas placeholder.
- O que cada feature base precisaria (fora do escopo desta issue, listado para referência):
  - **Diff/Compare View**: um componente de diff lado a lado (Monaco tem `createDiffEditor`); um comando Rust
    para obter o conteúdo do arquivo em HEAD (ex.: `git show HEAD:<path>`) e comparar com o working tree;
    para "Compare with Selected", comparar dois caminhos arbitrários. **Open Changes** e
    **Select/Compare with Selected** ligam aqui.
  - **Timeline**: uma view de linha do tempo agregando commits (via `git_log` do arquivo) e, futuramente,
    outros provedores (saves locais, etc.). **Open Timeline** liga aqui.
- Quando essas bases existirem, basta habilitar os itens e ligar os comandos aos destinos — sem mexer no menu.

## Critérios de aceite

- [ ] Os cinco itens de Git aparecem no menu de contexto do arquivo.
- [ ] **File History** abre o log do arquivo no [GitPanel.tsx](../../src/components/GitPanel.tsx) usando `git_log`.
- [ ] **Open Changes**, **Select for Compare**, **Compare with Selected** e **Open Timeline** aparecem
      esmaecidos, com tooltip "em breve", e não disparam nada.
- [ ] Nenhuma lógica de diff/timeline vive dentro do componente de menu (apenas emissão de comandos).
- [ ] O estado "Select for Compare" é modelado para ativação futura.
- [ ] `tsc --noEmit` sem erros.
