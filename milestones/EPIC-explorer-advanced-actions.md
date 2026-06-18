# Épico: Ações Avançadas do Explorador

> **Status:** Planejado (bloqueado por features base)
> **Owner:** Vagner
> **Stack:** Tauri 2 · Rust · React 18 · TypeScript · Monaco

## Visão

Completar o menu de contexto de arquivo do VS Code com os itens que dependem de **features
base ainda inexistentes** no editor. Eles aparecem **desabilitados** no menu enquanto a
infraestrutura não existir, e cada issue documenta a dependência:

- **Abrir ao lado** (Open to the Side, Ctrl+Enter) — exige editor **dividido** (grupos de editor);
- **Open With…** — escolher como abrir (editor de texto, preview de imagem);
- Itens de **Git**: Open Changes, Select for Compare, File History, Open Timeline — exigem
  uma **diff/compare view** e uma **timeline**, que ainda não existem.

Este épico é deliberadamente separado do [Menu de Contexto do Explorador](EPIC-explorer-context-menu.md)
para não bloquear o núcleo: o menu base entrega valor mesmo com estes itens desabilitados.

## Estado atual

- **Editor único:** [App.tsx](../src/App.tsx) tem um único `activePath` e
  [EditorPane.tsx](../src/components/EditorPane.tsx) renderiza um Monaco; não há conceito de
  grupo/painel dividido. Abrir ao lado **não** é possível hoje.
- **Git:** [git.rs](../src-tauri/src/git.rs) expõe `git_status`, `git_log`, `git_blame`, etc.,
  e [GitPanel.tsx](../src/components/GitPanel.tsx) mostra histórico textual — mas **não** há
  diff/compare view nem timeline visual.
- **Open With:** não existe registro de associação de tipo de arquivo nem UI de escolha.

## Decisões

| Item | Decisão |
| --- | --- |
| Abrir ao lado | Requer refatorar o editor para **grupos** (split horizontal); item desabilitado até lá |
| Open With | Lista os modos disponíveis (texto, preview de imagem existente); extensível |
| Itens de Git | Reaproveitar `git.rs`; exigem diff view + timeline; itens desabilitados até existirem |
| Apresentação | Itens bloqueados aparecem no menu **esmaecidos** com tooltip "em breve", nunca somem |

## Fora de escopo

- Implementar a diff/compare view e a timeline completas (são features próprias, futuras).
- Editor dividido vertical ou grids NxM — apenas split simples ao lado.

## Issues

| # | Título | Camada | Depende de | Estimativa |
| --- | --- | --- | --- | --- |
| [69](issues/ISSUE-69-editor-split-open-to-side.md) | Editor dividido + Abrir ao lado | Full | feature base nova | L |
| [70](issues/ISSUE-70-explorer-open-with.md) | Open With… | Full | 56 | M |
| [71](issues/ISSUE-71-explorer-git-diff-actions.md) | Itens de Git no menu (diff/compare/history/timeline) | Full | diff view (novo) | L |

`S` = pequeno, `M` = médio, `L` = grande.

## Ordem de implementação

1. Open With (70) — menor dependência, só precisa do menu base (56).
2. Editor dividido + Abrir ao lado (69) — feature base de grupos de editor.
3. Itens de Git (71) — depois de existir diff/compare view e timeline.

## Critérios de aceite do épico

- [ ] Os itens avançados aparecem no menu de arquivo, desabilitados quando sua feature base não existe.
- [ ] Open With permite escolher entre os modos de abertura disponíveis.
- [ ] Abrir ao lado abre o arquivo num segundo grupo de editor (quando o split existir).
- [ ] Itens de Git ficam habilitados somente quando a diff view / timeline existir.
- [ ] Nenhum item avançado quebra ou trava o menu de contexto base.
- [ ] `tsc --noEmit`, `cargo check` e E2E passam.

## Riscos e notas

- O split do editor (69) é a maior peça: refatora `openFiles`/`activePath` para um modelo de
  grupos. Deve ser planejado para não regredir o fluxo de aba único atual.
- Os itens de Git dependem de uma diff view que ainda não existe; manter o acoplamento mínimo
  (o menu só dispara comandos, a view é responsabilidade da feature de diff).
