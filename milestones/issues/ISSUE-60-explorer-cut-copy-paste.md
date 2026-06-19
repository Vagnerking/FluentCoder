# ISSUE-60 · Recortar / Copiar / Colar no Explorador

**Épico:** [Menu de Contexto do Explorador](../EPIC-explorer-context-menu.md) · **Camada:** Full · **Tamanho:** L · **Depende de:** 56, 57 · **Status:** ⬜ Pendente

## Contexto

Esta issue entrega as operações de **Recortar**, **Copiar** e **Colar** de arquivos e pastas no Explorador, completando o conjunto de mutações do menu de contexto. Os gatilhos são itens no menu de contexto (ISSUE-56) **e** os atalhos **Ctrl+X / Ctrl+C / Ctrl+V** quando a árvore tem foco.

O clipboard é **interno ao app** (não usa o clipboard do SO): um estado que guarda o caminho de origem e o modo (`cut` | `copy`). Copiar/Recortar apenas registra a origem e o modo; a operação real acontece no **Colar**, sobre a pasta atualmente selecionada ([FileExplorer.tsx](../../src/components/FileExplorer.tsx), `selectedDirectory`).

Ao colar: modo `copy` chama `copy_path`; modo `cut` chama `move_path` e, em sucesso, **limpa** o clipboard (a origem deixou de existir). Colar pasta é **recursivo** (já tratado no backend, ISSUE-57). Colisões de nome são resolvidas sem sobrescrever (ex.: sufixo " - Cópia"). Depois da operação, a árvore é atualizada via `refreshVersion`. Os atalhos só disparam quando a árvore tem foco, para **não** conflitar com os atalhos do Monaco (recortar/copiar/colar de texto).

## Tarefas

- [ ] Adicionar itens "Recortar" (`Ctrl+X`), "Copiar" (`Ctrl+C`) e "Colar" (`Ctrl+V`) ao menu de contexto (ISSUE-56).
- [ ] Estado de clipboard interno em [FileExplorer.tsx](../../src/components/FileExplorer.tsx): `{ path: string, mode: "cut" | "copy" } | null`.
- [ ] "Recortar"/"Copiar" gravam a origem e o modo no clipboard interno (sem tocar o disco).
- [ ] "Colar" sobre a pasta selecionada (`selectedDirectory`): `copy_path` (modo copy) ou `move_path` (modo cut).
- [ ] Em modo `cut` bem-sucedido, **limpar** o clipboard após colar.
- [ ] Resolver colisão de nome sem sobrescrever (sufixo " - Cópia"); colar pasta é recursivo.
- [ ] "Colar" fica `enabled: false` quando o clipboard está vazio.
- [ ] Indicar visualmente o item recortado (esmaecido) enquanto está no clipboard em modo `cut`.
- [ ] Atalhos **Ctrl+X / Ctrl+C / Ctrl+V** só disparam com a árvore em foco (não conflitar com o Monaco).
- [ ] Atualizar a árvore via `refreshVersion` após a operação.

## Arquivos

- `src/components/FileExplorer.tsx` (estado de clipboard + handlers cut/copy/paste, modificado)
- `src/components/TreeNode.tsx` (itens de menu + atalhos com foco na árvore, modificado)
- `src/api.ts` (wrappers `copyPath` / `movePath`, já criados na ISSUE-57)
- `src/styles.css` (estilo do nó "recortado" esmaecido, modificado)

## Detalhes técnicos

- Clipboard interno: estado em [FileExplorer.tsx](../../src/components/FileExplorer.tsx); não usar a Clipboard API do SO, pois copiamos referências de arquivos, não texto.
- Destino do colar: a pasta selecionada (`selectedDirectory`); se o nó selecionado for um arquivo, usar a pasta-pai dele como destino.
- Copy vs. cut: `copy_path(workspace_root, src, dest_parent)` mantém a origem; `move_path(...)` remove a origem. A resolução de colisão (sufixo) vem do backend (ISSUE-57), o front só reflete o `entry_for` retornado.
- Limpeza pós-cut: após `move_path` ok, zerar o clipboard para evitar segundo paste de uma origem inexistente.
- Indicação visual do "recortado": classe CSS que esmaece o nó enquanto ele está no clipboard em modo `cut`; remover ao colar ou ao limpar.
- Foco/atalhos: registrar os handlers de teclado escopados ao painel do Explorador (verificar `document.activeElement`/foco do painel) para não disparar quando o Monaco tem o foco.
- Erro: `copy_path`/`move_path` retornam `Err(String)`; exibir mensagem e manter o clipboard intacto.

## Critérios de aceite

- [ ] Itens "Recortar", "Copiar" e "Colar" aparecem no menu com os aceleradores corretos.
- [ ] Copiar + Colar duplica arquivo/pasta no destino, sem sobrescrever (sufixo em colisão).
- [ ] Recortar + Colar move o item e limpa o clipboard.
- [ ] Colar pasta copia/move recursivamente toda a subárvore.
- [ ] "Colar" fica desabilitado quando o clipboard está vazio.
- [ ] O item recortado aparece esmaecido até ser colado/limpo.
- [ ] **Ctrl+X / Ctrl+C / Ctrl+V** funcionam na árvore e **não** interferem nos atalhos do Monaco.
- [ ] A árvore é atualizada após a operação.
- [ ] `tsc --noEmit` sem erros.
