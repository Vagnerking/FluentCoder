# ISSUE-07 · Polimento Fluent (Mica, foco, animações)

**Épico:** [Fluent VSCode Layout](../EPIC-fluent-vscode-layout.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** 01–06

## Contexto

Com todas as peças posicionadas, fazer o app **parecer** Windows 11 de verdade: Mica
visível nas superfícies de chrome, transições suaves, estados de foco/hover Fluent,
tipografia e espaçamento consistentes com o print de referência.

## Tarefas

- [ ] Revisar alpha de cada superfície para o Mica aparecer (title bar, activity bar,
      sidebar, status bar translúcidos; editor e terminal opacos).
- [ ] Cantos arredondados da janela (já há transparência) — validar no Win11.
- [ ] Transições Fluent: hover/press com `transition` curto (~120ms), "reveal" sutil.
- [ ] Foco de teclado visível (`:focus-visible`) em todos os controles interativos.
- [ ] Tipografia: garantir `Segoe UI Variable` com fallbacks; tamanhos coerentes.
- [ ] Scrollbars finas estilo Win11.
- [ ] Ajustar tema do Monaco e do xterm para casar com a paleta (fundos, seleção, acento).
- [ ] Conferir contraste/legibilidade sobre o Mica (texto secundário não pode sumir).

## Arquivos

- `src/styles.css` (grande parte)
- `src/components/EditorPane.tsx` (tema Monaco custom, se necessário)
- `src/components/TerminalView.tsx` (tema xterm)

## Detalhes técnicos

- Definir um tema Monaco custom (`monaco.editor.defineTheme`) com fundo `#1f1f1f` para
  combinar com `--editor-bg`, em vez do `vs-dark` puro.
- Evitar `backdrop-filter` pesado sobre áreas grandes (custo de GPU); o Mica nativo já
  resolve o fundo — CSS só precisa de alpha, não de blur.

## Critérios de aceite

- [ ] Comparação lado a lado com o print: hierarquia visual equivalente.
- [ ] Mica perceptível ao mover a janela sobre o wallpaper.
- [ ] Sem "flashes" brancos ou superfícies opacas onde deveria haver translucidez.
