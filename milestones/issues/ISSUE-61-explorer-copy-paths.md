# ISSUE-61 · Copiar caminho e caminho relativo

**Épico:** [Menu de Contexto do Explorador](../EPIC-explorer-context-menu.md) · **Camada:** Full · **Tamanho:** S · **Depende de:** 56 · **Status:** ⬜ Pendente

## Contexto

O VS Code oferece no menu de contexto do Explorador duas ações de cópia de caminho: **Copiar caminho** (caminho absoluto do item, atalho **Shift+Alt+C**) e **Copiar caminho relativo** (relativo à raiz do workspace, atalho **Ctrl+K Ctrl+Shift+C**). Esta issue traz ambas para o nosso editor, expostas tanto no menu de pasta quanto no de arquivo.

O componente de menu reusável já existe — [TreeContextMenu.tsx](../../src/components/TreeContextMenu.tsx), criado na issue 56 — e o [TreeNode.tsx](../../src/components/TreeNode.tsx) já dispara `onContextMenu` com o nó alvo. Aqui só precisamos registrar os dois itens, calcular as strings de caminho e escrevê-las no clipboard do SO. O caminho relativo é derivado do `rootPath` do workspace mantido em [FileExplorer.tsx](../../src/components/FileExplorer.tsx).

Como o projeto ainda **não** tem helper de clipboard de texto, esta issue precisa decidir a abordagem (plugin do Tauri vs. API do navegador) e padronizá-la em [api.ts](../../src/api.ts) para reuso futuro (a issue 60 de Recortar/Copiar/Colar usa clipboard interno, não o do SO, então não há conflito).

## Tarefas

- [ ] Adicionar dois itens ao menu de contexto (pasta e arquivo) via [TreeContextMenu.tsx](../../src/components/TreeContextMenu.tsx): "Copiar caminho" e "Copiar caminho relativo", com seus aceleradores exibidos (`Shift+Alt+C` e `Ctrl+K Ctrl+Shift+C`).
- [ ] Implementar o cálculo do **caminho absoluto** (já disponível no nó da árvore — `node.path`).
- [ ] Implementar o cálculo do **caminho relativo** a partir do `rootPath` do workspace, normalizando os separadores do SO (Windows: `\`).
- [ ] Criar em [api.ts](../../src/api.ts) um helper `copyTextToClipboard(text: string)` para centralizar a escrita no clipboard do SO.
- [ ] Decidir e justificar a abordagem de clipboard (ver Detalhes técnicos); se for o plugin, adicionar a dependência `@tauri-apps/plugin-clipboard-manager` e registrá-lo no Rust.
- [ ] Amarrar os atalhos **Shift+Alt+C** e **Ctrl+K Ctrl+Shift+C** para o item selecionado na árvore (somente quando a árvore tem foco — alinhar com a issue 64).
- [ ] Feedback discreto de sucesso (ex.: status bar ou nenhum, seguindo o VS Code que é silencioso).

## Arquivos

- `src/components/TreeContextMenu.tsx` (modificado — registra os itens)
- `src/components/FileExplorer.tsx` (modificado — handlers e atalhos, fornece `rootPath`)
- `src/api.ts` (modificado — helper `copyTextToClipboard`)
- `src-tauri/Cargo.toml` / `src-tauri/src/lib.rs` (modificado, somente se optar pelo plugin do Tauri)
- `package.json` (modificado, somente se optar pelo plugin)

## Detalhes técnicos

- **Decisão de clipboard:** preferir `@tauri-apps/plugin-clipboard-manager`. Justificativa: `navigator.clipboard.writeText` exige contexto seguro e foco do documento, e pode falhar/silenciar em WebView (Windows/WebView2) quando o app não está em foco direto ou em handlers fora de gesto do usuário; o plugin do Tauri escreve via API nativa do SO de forma confiável e independente do estado de foco do WebView. Adicionar `@tauri-apps/plugin-clipboard-manager` ao `package.json` e o `tauri-plugin-clipboard-manager` ao Rust, registrando no builder em [lib.rs](../../src-tauri/src/lib.rs).
- **Caminho absoluto:** usar diretamente o `path` do nó alvo do menu; não recomputar.
- **Caminho relativo:** `relativo = absoluto` com o prefixo `rootPath + separador` removido. Preservar o separador nativo do SO (não converter para `/`), igual ao VS Code no Windows. Se o item for a própria raiz, o relativo é o nome da pasta raiz (comportamento do VS Code) ou string vazia — padronizar e documentar no código.
- **Aceleradores:** exibir as combinações no item do menu (coluna direita), mesmo que o disparo por teclado seja amarrado em [FileExplorer.tsx](../../src/components/FileExplorer.tsx). O chord `Ctrl+K Ctrl+Shift+C` exige uma pequena máquina de estado de "chord pendente" (timeout curto após `Ctrl+K`).
- Não bloquear a UI: a escrita no clipboard é assíncrona; tratar erro com log e, se necessário, fallback para `navigator.clipboard.writeText`.

## Critérios de aceite

- [ ] O menu de contexto de pasta e de arquivo mostra "Copiar caminho" e "Copiar caminho relativo" com os aceleradores corretos.
- [ ] "Copiar caminho" coloca o caminho **absoluto** do item no clipboard do SO.
- [ ] "Copiar caminho relativo" coloca o caminho relativo à raiz do workspace, com separadores nativos do SO.
- [ ] **Shift+Alt+C** e **Ctrl+K Ctrl+Shift+C** funcionam quando a árvore tem foco, sem conflitar com o editor Monaco.
- [ ] A dependência de clipboard escolhida está instalada e justificada no código/issue.
- [ ] `tsc --noEmit` e `cargo check` sem erros.
