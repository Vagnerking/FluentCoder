# CLAUDE.md

Instruções para o Claude Code neste repositório. A documentação de contexto do projeto está em [Docs](docs/) e é compartilhada entre todas as ferramentas de IA.

## Contexto do Projeto

- Sempre olhe as documentações do editor de código para não errar nas implementações, veja as regras de negócio e o que pode e não pode fazer em: [Editor De Código](docs/context/editor.md)
- Ao alterar `.cshtml`, parsing Razor, providers Monaco ou o lifecycle do serviço CSHTML, siga obrigatoriamente: [Contratos do Language Service CSHTML](docs/context/cshtml-language-service.md)
- Ao criar ou ajustar UI, siga o guia de design (princípios, tokens, estados, acessibilidade) em: [Guia de Design Fluent 2](docs/design/fluent-design.md)
- Ao mexer em temas (cor, ícones), gramáticas/linguagens/snippets de extensões ou no modo "somente contribuições", siga: [Temas e contribuições declarativas](docs/context/temas.md)
- Implemente mudanças em uma Git worktree separada e só integre na `main` depois das validações.

## Qualidade e aprendizado contínuo

- Antes de implementar ou abrir PR, siga [Qualidade de PRs e segurança](docs/context/pr-quality.md). Registre o contrato afetado, os chamadores e a validação necessária.
- Cada PR deve ter um objetivo e até 100 arquivos alterados, incluindo lockfiles e fixtures. Divida trabalhos maiores em PRs dependentes com base explícita; não esconda arquivos dos revisores.
- Use CodeGraph para impacto/dependências e Serena para símbolos/referências quando disponíveis. Ative o caminho da worktree atual, atualize o índice e confirme resultados no código; ausência de arestas não prova ausência de impacto.
- Em Rust/Tauri, use as skills instaladas `rust-skills`, `tauri-ipc`, `tauri-security` e `tauri-framework-security` conforme o escopo. Preserve a edição/MSRV, os perfis Cargo e os contratos locais. Skills não autorizam upgrades ou novas dependências por si só.
- Antes de declarar pronto: executar os checks aplicáveis, revisar o diff completo e triar alertas com evidências. Nunca confundir teste não executado, alerta suprimido ou revisão pulada com aprovação.
- Para cada defeito confirmado, registrar causa, regra preventiva e teste de regressão pertinente. Separar alertas de produção de fixtures deliberadamente adversariais.
