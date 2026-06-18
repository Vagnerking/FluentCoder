# ISSUE-06 · Frontend do terminal (xterm.js + painel)

**Épico:** [Fluent VSCode Layout](../EPIC-fluent-vscode-layout.md) · **Camada:** Front · **Tamanho:** L · **Depende de:** 01, 05

## Contexto

O painel inferior do VSCode com abas (Problems / Output / **Terminal**) e um terminal real
renderizado por **xterm.js**, ligado ao PTY da ISSUE-05.

## Tarefas

- [ ] Adicionar deps: `@xterm/xterm` e `@xterm/addon-fit` (resize) ao `package.json`.
- [ ] Criar `src/components/TerminalPanel.tsx`:
  - Barra de abas do painel: `Problems`, `Output`, `Terminal` (só Terminal funcional).
  - Botões à direita: novo terminal (+), lixeira (kill), e fechar painel (chevron).
- [ ] Criar `src/components/TerminalView.tsx` (o xterm em si):
  - Instancia `Terminal` + `FitAddon`, monta no `div`.
  - `term_create` no mount (gera um `id`, passa `cwd` = pasta aberta, `cols/rows` do fit).
  - `listen("term://data/{id}")` → `term.write(data)`.
  - `term.onData(d => invoke("term_write", {id, data: d}))`.
  - `ResizeObserver` → `fit()` → `invoke("term_resize", ...)`.
  - Cleanup: `term_close` + `term.dispose()` + `unlisten()` no unmount.
- [ ] Tema do xterm casando com o Fluent (fundo opaco `#1f1f1f`, cor de acento, fonte
      `Cascadia Code`/`Consolas`).
- [ ] Integrar com a ISSUE-01: o painel ocupa a zona inferior; abre via activity/atalho
      ``Ctrl+` `` e fecha pelo chevron.

## Arquivos

- `package.json` (+`@xterm/xterm`, `@xterm/addon-fit`)
- `src/components/TerminalPanel.tsx` (novo)
- `src/components/TerminalView.tsx` (novo)
- `src/api.ts` (wrappers `termCreate/termWrite/termResize/termClose`)
- `src/App.tsx` (montar painel, estado `panelOpen`, atalho)
- `src/styles.css` (`.terminal-panel`, abas, xterm container)

## Detalhes técnicos

- **IDs de sessão:** `Date.now()`/`Math.random()` estão disponíveis no front (não no
  workflow). Gerar `id = crypto.randomUUID()`.
- **Fit timing:** chamar `fit()` após o container ter tamanho (no `requestAnimationFrame`
  pós-mount e em cada resize); senão xterm inicia 80x24 e fica torto.
- **Listen scoping:** o nome do evento inclui o `id` da sessão para multiplexar vários
  terminais no futuro; na v1 um terminal só já basta.
- **CSS do xterm:** importar `@xterm/xterm/css/xterm.css`.
- **Cascade de unmount:** garantir `term_close` mesmo se o componente desmontar abruptamente
  (cleanup no `useEffect` return).

## Critérios de aceite

- [ ] Painel abre com aba Terminal; xterm renderiza prompt do PowerShell.
- [ ] Digitar comandos funciona (`dir`, `echo oi`), saída aparece corretamente.
- [ ] Redimensionar a janela/painel reflui o terminal (sem corte de colunas).
- [ ] Fechar o painel encerra a sessão (sem processo órfão).
- [ ] `tsc --noEmit` limpo.
