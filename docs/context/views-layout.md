# Views & Layout — contratos

Registro genérico de views do workbench (estilo `views`/`viewsContainers` do
VS Code) e o layout responsivo das regiões. Código em `src/workbench/`.

## Regiões e views

- Três regiões hospedam views: **barra lateral primária**
  (`primarySidebar`), **barra lateral secundária** (`secondarySidebar`) e
  **painel** (`panel`). O editor nunca é uma região de views.
- Cada view tem **identidade estável** (`id`) — os ids antigos foram mantidos
  para a migração: `explorer`, `search`, `git`, `debug`, `extensions`,
  `packages`, `graph`, `account`, `settings`, `fluentChat`, `problems`,
  `output`, `terminal`; views de extensão: `ext:<publisher.nome>` (ex.:
  `ext:anthropic.claude-code`, `ext:openai.chatgpt`).
- `viewRegistry.ts` (puro): descriptor = título, ícone (codicon ou imagem da
  extensão), região/ordem padrão, `retainWhenHidden`, `activityBar`,
  `allowedRegions`. Views nativas em `nativeViews.ts`; as de extensão são
  registradas por `useExtensionViews` (uma por extensão liberada no portão
  que contribui view de webview).
- `viewLayout.ts` (puro, testado): onde cada view vive — `placements`
  (região + ordem + oculta) e a **ativa por região** — persistido em
  `localStorage["ui.viewLayout"]` (`version: 1`). Só guarda o que o usuário
  mudou; views sem placement ficam no padrão. Placement de view ausente
  (extensão desinstalada) é preservado.
- **Migração** (só quando `ui.viewLayout` não existe): `ui.panelTabOrder` →
  ordem das views do painel; `ui.agentsDockTab` → ativa da secundária
  (`fluent-chat`/`fluent-agents`/`agents` → `fluentChat`; id de extensão →
  `ext:<id>`). As chaves antigas não são mais escritas.

## Conteúdo persistente (não remontar ao mover)

- O conteúdo React de cada view é renderizado **uma vez** num nó DOM próprio
  (`viewNodes.ts`, portal do `WorkbenchViewsProvider`). Mover a view só
  **reanexa o nó** ao corpo da região de destino; região desmontada
  (sidebar fechada) → o nó vai para um estacionamento oculto. Terminais,
  chat e estado de UI sobrevivem a mover/fechar.
- `retainWhenHidden` (terminal, Fluent Chat, views de extensão): sempre
  montada. As demais (Explorador, Pesquisar…) só montam enquanto visíveis —
  o comportamento antigo da sidebar primária.
- **Iframes nunca são reanexados** (o navegador recarregaria o documento):
  os webviews das views de extensão vivem na `ExtensionWebviewLayer` (camada
  fixa no `.app`) e são **posicionados sobre o slot** da view
  (`ResizeObserver` nas regiões + `MutationObserver` de estilo + rede de
  segurança de 300 ms). Oculto = `visibility: hidden` (o iframe segue vivo,
  o host recebe `webviewVisible:false`). Mover a view **não** re-resolve a
  view nem recarrega o iframe — ver docs/context/extensoes-vscode.md.
- Eventos React de um portal sobem pela árvore React do provider, não pela
  do DOM: handlers de região que precisam ver cliques no conteúdo usam
  listener nativo (`ViewContainer.onNativeMouseDownCapture`).

## Mover views

- **Menu "Mover para…"** (Barra lateral primária / secundária / Painel): no
  botão "…" do cabeçalho da região, no botão direito (ou Shift+F10) de cada
  aba de view e de cada ícone da activity bar. É também o caminho por
  teclado.
- **Arrastar** a aba (ou o título de uma view convidada na primária): 5 px de
  folga separam clique de arraste; sessão `view` do `useWorkbenchDrag`
  (Escape/blur cancelam, Monaco e iframes blindados). Zonas de soltura: as
  regiões abertas + faixas nas bordas para as fechadas (soltar abre a
  região); a sob o ponteiro destaca e diz "Mover para …"; barra de inserção
  entre as abas (hit-testing puro em `viewDrop.ts`).
- Mover abre a região de destino e torna a view a ativa de lá; a origem recai
  na vizinha.
- Sidebar secundária e painel mostram **abas** (`DockableViewTabs`, tablist
  com ←/→/Home/End). A primária usa a activity bar como seletor; views
  convidadas lá (Fluent Chat, Claude…) ganham ícone extra na activity bar e
  um cabeçalho de título arrastável (`DockableViewHeader`).
- Ações próprias da view vão para o cabeçalho da região com `<ViewToolbar>`
  (portal; só aparecem quando a view é a ativa).
- Revelar uma view (`reveal(id)`) abre a região onde ela estiver: activity
  bar, Paleta, `Ctrl+Shift+F`, status bar → Problemas, `Ctrl+`` (Terminal),
  `revealView` de extensão etc. Nunca presumir que uma view está na região
  padrão.

## Layout responsivo

- `layoutConstraints.ts` (puro, testado nas larguras 800/1024/1366/1920 e
  alturas 600/900) + `useWorkbenchLayout.ts`: reserva um **mínimo para o
  editor somando todas as regiões abertas** (400 × 160 px CSS; em janelas
  pequenas, no máximo metade da área útil), com a janela medida em px CSS
  (`innerWidth ÷ zoom da UI`).
- Falta espaço → 1) as regiões encolhem até o mínimo de cada uma
  (proporcional à folga); 2) ainda falta → a região **usada há mais tempo**
  (LRU: ponteiro/foco dentro dela) é **recolhida temporariamente**. As
  preferências salvas (aberta, largura/altura: `ui.sidebarWidth`,
  `ui.agentsSidebarWidth`, `ui.panelHeight`, `ui.panelWidth`) **nunca** são
  sobrescritas pelo solver; a região volta sozinha quando houver espaço.
- Região recolhida: o toggle da title bar, a activity bar ou um `reveal`
  reabrem-na como **sobreposição** (`.region-overlay`,
  `data-region-overlay`) por cima do editor; Escape ou clique fora fecham.
  Usar a sobreposição não altera a ordem LRU (não tira outra região do
  lugar). O iframe de uma view de extensão sobe junto (camada z 31).
- Abrir uma região fechada a torna a mais recente: se faltar espaço, sai a
  menos usada das outras.
- Painel embaixo respeita a altura mínima do editor (o `max` da alça vem do
  solver); muito baixo, recolhe como as laterais.
- `WorkbenchResizeHandle`: alça única (barras e painel) com
  `role="separator"`, `aria-orientation`, `aria-valuenow/min/max`; teclado:
  setas ±16 px, Shift ±64, Home/End = mínimo/máximo (`resizeKeyValue`).
  Arrastar usa a sessão `resize` (Escape/blur restauram).
- Title bar: a central de comandos encolhe (≤ 760 px vira só o ícone de
  busca + paleta; ≤ 560 px sai); menus e controles de janela ficam.
- Status bar: os itens que as container queries escondem vão para o botão
  **"Mais"** (`statusOverflow.ts`; limites espelhados do CSS e travados por
  teste).
