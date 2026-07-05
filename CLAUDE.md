# CLAUDE.md

Instruções para o Claude Code neste repositório. A documentação de contexto do projeto está em [Docs](docs/) e é compartilhada entre todas as ferramentas de IA.

## Contexto do Projeto

- Sempre olhe as documentações do editor de código para não errar nas implementações, veja as regras de negócio e o que pode e não pode fazer em: [Editor De Código](docs/context/editor.md)
- Ao alterar `.cshtml`, parsing Razor, providers Monaco ou o lifecycle do serviço CSHTML, siga obrigatoriamente: [Contratos do Language Service CSHTML](docs/context/cshtml-language-service.md)
- Ao criar ou ajustar UI, siga o guia de design (princípios, tokens, estados, acessibilidade) em: [Guia de Design Fluent 2](docs/design/fluent-design.md)
- Ao adicionar um novo servidor de linguagem/linter (LSP), garanta que ele continue coberto pela rotina de reset da Paleta de Comandos ("Resetar Servidores de Código"). Veja a regra de extensão em: [Paleta de Comandos](docs/context/command-palette.md)
- Ao alterar o chat de agentes de IA (Claude/Codex), siga os contratos de protocolo, sessão e modos em: [Agentes de IA](docs/context/agentes-ia.md)
- Implemente mudanças em uma Git worktree separada e só integre na `main` depois das validações.
