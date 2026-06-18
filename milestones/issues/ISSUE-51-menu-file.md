# ISSUE-51 · Menu File

**Épico:** [Barra de Menu estilo VSCode](../EPIC-menu-bar-vscode.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 47, 49

## Contexto

Fiar os itens do menu **File** aos handlers do App. A maioria das ações já existe em
[App.tsx](../../src/App.tsx) (`handleOpenFolder`, `handleSave`, `handleCloseTab`); algumas
exigem pequenos handlers/comandos novos (Open File via dialog de arquivo, Save As, Close Folder,
New File). Esta issue entrega a **definição do menu File** (modelo `MenuDef`/`MenuItem` da
ISSUE-47) populada com os `run` corretos, mais o que faltar de API/estado para suportá-los.

Itens que ainda não têm suporte no editor (Auto Save, Revert File, Share, Preferences, Open Recent)
são renderizados **desabilitados** (`enabled: false`), seguindo o padrão da ISSUE-47.

## Tarefas

- [ ] **New Text File / New File**: criar um buffer "untitled" (sem `path` real) — ver risco em
      Detalhes técnicos. Pode ser cortado para v2.
- [ ] **Open File**: criar `pickFile()` em [api.ts](../../src/api.ts) (dialog `open` do plugin Tauri,
      **sem** `directory`) + `handleOpenFile` no App que lê e abre o arquivo escolhido numa aba.
- [ ] **Open Folder**: reusar `handleOpenFolder` (já faz `pickFolder` → `openFolder`).
- [ ] **Save**: reusar `handleSave`. Save de buffer untitled cai em **Save As**.
- [ ] **Save As**: dialog `save` do plugin Tauri + `writeFile` no caminho escolhido + atualizar o
      `path` do tab correspondente.
- [ ] **Close Editor**: `handleCloseTab(activePath)`.
- [ ] **Close Folder**: limpar `rootPath` / `roots` / `openFiles` (volta ao estado vazio).
- [ ] **Exit**: `getCurrentWindow().close()` (mesmo usado no caption-close da TitleBar).
- [ ] Renderizar **desabilitados** os itens sem suporte: Auto Save, Revert File, Share,
      Preferences, Open Recent.
- [ ] Adicionar a definição do menu File ao modelo de menus consumido pelo [MenuBar.tsx](../../src/components/MenuBar.tsx).

## Arquivos

- `src/App.tsx` (handlers novos: `handleOpenFile`, `handleSaveAs`, `handleCloseFolder`, `handleNewFile`; definição do menu File)
- `src/api.ts` (`pickFile()` via dialog `open`; helper de Save As via dialog `save` + `writeFile`)
- `src/components/FileExplorer.tsx` / `src/types.ts` (somente se o suporte a untitled exigir mudança em `OpenFile`)

## Detalhes técnicos

- **Untitled buffers são a parte mais invasiva**: hoje todo `OpenFile` tem `path` real, usado
  como key da lista de abas e como URI do Monaco. Suportar buffer sem path obriga a generalizar
  esse contrato (key/URI sintéticos). Manter o escopo mínimo: untitled abre vazio e o **Save**
  de um untitled cai em **Save As**. Se for arriscado, marcar como recorte para v2.
- Reusar o **plugin dialog do Tauri** já em uso por `pickFolder` (`pickFile` = mesmo plugin com
  `directory: false`; Save As = `save` do mesmo plugin).
- `getCurrentWindow().close()` para Exit, exatamente como o caption-close da TitleBar.

## Critérios de aceite

- [ ] Open Folder, Open File, Save, Save As, Close Editor, Close Folder e Exit funcionam pelo menu File.
- [ ] Itens fora de escopo (Auto Save, Revert, Share, Preferences, Open Recent) aparecem desabilitados.
- [ ] Save As grava no caminho escolhido e o tab passa a refletir o novo `path`.
- [ ] `tsc --noEmit` sem erros.
