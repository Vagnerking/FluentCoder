# ISSUE-18 · Integração, polimento e E2E

**Épico:** [Quick Open — busca de arquivos (Ctrl+P)](../EPIC-quick-open-file-search.md) · **Camada:** Full · **Tamanho:** S · **Depende de:** 15, 16, 17

## Contexto

Fechamento do épico: juntar índice + matcher + palette, garantir performance em projeto
grande, polir os detalhes e cobrir com teste E2E conforme a regra do projeto.

## Tarefas

- [ ] Validar o fluxo completo: Ctrl+P → digitar → ↑/↓ → Enter abre o arquivo certo na aba.
- [ ] Medir com um projeto grande (ex.: o próprio `node_modules` por perto): tempo de
      `list_project_files` e de cada `rankFiles`. Se travar, limitar exibição e/ou
      filtrar antes de pontuar.
- [ ] Polimento: arquivo já aberto deve focar a aba (o `handleOpenFile` já trata); item
      selecionado sempre visível; estados de "nenhum resultado".
- [ ] `tsc --noEmit` e `cargo check` limpos.
- [ ] **Teste E2E** (tauri-driver + WebdriverIO, **não** Playwright/MCP) em `tests/`:
      abrir app → disparar Ctrl+P → digitar parte de um nome conhecido → Enter → asserir
      que a aba do arquivo abriu. Rodar via `tauri build` (não `cargo build`), conforme a
      memória do projeto.
- [ ] Atualizar o status no [README de milestones](../README.md) e marcar os checkboxes.

## Arquivos

- `tests/` (novo teste E2E do Quick Open)
- `milestones/README.md` (status)
- Ajustes pontuais em `QuickOpen.tsx` / `file_index.rs` se a medição exigir

## Detalhes técnicos

- E2E precisa do binário empacotado (`tauri build`), senão o WebView abre em localhost
  recusado — ver memória "E2E precisa de tauri build".
- Atalho global: garantir que o `keydown` do Quick Open não conflita com o Monaco quando o
  editor está focado (testar com cursor dentro do editor).

## Critérios de aceite

- [ ] Fluxo Ctrl+P → Enter abre o arquivo, validado manualmente e no E2E.
- [ ] Sem regressão perceptível de performance ao abrir a palette num projeto grande.
- [ ] `tsc --noEmit` e `cargo check` sem erros; E2E passa.
- [ ] Milestones README atualizado.
