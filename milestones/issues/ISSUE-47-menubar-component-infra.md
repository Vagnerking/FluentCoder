# ISSUE-47 · Componente MenuBar: modelo de dados + dropdown (portal)

**Épico:** [Barra de Menu estilo VSCode](../EPIC-menu-bar-vscode.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** —

## Contexto

Esta issue cria o componente base da barra de menu, **sem nenhuma lógica de negócio** — apenas
a estrutura visual, o modelo de dados que descreve cada menu e seus itens, e o dropdown que abre
abaixo de cada botão. Os handlers reais (abrir pasta, salvar, etc.) virão por props nas issues
seguintes; aqui o componente é puramente apresentacional e dirigido por dados.

O dropdown reusa o padrão já existente em [TabBar.tsx](../../src/components/TabBar.tsx): renderizar
via `createPortal`, posicionar com base no bounding rect do botão, e fechar ao clicar fora (mousedown
externo) ou ao pressionar **Escape**. Não reinventar esse comportamento — seguir o que já funciona.

A barra expõe os 8 menus do VSCode (File, Edit, Selection, View, Go, Run, Terminal, Help). Cada menu
é uma lista de itens declarados pelo App; o MenuBar só sabe renderizar e disparar `run?.()`, sem
conhecer nenhum atalho ou ação concreta.

## Tarefas

- [ ] Criar `src/components/MenuBar.tsx` — componente apresentacional dirigido por props.
- [ ] Definir os tipos do modelo de dados (em [types.ts](../../src/types.ts) ou no próprio arquivo):
      - `MenuItem`: `id`, `label`, `accelerator?`, `run?: () => void`, `enabled?: boolean`, `separator?: boolean`.
      - `MenuDef`: `label` (nome do menu) + `items: MenuItem[]`.
- [ ] Renderizar os 8 menus (File, Edit, Selection, View, Go, Run, Terminal, Help) como botões na barra.
- [ ] Abrir/fechar o dropdown de cada menu via `createPortal`, posicionado **abaixo** do botão
      (medir o bounding rect, como o [TabBar.tsx](../../src/components/TabBar.tsx) faz com o menu de contexto).
- [ ] Fechar o dropdown ao clicar fora (mousedown externo) ou ao pressionar **Escape**, reusando o
      padrão do TabBar.
- [ ] Item com `separator: true` vira uma divisória (sem texto, não clicável).
- [ ] Item com `enabled: false` renderiza esmaecido (cinza) e não dispara clique.
- [ ] Clicar num item habilitado executa `run?.()` e fecha o dropdown.
- [ ] Receber a definição completa dos menus por props — **sem hardcode de handlers** no componente.
- [ ] CSS Fluent em [styles.css](../../src/styles.css): `.menubar`, `.menubar-menu`, `.menubar-dropdown`,
      item, separador e estado disabled.

## Arquivos

- `src/components/MenuBar.tsx` (novo)
- `src/types.ts` (tipos `MenuDef` / `MenuItem`, modificado)
- `src/styles.css` (estilos `.menubar*`, modificado)

## Detalhes técnicos

- Posicionamento do portal: medir o bounding rect do botão do menu e posicionar o dropdown logo
  abaixo dele, exatamente como o [TabBar.tsx](../../src/components/TabBar.tsx) faz para o seu menu
  de contexto.
- Estado de "menu aberto" controlado por um índice (`number | null`) — qual dos 8 menus está aberto,
  ou `null` quando todos fechados.
- Clicar num item: chama `item.run?.()` e em seguida fecha (volta o índice para `null`).
- Itens com `separator` ou `enabled: false` nunca disparam `run`.
- Consistência visual Fluent 2: superfície acrílica do dropdown, paleta `--text` / `--text-muted` e
  cor de acento, cantos arredondados — coerente com o restante do app em [styles.css](../../src/styles.css).
- A **acessibilidade** (roles ARIA, navegação por teclado, Alt) **não** entra aqui — é a ISSUE-48.

## Critérios de aceite

- [ ] Clicar num menu abre o seu dropdown abaixo do botão.
- [ ] Clicar fora ou pressionar Esc fecha o dropdown.
- [ ] Clicar num item habilitado chama o seu `run` e fecha o dropdown.
- [ ] Itens `enabled: false` aparecem esmaecidos e não disparam nada.
- [ ] Itens `separator` aparecem como divisória.
- [ ] Os 8 menus (File, Edit, Selection, View, Go, Run, Terminal, Help) aparecem na barra.
- [ ] `tsc --noEmit` sem erros.
