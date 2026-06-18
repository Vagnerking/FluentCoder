# ISSUE-48 · Navegação por teclado, Alt e acessibilidade do MenuBar

**Épico:** [Barra de Menu estilo VSCode](../EPIC-menu-bar-vscode.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** 47

## Contexto

Com o MenuBar já renderizando e abrindo dropdowns (ISSUE-47), esta issue o torna **acessível e
totalmente operável só pelo teclado**, como o VSCode. Isso inclui os roles ARIA corretos, foco
roving entre menus e itens, e o comportamento da tecla **Alt** para focar/abrir a barra.

O objetivo é paridade de teclado com o VSCode: Alt foca a barra, as setas navegam, Enter/Espaço
ativam e Esc fecha devolvendo o foco. Também é nesta issue que o **acelerador** de cada item
(ex.: "Ctrl+S") passa a ser renderizado, alinhado à direita.

Atenção especial à tecla Alt, que colide com comportamentos padrão do navegador/Tauri — é preciso
`preventDefault` no handler global para que o foco da barra funcione sem efeitos colaterais.

## Tarefas

- [ ] Aplicar roles ARIA: `role="menubar"` na barra, `role="menu"` no dropdown, `role="menuitem"` nos itens.
- [ ] Implementar **foco roving** (apenas um elemento tabbable por vez na barra).
- [ ] ←/→ trocam o menu aberto (move entre os 8 menus).
- [ ] ↑/↓ navegam os itens do dropdown aberto, com **wrap**, **pulando** itens disabled e separadores.
- [ ] **Enter** / **Espaço** ativam o item focado (chama `run` e fecha).
- [ ] **Esc** fecha o dropdown e devolve o foco ao botão do menu correspondente.
- [ ] Tecla **Alt** foca/abre a barra (estilo VSCode); **Alt** de novo fecha/devolve o foco.
- [ ] Com um menu aberto, passar o mouse (ou navegar por teclado) sobre outro menu **troca** o
      dropdown sem exigir novo clique.
- [ ] Renderizar o acelerador (ex.: "Ctrl+S") alinhado à **direita** de cada item.
- [ ] Itens `enabled: false` **não** recebem foco (são pulados na navegação).

## Arquivos

- `src/components/MenuBar.tsx` (roles, navegação por teclado, Alt, acelerador — modificado)
- `src/styles.css` (estilos de foco/`:focus-visible` e do acelerador alinhado à direita — modificado)

## Detalhes técnicos

- **Alt**: cuidado com a colisão com o comportamento do Tauri/navegador (menu nativo, atalhos do SO).
  Fazer `preventDefault()` no keydown global ao tratar Alt para evitar efeitos indesejados.
- Botões de menu: `aria-haspopup="true"` e `aria-expanded` refletindo se o seu dropdown está aberto.
- Itens: `aria-disabled` quando `enabled: false`.
- Manter o item focado sempre **visível** (scroll into view se a lista for longa).
- Foco roving: gerenciar `tabIndex` (0 no ativo, -1 nos demais) e mover o foco programaticamente.
- Reaproveitar o estado de "menu aberto" (índice) já introduzido na ISSUE-47.

## Critérios de aceite

- [ ] Navegação completa por teclado: Alt abre a barra → setas movem entre menus e itens → Enter ativa.
- [ ] Esc fecha e devolve o foco ao botão do menu.
- [ ] Aceleradores visíveis e alinhados à direita em cada item.
- [ ] Itens disabled não são focáveis (a navegação os pula).
- [ ] Hover/navegação entre menus abertos troca o dropdown sem novo clique.
- [ ] Sem regressão no clique do mouse (ISSUE-47 continua funcionando).
- [ ] `tsc --noEmit` sem erros.
