# CLAUDE.md

Instruções para o Claude Code neste repositório. A documentação de contexto do projeto está em [Docs](docs/) e é compartilhada entre todas as ferramentas de IA.

## Contexto do Projeto

- Sempre olhe as documentações do editor de código para não errar nas implementações, veja as regras de negócio e o que pode e não pode fazer em: [Editor De Código](docs/context/editor.md)
- Ao alterar `.cshtml`, parsing Razor, providers Monaco ou o lifecycle do serviço CSHTML, siga obrigatoriamente: [Contratos do Language Service CSHTML](docs/context/cshtml-language-service.md)
- Ao criar ou ajustar UI, siga o guia de design (princípios, tokens, estados, acessibilidade) em: [Guia de Design Fluent 2](docs/design/fluent-design.md)
- Implemente mudanças em uma Git worktree separada e só integre na `main` depois das validações.
