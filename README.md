# Code Editor

Um editor de código desktop no estilo VSCode, construído com **Tauri 2**, **React** e **Monaco**. O backend nativo é escrito em **Rust**; a interface, em **TypeScript + React**. O design segue o guia **Fluent 2**.

## Funcionalidades

- **Editor Monaco** com realce de sintaxe e tema próprio.
- **Layout estilo VSCode**: barra de título, activity bar, explorer de arquivos, breadcrumbs, abas, painel inferior e status bar.
- **Terminal integrado** via PTY nativo (`portable-pty`).
- **Explorer de arquivos** com ícones do tema [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) e ícones de UI via [Codicons](https://github.com/microsoft/vscode-codicons).
- **Quick Open** (busca de arquivos por fuzzy matching) e **Search** no projeto.
- **Painel Git** via `git` CLI: status, stage/unstage, commit, fetch/pull/push, log e blame.
- **Executar e Depurar**: detecção e gerenciamento de run configurations.
- **IntelliSense via LSP** sobre `monaco-languageclient`, com bridge WebSocket ↔ stdio em Rust:
  - **C#** (Microsoft.CodeAnalysis.LanguageServer / Roslyn) — com download e verificação automáticos do servidor.
  - **TypeScript / JavaScript** (typescript-language-server).
  - **Razor / cshtml** (rzls).
- **Sessão persistente**: reabre a última pasta aberta ao iniciar o app.

## Stack

| Camada     | Tecnologia                                            |
|------------|-------------------------------------------------------|
| Shell      | [Tauri 2](https://tauri.app/)                         |
| Backend    | Rust (tokio, portable-pty, reqwest, serde)            |
| UI         | React 18 + TypeScript                                 |
| Editor     | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| Terminal   | [xterm.js](https://xtermjs.org/)                      |
| Bundler    | [Vite 6](https://vitejs.dev/)                         |
| LSP        | monaco-languageclient + vscode-languageclient         |

## Pré-requisitos

- [Node.js](https://nodejs.org/) (LTS recomendado)
- [Rust](https://www.rust-lang.org/tools/install) (toolchain estável) com Cargo
- Dependências de sistema do Tauri para a sua plataforma — veja o [guia de pré-requisitos do Tauri](https://tauri.app/start/prerequisites/)

## Como começar

```bash
# Instalar dependências do frontend
npm install

# Rodar o app em modo de desenvolvimento (Vite + janela Tauri)
npm run tauri dev
```

## Scripts

| Comando                | Descrição                                              |
|------------------------|--------------------------------------------------------|
| `npm run tauri dev`    | Inicia o app em desenvolvimento (hot reload do front). |
| `npm run tauri build`  | Gera o build de produção / instalador.                 |
| `npm run dev`          | Sobe apenas o Vite (sem a janela nativa).              |
| `npm run build`        | Type-check (`tsc`) + build do frontend.                |
| `npm run test:unit`    | Roda os testes unitários (`*.test.ts`).                |

## Estrutura do projeto

```
.
├── src/                  # Frontend React + TypeScript
│   ├── components/        # UI (ActivityBar, FileExplorer, TabBar, Terminal, GitPanel, ...)
│   ├── lsp/               # Cliente LSP, transporte WS e configuração por linguagem
│   ├── icon-theme/        # Tema de ícones Material
│   ├── icons/codicons/    # Ícones de UI (Codicons)
│   ├── quickOpen/         # Fuzzy matcher do Quick Open
│   └── App.tsx            # Composição do layout
├── src-tauri/            # Backend Rust (Tauri)
│   └── src/
│       ├── fs_commands.rs # I/O de arquivos
│       ├── terminal.rs    # PTY
│       ├── git.rs         # Comandos Git
│       ├── runner.rs      # Run configurations
│       ├── search.rs      # Busca no projeto
│       ├── session.rs     # Sessão persistente
│       └── lsp/           # Bridge LSP (codec, process, bridge, servidores)
├── docs/                 # Documentação de contexto e design (compartilhada entre IAs)
└── milestones/           # Épicos e issues de planejamento
```

## Documentação

- [Contratos de integração do editor](docs/context/editor.md) — regras obrigatórias do pipeline C#/Roslyn, tokens semânticos e LSP.
- [Guia de Design Fluent 2](docs/design/fluent-design.md) — princípios, tokens, estados e acessibilidade da UI.

> Ao implementar mudanças, consulte primeiro os documentos em [docs/](docs/): eles definem regras de negócio e contratos que não podem ser quebrados.

## Testes

```bash
npm run test:unit
```

Os testes E2E rodam via `tauri-driver` + WebdriverIO sobre um `tauri build` (não `cargo build`). Consulte o diretório [tests/](tests/).
