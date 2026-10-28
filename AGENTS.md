# CLAUDE.md

Instruções para o Claude Code neste repositório. A documentação de contexto do projeto está em [Docs](docs/) e é compartilhada entre todas as ferramentas de IA.

## Contexto do Projeto

- Sempre olhe as documentações do editor de código para não errar nas implementações, veja as regras de negócio e o que pode e não pode fazer em: [Editor De Código](docs/context/editor.md)
- Ao alterar `.cshtml`, parsing Razor, providers Monaco ou o lifecycle do serviço CSHTML, siga obrigatoriamente: [Contratos do Language Service CSHTML](docs/context/cshtml-language-service.md)
- Ao criar ou ajustar UI, siga o guia de design (princípios, tokens, estados, acessibilidade) em: [Guia de Design Fluent 2](docs/design/fluent-design.md)
- Implemente mudanças em uma Git worktree separada e só integre na `main` depois das validações.

## Qualidade de PRs e segurança

- Siga [Qualidade de PRs e segurança](docs/context/pr-quality.md) antes de implementar e publicar.
- Mantenha um objetivo por PR e até 100 arquivos, incluindo locks, fixtures e gerados. Use a base real do incremento e preserve o escopo completo da entrega.
- Use CodeGraph/Serena quando disponíveis, confirmando símbolos, chamadores e efeitos no código. Use RTK para saídas rotineiras, preservando logs completos de falhas e segurança.
- Consulte as skills Rust/Tauri aplicáveis sem alterar edição, MSRV ou perfis Cargo por recomendação genérica. Teste os caminhos reais afetados.
- Não considere testes ignorados, alertas suprimidos ou revisão pulada como aprovação. Registre causas, regressões e regras preventivas; mantenha candidatos incompletos fora da main.
