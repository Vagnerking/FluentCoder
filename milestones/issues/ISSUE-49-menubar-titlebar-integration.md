# ISSUE-49 · Integrar MenuBar na TitleBar

**Épico:** [Barra de Menu estilo VSCode](../EPIC-menu-bar-vscode.md) · **Camada:** Front · **Tamanho:** S · **Depende de:** 47

## Contexto

Esta issue encaixa o `MenuBar` (ISSUE-47) dentro da title bar customizada
([TitleBar.tsx](../../src/components/TitleBar.tsx)), posicionado à **esquerda**, logo após o botão de
toggle da sidebar — como no VSCode. O desafio principal é **não quebrar o arraste da janela**: a
title bar usa `data-tauri-drag-region` e a área do menu precisa fazer opt-out desse drag, igual aos
botões interativos que já existem ali.

O layout final da title bar fica: `toggle | menu | título centralizado | window controls`, com as
áreas vazias ainda servindo de região de arraste da janela.

A definição dos menus vem do App (props drilling, como já é feito hoje); a `TitleBar` apenas repassa
essa definição ao `MenuBar`.

## Tarefas

- [ ] Inserir `<MenuBar>` em [TitleBar.tsx](../../src/components/TitleBar.tsx) logo após o botão de toggle.
- [ ] Garantir que a área do menu faça **opt-out** de `data-tauri-drag-region` (cliques no menu não
      podem arrastar a janela), seguindo o que os botões interativos atuais (caption-btn / toggle) fazem.
- [ ] Ampliar as props de `TitleBar` para receber a definição dos menus vinda do App e repassá-la ao `MenuBar`.
- [ ] Em [App.tsx](../../src/App.tsx), montar/derivar a definição dos menus e passá-la à `TitleBar`.
- [ ] Ajustar o layout em [styles.css](../../src/styles.css): `toggle | menu | título centralizado |
      window controls`, preservando o drag das áreas vazias.

## Arquivos

- `src/components/TitleBar.tsx` (inserir MenuBar, ampliar props, modificado)
- `src/App.tsx` (passar a definição dos menus via props, modificado)
- `src/styles.css` (layout da title bar com o menu, modificado)

## Detalhes técnicos

- O container da title bar tem `data-tauri-drag-region`; elementos interativos precisam **não**
  propagar o drag — ver como os `caption-btn` e o botão de toggle atuais fazem (opt-out do drag region).
- Posicionar o `MenuBar` entre o toggle e o título centralizado sem empurrar/quebrar o centro.
- Testar o item de menu mais à **direita** (Help) perto do título centralizado, garantindo que não
  haja sobreposição.
- Repasse de props segue o padrão de props drilling já usado no [App.tsx](../../src/App.tsx).

## Critérios de aceite

- [ ] O MenuBar aparece na title bar logo após o botão de toggle.
- [ ] Clicar nos menus **não** arrasta a janela.
- [ ] Arrastar as áreas vazias da title bar ainda move a janela.
- [ ] O layout não quebra ao maximizar a janela.
- [ ] `tsc --noEmit` sem erros.
