# CLAUDE.md

Instruções para o Claude Code neste repositório. A documentação de contexto do projeto está em [Docs](docs/) e é compartilhada entre todas as ferramentas de IA.

## Contexto do Projeto

- Sempre olhe as documentações do editor de código para não errar nas implementações, veja as regras de negócio e o que pode e não pode fazer em: [Editor De Código](docs/context/editor.md)
- Ao criar ou ajustar UI, siga o guia de design (princípios, tokens, estados, acessibilidade) em: [Guia de Design Fluent 2](docs/design/fluent-design.md)
- Ao adicionar um novo servidor de linguagem/linter (LSP), garanta que ele continue coberto pela rotina de reset da Paleta de Comandos ("Resetar Servidores de Código"). Veja a regra de extensão em: [Paleta de Comandos](docs/context/command-palette.md)