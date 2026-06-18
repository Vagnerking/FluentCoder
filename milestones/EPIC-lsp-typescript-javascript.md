# Épico: TypeScript e JavaScript — IntelliSense via LSP real

> **Status:** Concluído (implementação; E2E tauri-driver pendente)
> **Owner:** Vagner
> **Stack:** Tauri 2 · Rust · React 18 · TypeScript · Monaco · monaco-languageclient · typescript-language-server

## Visão

Adicionar suporte completo de IntelliSense para **TypeScript** (`.ts`, `.tsx`) e **JavaScript**
(`.js`, `.jsx`) no Monaco Editor, usando um **Language Server real** (`typescript-language-server`)
pelo mesmo bridge LSP do épico C# — **não** o worker embutido do Monaco.

A solução deve respeitar `tsconfig.json`/`jsconfig.json`, aliases de path, `node_modules`, `@types`
e tipos cross-file do projeto real aberto no editor. Isso inclui o próprio código-fonte do editor
(este repositório é um projeto React+Vite+TypeScript).

Este épico **reusa integralmente** a infraestrutura do épico C#: bridge WebSocket, factory
`createLanguageClient`, pipeline de diagnósticos → `Problem[]` e lifecycle manager. A diferença é
o servidor (`typescript-language-server` via Node), a configuração do client e a desabilitação
explícita do worker TS/JS embutido do Monaco para evitar IntelliSense competindo.

## Estado atual (baseline)

- Monaco mapeia `.ts/.tsx → typescript` e `.js/.jsx → javascript` em
  [language.ts](../src/language.ts), mas o **worker TS embutido não está configurado** — nem
  explicitamente habilitado nem desabilitado. Há syntax highlighting, mas sem IntelliSense semântico.
- **Sem LSP client** para TypeScript/JavaScript.
- O worker embutido do Monaco faz IntelliSense básico por padrão, mas não enxerga o `tsconfig.json`
  real do disco, não resolve aliases nem `node_modules/@types` do projeto em Tauri.
- Toda a infra de bridge, transport e lifecycle virá do épico C# (ISSUE-20–25).

## Escopo deste épico

| Item | Decisão |
| --- | --- |
| Servidor | `typescript-language-server` (Node) com `--stdio` |
| Resolução do servidor | Preferir `node_modules/.bin/typescript-language-server` do projeto; fallback gerenciado |
| Worker embutido do Monaco | **Desabilitado** (`noSemanticValidation`, `noSyntaxValidation`, completion desligada) |
| Bridge | Mesmo WebSocket local do épico C# — arquitetura unificada |
| tsconfig/jsconfig | Lido nativamente pelo servidor via `rootUri` = workspace |
| Aliases de path | Resolvidos pelo `typescript-language-server` via `tsconfig.json` |
| Suporte React (TSX/JSX) | Ids de linguagem `typescriptreact` / `javascriptreact` registrados |
| Blocos `<script>` em HTML/Razor | Fora de escopo |

## Issues

| # | Título | Camada | Depende de | Estimativa |
| --- | --- | --- | --- | --- |
| [33](issues/ISSUE-33-ts-disable-builtin-worker.md) | Front: desabilitar worker TS/JS embutido | Front | 23 | S |
| [34](issues/ISSUE-34-ts-language-server-launch.md) | Rust: launch do typescript-language-server | Rust | 22 | M |
| [35](issues/ISSUE-35-ts-client-config.md) | Full: TS/JS client config (tsconfig, aliases, @types) | Full | 23, 25, 33, 34 | M |
| [36](issues/ISSUE-36-tsx-jsx-language-ids.md) | Front: ids de linguagem TSX/JSX (react) | Front | 35 | S |
| [37](issues/ISSUE-37-ts-end-to-end-validation.md) | Full: validação E2E TS/JS | Full | 35, 36, 33 | S |

`S` = pequeno, `M` = médio, `L` = grande.

## Ordem de implementação sugerida

1. **33** e **34** em paralelo (desligar worker embutido + launch do servidor Node).
2. **35** (client config completo) — junta tudo.
3. **36** (ids TSX/JSX) — pequeno ajuste, pode ser em paralelo com 35.
4. **37** (validação E2E) — fechamento; testar neste próprio repositório.

## Critérios de aceite do épico

- [ ] Arquivos `.ts`, `.tsx`, `.js` e `.jsx` abrem e recebem IntelliSense com tipos reais do projeto.
- [ ] Autocomplete sugere propriedades, métodos, imports e tipos com base no projeto aberto.
- [ ] O editor respeita `tsconfig.json` ou `jsconfig.json` do workspace.
- [ ] Imports automáticos funcionam quando possível.
- [ ] Erros de TypeScript aparecem no editor e no ProblemsPanel.
- [ ] Warnings aparecem no editor.
- [ ] `F12` (Go to Definition) funciona, incluindo arquivos em `node_modules`.
- [ ] `Shift+F12` (Find References) funciona cross-file.
- [ ] `F2` (Rename Symbol) funciona.
- [ ] `Ctrl+K Ctrl+F` formata o documento.
- [ ] Organize Imports funciona via Code Action.
- [ ] Aliases de path (`@/`, `~/` etc.) são resolvidos quando configurados no `tsconfig`.
- [ ] Tipos de `node_modules/@types` são reconhecidos.
- [x] **Zero diagnóstico duplicado** do worker embutido (worker desligado em `monacoSetup.ts`).
- [x] Funciona neste próprio repositório (React+Vite+TypeScript): `typescript-language-server`
      e `typescript` instalados como devDependencies; detecção do servidor localiza-os.
- [x] `tsc --noEmit` e `cargo check` sem erros.
- [ ] Teste E2E (tauri-driver) cobrindo: abrir `.ts` → completion aparece com tipo real.

## Riscos / notas

- **Resolução do Node:** `typescript-language-server` exige Node no PATH. Mitigação: detectar e
  emitir erro de UX claro; decidir se bundla Node ou exige que o usuário o instale.
- **Conflito worker embutido × LSP:** se o worker não for desligado corretamente, o Monaco exibirá
  IntelliSense duplicado (worker built-in + servidor LSP). ISSUE-33 + ISSUE-37 verificam isso.
- **Ids de linguagem TSX/JSX:** Monaco usa `typescript`/`javascript`, mas o tsserver distingue
  `typescriptreact`/`javascriptreact`. ISSUE-36 alinha isso.
- **Projetos grandes:** o `tsserver` pode demorar para indexar. Mitigação: UX de status (ISSUE-28
  do épico C# já cobre o padrão; replicar para o servidor TS).
- **E2E obrigatório (regra do projeto):** ao concluir o épico, rodar `tauri build` + tauri-driver;
  não usar Playwright/MCP.
