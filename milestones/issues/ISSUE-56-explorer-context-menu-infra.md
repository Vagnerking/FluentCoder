# ISSUE-56 · Menu de contexto da árvore: componente reusável (portal)

**Épico:** [Menu de Contexto do Explorador](../EPIC-explorer-context-menu.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** — · **Status:** ⬜ Pendente

## Contexto

Esta issue cria a **infraestrutura visual** do menu de contexto do Explorador de Arquivos, **sem nenhuma lógica de negócio**: um componente genérico, dirigido por dados, que recebe os itens por props e os renderiza num menu flutuante posicionado no ponto do clique. As ações concretas (renomear, excluir, copiar, etc.) virão nas issues seguintes (57–60) — aqui o componente é puramente apresentacional.

O comportamento reusa o padrão já consolidado em [TabBar.tsx](../../src/components/TabBar.tsx): renderizar via `createPortal` em `document.body`, posicionar pelas coordenadas `{x, y}` do clique e fechar ao clicar fora (mousedown externo) ou ao pressionar **Escape**. Não reinventar esse comportamento — espelhá-lo. O CSS atual `.tab-context-menu` / `.tab-context-item` / `.tab-context-separator` em [styles.css](../../src/styles.css) serve de base visual.

A árvore em [TreeNode.tsx](../../src/components/TreeNode.tsx) hoje **não** possui `onContextMenu`. Esta issue adiciona o gatilho de clique direito nas linhas, montando a lista de itens conforme o tipo do nó (pasta ou arquivo) e delegando a renderização ao novo componente. O suporte a **submenu** (ex.: "Folder History" do print de referência) já entra na estrutura, mesmo que ainda sem itens reais.

## Tarefas

- [ ] Criar `src/components/TreeContextMenu.tsx` — componente apresentacional dirigido por props.
- [ ] Definir o modelo de dados de item: `id`, `label`, `accelerator?`, `run?: () => void`, `enabled?: boolean`, `separator?: boolean`, `submenu?: ContextMenuItem[]`.
- [ ] Receber a posição `{x, y}` do clique e os `items` por props; renderizar via `createPortal` em `document.body`.
- [ ] Fechar ao clicar fora (mousedown externo) ou ao pressionar **Escape**, reusando o padrão do [TabBar.tsx](../../src/components/TabBar.tsx).
- [ ] Item com `separator: true` vira divisória (sem texto, não clicável).
- [ ] Item com `enabled: false` renderiza esmaecido (cinza) e não dispara clique.
- [ ] Item com `submenu` exibe indicador (chevron) e abre o submenu ao hover; submenu segue as mesmas regras de fechamento.
- [ ] Exibir `accelerator` alinhado à direita do label (ex.: `F2`, `Del`, `Ctrl+C`).
- [ ] Clicar num item habilitado executa `run?.()` e fecha o menu.
- [ ] Adicionar `onContextMenu` em [TreeNode.tsx](../../src/components/TreeNode.tsx): `e.preventDefault()`, captura `{x, y}` e monta a lista de itens conforme o tipo (pasta/arquivo).
- [ ] CSS novo em [styles.css](../../src/styles.css): `.tree-context-menu`, `.tree-context-item`, `.tree-context-separator`, `.tree-context-submenu`, estado disabled e acelerador.

## Arquivos

- `src/components/TreeContextMenu.tsx` (novo)
- `src/components/TreeNode.tsx` (adicionar `onContextMenu`, modificado)
- `src/styles.css` (estilos `.tree-context-*`, modificado)

## Detalhes técnicos

- Posicionamento: usar as coordenadas `{x, y}` do evento de clique direito, exatamente como o [TabBar.tsx](../../src/components/TabBar.tsx) posiciona o seu menu de contexto. Ajustar quando o menu ultrapassar a borda da viewport (flip horizontal/vertical) para não cortar.
- Estado de "menu aberto" gerenciado por quem usa o componente (FileExplorer/TreeNode): guardar `{ x, y, items } | null`.
- O componente **não** conhece nenhuma ação concreta — apenas renderiza e dispara `item.run?.()`.
- Itens com `separator` ou `enabled: false` nunca disparam `run`.
- Submenu: renderizado também via portal, ancorado à direita do item pai; fecha junto com o menu principal.
- Consistência Fluent 2: superfície acrílica, paleta `--text` / `--text-muted` e cor de acento, cantos arredondados — coerente com `.tab-context-*` em [styles.css](../../src/styles.css). Acelerador em `--text-muted`.
- Ícones (codicons) do mapa central quando o item os exigir; nesta issue o foco é a estrutura, ícones são opcionais.

## Critérios de aceite

- [ ] Clicar com o botão direito numa linha da árvore abre o menu na posição do cursor.
- [ ] Clicar fora ou pressionar Esc fecha o menu.
- [ ] Clicar num item habilitado chama o seu `run` e fecha o menu.
- [ ] Itens `enabled: false` aparecem esmaecidos e não disparam nada.
- [ ] Itens `separator` aparecem como divisória.
- [ ] Item com `submenu` abre o submenu ancorado à direita.
- [ ] O `accelerator` aparece alinhado à direita do label.
- [ ] O componente não contém nenhuma lógica de negócio (somente props).
- [ ] `tsc --noEmit` sem erros.
