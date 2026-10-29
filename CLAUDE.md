# CLAUDE.md

Instruções para o Claude Code neste repositório. A documentação de contexto do projeto está em [Docs](docs/) e é compartilhada entre todas as ferramentas de IA.

## Contexto do Projeto

- Sempre olhe as documentações do editor de código para não errar nas implementações, veja as regras de negócio e o que pode e não pode fazer em: [Editor De Código](docs/context/editor.md)
- Ao alterar `.cshtml`, parsing Razor, providers Monaco ou o lifecycle do serviço CSHTML, siga obrigatoriamente: [Contratos do Language Service CSHTML](docs/context/cshtml-language-service.md)
- Ao criar ou ajustar UI, siga o guia de design (princípios, tokens, estados, acessibilidade) em: [Guia de Design Fluent 2](docs/design/fluent-design.md)
- Ao criar uma preferência do usuário, declare-a como setting (nunca `localStorage`) e siga: [Configurações](docs/context/configuracoes.md)
- Ao mexer em temas (cor, ícones), gramáticas/linguagens/snippets de extensões ou no modo "somente contribuições", siga: [Temas e contribuições declarativas](docs/context/temas.md)
- Ao adicionar um novo servidor de linguagem/linter (LSP), garanta que ele continue coberto pela rotina de reset da Paleta de Comandos ("Resetar Servidores de Código"). Veja a regra de extensão em: [Paleta de Comandos](docs/context/command-palette.md)
- Ao alterar o chat de agentes de IA (Claude/Codex), siga os contratos de protocolo, sessão e modos em: [Agentes de IA](docs/context/agentes-ia.md)
- Ao criar/mover views, mexer nas regiões (barras laterais, painel) ou no layout responsivo do workbench, siga: [Views & Layout](docs/context/views-layout.md)
- Ao mexer no host de extensões VS Code (`tools/ext-host/`, `src/extensions/`, `src-tauri/src/ext_host.rs`), siga: [Extensões VS Code hospedadas](docs/context/extensoes-vscode.md)
- Ao mexer no language service C# (`.cs`) ou validar a milestone #5, dê aceite contra o Roslyn real (não só unit tests) com o probe headless: `node tools/razor-lsp-probe/probe-csharp-m5.mjs` (espere 9/9). Fluxo completo na skill `.claude/skills/csharp-lsp-acceptance/`. **O E2E (`tests/e2e/`) só roda no Windows** — `tauri-driver` não suporta macOS.
- Implemente mudanças em uma Git worktree separada e só integre na `main` depois das validações.

## Qualidade e aprendizado contínuo

- Antes de implementar ou abrir PR, siga [Qualidade de PRs e segurança](docs/context/pr-quality.md). Registre o contrato afetado, os chamadores e a validação necessária.
- Concentre a remediação no PR existente. Não abrir PRs auxiliares, criar workflows, configurar gates automáticos ou disparar/reexecutar CI sem solicitação explícita do autor. Usar skills e testes locais pertinentes; organizar a revisão em lotes menores sem ocultar arquivos.
- Use CodeGraph para impacto/dependências e Serena para símbolos/referências quando disponíveis. Ative o caminho da worktree atual, atualize o índice e confirme resultados no código; ausência de arestas não prova ausência de impacto.
- Use RTK (`rtk git status`, `rtk test npm run test:pr-check`) para resumir saídas rotineiras. Para revisão de segurança, diffs completos e diagnóstico de falhas, consulte a saída original; saída filtrada não prova ausência de problemas.
- Em Rust/Tauri, use as skills instaladas `rust-skills`, `tauri-ipc`, `tauri-security` e `tauri-framework-security` conforme o escopo. Preserve a edição/MSRV, os perfis Cargo e os contratos locais. Skills não autorizam upgrades ou novas dependências por si só.
- Antes de declarar pronto: executar os checks aplicáveis, revisar o diff completo e triar alertas com evidências. Nunca confundir teste não executado, alerta suprimido ou revisão pulada com aprovação.
- Para cada defeito confirmado, registrar causa, regra preventiva e teste de regressão pertinente. Separar alertas de produção de fixtures deliberadamente adversariais.
