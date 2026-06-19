# ISSUE-65 · Integração, a11y, build e E2E

**Épico:** [Menu de Contexto do Explorador](../EPIC-explorer-context-menu.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 56–64 · **Status:** ⬜ Pendente

## Contexto

As issues 56–64 entregaram, isoladamente, o componente de menu reusável, os comandos de mutação e cada ação (renomear, excluir, recortar/copiar/colar, copiar caminhos, revelar/terminal, localizar na pasta, navegação por teclado). Esta issue **fecha o épico**: monta os conjuntos completos de itens por tipo (pasta × arquivo), na ordem do VS Code, com separadores, e garante coerência de acessibilidade, Fluent 2, build e cobertura E2E.

A montagem final acontece em [TreeContextMenu.tsx](../../src/components/TreeContextMenu.tsx) e [FileExplorer.tsx](../../src/components/FileExplorer.tsx): definir os arrays de itens para pasta e para arquivo, com os separadores nos lugares certos, e marcar como **desabilitados** os itens fora de escopo deste épico (Abrir ao lado, Open With, ações de Git) que pertencem ao [Épico de Ações Avançadas](../EPIC-explorer-advanced-actions.md).

Por fim, validar tudo junto: `tsc --noEmit`, `cargo check`, e um teste E2E (tauri-driver + WebdriverIO) cobrindo o fluxo via menu e via atalho de teclado, conforme a regra do projeto de testar E2E ao concluir feature (com `tauri build`, não `cargo build`).

## Tarefas

- [ ] Montar o conjunto de itens do menu de **pasta** na ordem do VS Code, com separadores entre os grupos (Novo arquivo/Nova pasta · Revelar/Abrir no Terminal/Localizar na pasta · Recortar/Copiar/Colar · Copiar caminho/relativo · Renomear/Excluir · itens avançados desabilitados).
- [ ] Montar o conjunto de itens do menu de **arquivo** na ordem do VS Code, com separadores (Abrir ao lado [desabilitado]/Open With [desabilitado] · Revelar/Abrir no Terminal · Recortar/Copiar/Colar · Copiar caminho/relativo · Renomear/Excluir · Git [desabilitado]).
- [ ] Marcar como **desabilitados** (não removidos) os itens fora de escopo, linkando conceitualmente ao [Épico de Ações Avançadas](../EPIC-explorer-advanced-actions.md).
- [ ] Acessibilidade do próprio menu: foco inicial no primeiro item, navegação por ↑/↓, **Enter** ativa, **Esc** fecha, roles ARIA (`menu`/`menuitem`/`separator`), `aria-disabled` nos itens desabilitados.
- [ ] Verificar os estados Fluent 2 em todos os itens: rest, hover, pressed, focus e disabled.
- [ ] Rodar `tsc --noEmit` e `cargo check` e corrigir o que aparecer.
- [ ] Escrever teste E2E (tauri-driver + WebdriverIO) cobrindo, via menu e via atalho: criar arquivo/pasta, renomear, excluir, copiar caminho.

## Arquivos

- `src/components/TreeContextMenu.tsx` (modificado — montagem final, separadores, a11y do menu)
- `src/components/FileExplorer.tsx` (modificado — definição dos conjuntos pasta×arquivo)
- `src/styles.css` (modificado — ajustes finais de estados Fluent)
- `e2e/` (novo — spec WebdriverIO do menu de contexto do Explorador)

## Detalhes técnicos

- **Ordem dos grupos:** seguir o VS Code para reduzir atrito de uso; separadores apenas entre grupos lógicos, nunca duas divisórias seguidas nem divisória no topo/fim.
- **Itens desabilitados:** renderizar com `aria-disabled="true"`, esmaecidos, não focáveis para ativação mas visíveis — sinalizando ao usuário que existem e virão no épico avançado. Não duplicar lógica: reutilizar a flag `enabled: false` já suportada pelo componente de menu.
- **A11y do menu:** o menu é um `role="menu"` em portal; ao abrir, mover foco para o primeiro item habilitado; `Esc`/clique externo fecham e devolvem foco à árvore (alinhar com a navegação da issue 64).
- **E2E:** seguir a infra registrada na memória do projeto — usar `tauri build` (não `cargo build`) para evitar o WebView abrir em localhost recusado, subir o `tauri-driver` e dirigir via WebdriverIO. Os specs devem criar um diretório temporário de workspace, exercitar criar → renomear → copiar caminho → excluir (para a Lixeira) e validar o estado da árvore/clipboard.
- Conferir que nenhum atalho global do menu/árvore conflita com o Monaco (gate de foco da issue 64).

## Critérios de aceite

- [ ] Clique direito em pasta e em arquivo abre menus com os itens corretos por tipo e na ordem do VS Code, com separadores adequados.
- [ ] Itens fora de escopo (Abrir ao lado, Open With, Git) aparecem desabilitados, sem quebrar o menu.
- [ ] O menu é navegável por teclado (↑/↓, Enter, Esc) com roles ARIA e `aria-disabled` corretos.
- [ ] Estados rest, hover, pressed, focus e disabled seguem o guia Fluent 2.
- [ ] `tsc --noEmit` e `cargo check` passam sem erros.
- [ ] O teste E2E (tauri-driver + WebdriverIO) cobre criar/renomear/excluir/copiar caminho via menu e via atalho e passa.
