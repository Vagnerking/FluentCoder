# Checklist de acessibilidade e contraste — Fluent 2

> Deliverable do item **F2-AUD-017** da auditoria (issue #82). Cobre validação
> manual de contraste, foco e navegação por teclado por painel, mais o registro
> de decisões sobre gradientes (F2-AUD-011) e exceções aceitas.
>
> Este documento é um checklist a executar manualmente — ele **não** prova
> conformidade sozinho. O app roda em WebView2 (Windows); use as DevTools do
> Edge/WebView e o sistema de alto contraste do Windows para validar.

## Como validar

- **Contraste**: DevTools → inspecionar elemento → painel de contraste (mede AA
  4.5:1 para texto normal, 3:1 para texto grande/ícones de UI). Como várias
  superfícies usam alpha sobre Mica/acrylic, o contraste depende do backdrop —
  meça com a janela sobre fundo claro **e** escuro do desktop.
- **Foco/teclado**: navegue cada painel só com `Tab`/`Shift+Tab`/setas/`Home`/
  `End`/`Enter`/`Space`/`Esc`. Todo elemento interativo deve mostrar o anel de
  foco (`--stroke-focus`) e ser operável.
- **Reduced motion**: ative "Mostrar animações no Windows = Desligado" (ou
  emule `prefers-reduced-motion: reduce` nas DevTools) e confirme que nada faz
  animação decorativa prolongada (inclui a simulação do Graph).
- **Forced colors**: ative um tema de Alto Contraste do Windows e confirme que
  foco, seleção, bordas de input/botão e estados de erro permanecem visíveis.
- **Zoom**: aplique zoom da WebView até 200% (texto) e verifique que nada some,
  trunca sem reflow ou perde foco; teste também janela estreita.

## Checklist por painel

Marque por estado: `rest` / `hover` / `selected` / `disabled` / `focus`.

| Painel | Contraste AA | Foco visível | Teclado completo | Reduced motion | Forced colors | Obs. |
|---|---|---|---|---|---|---|
| Explorer (árvore) | [ ] | [ ] | [ ] | [ ] | [ ] | |
| Editor tabs | [ ] | [ ] | [ ] | [ ] | [ ] | tablist roving |
| Search | [ ] | [ ] | [ ] | [ ] | [ ] | toggles aria-pressed |
| Git | [ ] | [ ] | [ ] | [ ] | [ ] | badges cor+texto |
| Problems | [ ] | [ ] | [ ] | [ ] | [ ] | ícone por severidade |
| Terminal / painel inferior | [ ] | [ ] | [ ] | [ ] | [ ] | tablist |
| Agents | [ ] | [ ] | [ ] | [ ] | [ ] | radiogroup de modo |
| SSH (dialogs) | [ ] | [ ] | [ ] | [ ] | [ ] | trap/restore |
| Graph | [ ] | [ ] | [ ] | [ ] | [ ] | listbox alternativa |
| Status bar | [ ] | [ ] | [ ] | [ ] | [ ] | ações por teclado |
| Dialogs (Confirm/About/Quick*) | [ ] | [ ] | [ ] | [ ] | [ ] | foco volta ao disparador |

## Status não dependente só de cor (F2-AUD-012)

Confirmar que cada estado é distinguível sem cor (ícone, texto ou badge):

- [ ] Erro / aviso / info nos Problemas (ícone codicon distinto por severidade).
- [ ] Git: adicionado / modificado / removido / renomeado / conflito (letra do
      badge `A`/`M`/`D`/`R` + cor, não só cor).
- [ ] Decorações de árvore (deco-\*): letra/badge além da cor.

## Gradientes — classificação (F2-AUD-011)

| Local | Tipo | Decisão |
|---|---|---|
| Titlebar / sidebar / activity bar (sheen `linear-gradient(145deg, --acrylic-luminosity…)`) | Funcional | Mantido — reforça a borda luminosa do acrylic (Mica), alpha baixíssimo, sobre chrome. |
| Tab bar fade (`linear-gradient(to right/left, --tabbar-bg, transparent)`) | Funcional | Mantido — máscara de overflow das tabs. |
| Checkerboard de mídia (4× `linear-gradient(45deg…)`) | Funcional | Mantido — indica transparência em pré-visualização de mídia. |
| Empty state / Welcome / Graph / Agents empty-config (radiais accent ~0.05) | Branding | Mantido — só em superfícies vazias; não competem com conteúdo. |
| **`.agent-chat`** (radial accent) | Decorativo sobre conteúdo | **Removido** nesta PR — o chat é conteúdo ativo; fundo agora é `--editor-bg` plano. |

## Exceções aceitas

- **Caption buttons do Windows** (minimizar/maximizar/fechar): cores de
  plataforma; ficam fora do sistema de tokens.
- **`.explorer-title` uppercase**: convenção de seções herdada do VS Code;
  mantido com tracking suavizado (F2-AUD-009).
- **Tema Monaco / sintaxe**: os `foreground` de tokens de sintaxe não são
  tokens de UI e seguem inline em `EditorPane`; apenas o *chrome* do editor
  consome a `palette`.

## Pendências para automação

- Avaliar `@axe-core/playwright` nas rotas principais **se** o app ganhar um
  fluxo de teste automatizável de UI (hoje os E2E usam tauri-driver/WebdriverIO).
- Não há script de contraste no `package.json`; este checklist é o gate manual
  até lá.
