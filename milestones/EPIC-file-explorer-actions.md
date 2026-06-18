# Épico: Ações do Explorador de Arquivos

> **Status:** Planejado
> **Owner:** Vagner
> **Stack:** Tauri 2 · Rust · React 18 · TypeScript

## Visão

Adicionar ao cabeçalho do Explorador de Arquivos as ações essenciais de manutenção
da árvore, seguindo o comportamento familiar de editores como o VS Code:

- **Novo arquivo**;
- **Nova pasta**;
- **Atualizar explorador**;
- **Recolher pastas**.

As ações devem usar Codicons, textos e tooltips em português, funcionar por
teclado e preservar os contratos visuais e de acessibilidade do Fluent 2
documentados em [docs/design/fluent-design.md](../docs/design/fluent-design.md).

## Estado atual

- [FileExplorer.tsx](../src/components/FileExplorer.tsx) mostra o nome da raiz e
  apenas a ação textual **Abrir pasta**.
- [TreeNode.tsx](../src/components/TreeNode.tsx) mantém expansão e filhos em
  estado local, carregando cada pasta sob demanda com `readDir`.
- Não existe seleção explícita de pasta na árvore.
- [fs_commands.rs](../src-tauri/src/fs_commands.rs) lê diretórios e grava
  arquivos, mas não possui comandos seguros e específicos para criar um arquivo
  vazio ou uma pasta.
- O mapa central de Codicons já contém `newFile`, `newFolder`, `refresh` e
  `collapseAll`.

## Decisões

| Item | Decisão |
| --- | --- |
| Local das ações | Cabeçalho do Explorador, alinhadas à direita do nome da raiz |
| Destino da criação | Pasta selecionada; sem seleção, raiz do workspace |
| Entrada do nome | Campo inline na árvore, com confirmação por Enter e cancelamento por Esc |
| Conflito de nome | Não sobrescrever; exibir erro claro e manter o campo para correção |
| Atualização | Recarregar a raiz e invalidar caches das pastas expandidas |
| Recolhimento | Fechar todas as pastas, sem alterar arquivos ou abas abertas |
| Sem workspace | Ações desabilitadas, exceto **Abrir pasta** |
| Ícones | Codicons existentes no mapa central; nenhum SVG ou glyph avulso |

## Fora de escopo

- Renomear, excluir, recortar, copiar ou mover arquivos e pastas.
- Criação de múltiplos itens em lote.
- Watcher automático do sistema de arquivos.
- Menus de contexto.

## Issues

| # | Título | Camada | Depende de | Estimativa |
| --- | --- | --- | --- | --- |
| [42](issues/ISSUE-42-explorer-new-file.md) | Novo arquivo | Full | — | M |
| [43](issues/ISSUE-43-explorer-new-folder.md) | Nova pasta | Full | 42 | M |
| [44](issues/ISSUE-44-explorer-refresh.md) | Atualizar explorador | Front | 42, 43 | M |
| [45](issues/ISSUE-45-explorer-collapse-folders.md) | Recolher pastas | Front | 44 | S |
| [46](issues/ISSUE-46-explorer-actions-integration.md) | Integração, acessibilidade e E2E | Full | 42–45 | M |

`S` = pequeno, `M` = médio, `L` = grande.

## Ordem de implementação

1. Implementar a seleção de destino, o campo inline e **Novo arquivo**.
2. Reutilizar o mesmo fluxo de entrada para **Nova pasta**.
3. Centralizar a revisão da árvore para suportar **Atualizar explorador**.
4. Usar o mesmo controle centralizado para **Recolher pastas**.
5. Validar integração, teclado, erros, build e E2E.

## Critérios de aceite do épico

- [ ] As quatro ações aparecem no cabeçalho do Explorador com Codicons e tooltips em português.
- [ ] Novo arquivo e Nova pasta usam a pasta selecionada ou a raiz como destino.
- [ ] Enter confirma a criação, Esc cancela e o foco segue um fluxo previsível.
- [ ] Nomes vazios, inválidos ou já existentes não criam nem sobrescrevem itens.
- [ ] Atualizar explorador reflete alterações feitas dentro e fora do aplicativo.
- [ ] Recolher pastas fecha toda a árvore com uma única ação.
- [ ] Sem workspace aberto, as quatro ações ficam desabilitadas.
- [ ] Estados rest, hover, pressed, focus e disabled seguem o guia Fluent 2.
- [ ] `tsc --noEmit`, testes unitários, `cargo check` e E2E passam.

## Riscos e notas

- O estado local recursivo atual de `TreeNode` dificulta refresh e recolhimento
  globais. A implementação deve usar uma geração/chave de árvore ou elevar o
  estado de expansão, sem manipulação imperativa do DOM.
- `write_file` pode sobrescrever um caminho existente. **Novo arquivo** precisa
  de um comando Rust com semântica `create_new`, evitando perda de dados.
- A validação de nomes deve considerar as regras do sistema operacional e
  sempre confirmar no backend que o destino permanece dentro do workspace.
