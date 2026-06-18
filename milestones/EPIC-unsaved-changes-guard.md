# Épico: Guarda de Alterações Não Salvas

> **Status:** Planejado
> **Owner:** Vagner
> **Stack:** Tauri 2 · React 18 · TypeScript · Monaco

## Visão

Impedir a perda silenciosa de trabalho. Hoje, fechar uma aba com alterações não salvas
("suja") descarta as mudanças sem avisar. Replicar o comportamento do VS Code: ao fechar
um arquivo modificado, abrir um diálogo perguntando **"Deseja salvar as alterações?"** com
três opções — **Salvar**, **Não salvar** (descartar) e **Cancelar** (aborta o fechamento).

A mesma guarda vale ao **fechar a janela / encerrar o app** ou **trocar de pasta** com abas
sujas: confirmar antes de perder o trabalho, com a opção de salvar tudo.

O componente de modal criado aqui (`ConfirmDialog`) é **reutilizável** e também atende à
confirmação de exclusão de arquivos do [Menu de Contexto do Explorador](EPIC-explorer-context-menu.md).

## Estado atual

- [App.tsx](../src/App.tsx) mantém `openFiles[]` (cada um com `dirty`) e `activePath`;
  o fechamento de aba remove o arquivo do array **sem** checar `dirty`.
- [TabBar.tsx](../src/components/TabBar.tsx) já mostra o ponto de "não salvo" (`tab-dirty-dot`)
  e dispara `onClose`.
- Erros usam `window.alert`; **não** há componente de modal/confirm reutilizável.
- O plugin `@tauri-apps/plugin-dialog` está instalado e registrado (hoje só `pickFolder`).
- Não há tratamento de `onCloseRequested` da janela do Tauri.

## Decisões

| Item | Decisão |
| --- | --- |
| Componente | `ConfirmDialog` reutilizável (Fluent, portal, foco/Esc), com botões configuráveis |
| Botões (fechar aba) | **Salvar** · **Não salvar** · **Cancelar** (Esc = Cancelar) |
| Botões (excluir) | **Mover para a Lixeira** · **Cancelar** (consumido pela issue 59 do Explorer) |
| Salvar | Grava o arquivo (fluxo de save existente) **antes** de fechar; em erro, não fecha |
| Cancelar | Aborta a ação inteira; nada é fechado nem descartado |
| Fechar janela/app | Interceptar `onCloseRequested`; se houver abas sujas, confirmar/salvar em lote |
| Trocar de pasta | Mesma guarda em lote antes de descartar a sessão atual |
| Acessibilidade | Modal com foco preso, `role="dialog"`, Esc cancela, botão default destacado |

## Fora de escopo

- Auto-save por timer ou ao perder o foco.
- Recuperação de buffers (hot exit) após crash.
- Histórico/versionamento local de arquivos.

## Issues

| # | Título | Camada | Depende de | Estimativa |
| --- | --- | --- | --- | --- |
| [66](issues/ISSUE-66-confirm-modal-component.md) | Componente `ConfirmDialog` reutilizável | Front | — | M |
| [67](issues/ISSUE-67-close-tab-dirty-guard.md) | Guarda ao fechar aba suja | Full | 66 | M |
| [68](issues/ISSUE-68-close-window-app-dirty-guard.md) | Guarda ao fechar janela/app e trocar de pasta | Full | 66, 67 | M |

`S` = pequeno, `M` = médio, `L` = grande.

## Ordem de implementação

1. Criar o componente `ConfirmDialog` (66) — base compartilhada.
2. Guardar o fechamento de aba suja com Salvar/Não salvar/Cancelar (67).
3. Estender a guarda para janela/app e troca de pasta, em lote (68).

## Critérios de aceite do épico

- [ ] Fechar uma aba suja abre o diálogo com Salvar / Não salvar / Cancelar.
- [ ] **Salvar** grava e então fecha; erro de gravação mantém a aba aberta.
- [ ] **Não salvar** descarta e fecha.
- [ ] **Cancelar** (botão ou Esc) mantém a aba aberta e sem alterações.
- [ ] Fechar a janela/app com abas sujas pede confirmação antes de sair.
- [ ] Trocar de pasta com abas sujas pede confirmação antes de descartar a sessão.
- [ ] O `ConfirmDialog` segue o Fluent 2 (foco preso, Esc, botão default destacado).
- [ ] `tsc --noEmit`, testes e E2E passam.

## Riscos e notas

- Interceptar `onCloseRequested` exige `preventDefault` no Tauri e só então fechar via API
  após resolução do diálogo — cuidar para não travar o encerramento.
- O fluxo de "Salvar" deve reutilizar exatamente o save já existente em
  [App.tsx](../src/App.tsx), não duplicar lógica de escrita.
- O diálogo é assíncrono; o `onClose` da aba precisa virar uma Promise (ou callback) que só
  remove o arquivo após a decisão do usuário.
