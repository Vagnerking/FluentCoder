# Configurações (settings estilo VS Code) — contratos

O Fluent Coder tem um sistema de configurações em camadas compatível com o
VS Code: as mesmas chaves (`editor.tabSize`, `files.exclude`…), os mesmos
arquivos (`.vscode/settings.json`, `.code-workspace`) e a mesma precedência. O
que é próprio do app usa o prefixo `fluent.*`.

## Arquitetura

```
src/settings/
  registry.ts      schema (SettingSchema) + contributes.configuration das extensões
  coreSettings.ts  settings do core (FONTE ÚNICA do schema; defaults = comportamento antigo)
  jsonc.ts         parse JSONC tolerante + edição pontual que preserva comentários
  model.ts         camadas e precedência (puro)
  service.ts       SettingsService: arquivos de cada camada, update(target), eventos
  instance.ts      registro + serviço únicos (sem Tauri: testes leem os defaults)
  bootstrap.ts     E/S pelo Rust, migração do localStorage e do ext-host/settings.json
  react.ts         useSetting / useSyncedSetting / useSettingsVersion
  applyWorkbench.ts atributos data-* no <html> (aparência, acessibilidade, abas)
  extHostBridge.ts snapshot das camadas → host de extensões; update() das extensões → arquivo
src-tauri/src/settings.rs  settings_paths/read_files/write_file/watch, editorconfig_chain
```

O Rust só faz E/S (ler, gravar atômico, observar, achar `.editorconfig`). Parse,
precedência e edição ficam no TS — puros e cobertos por `node --test`.

## Camadas e precedência

`default < user < workspace < folder`, e por cima de TODAS as camadas gerais
vêm os overrides de linguagem `"[typescript]": {…}` (default de linguagem <
user de linguagem < …), como no VS Code. Objetos simples (`files.exclude`,
`search.exclude`) são **mesclados** camada sobre camada; arrays e escalares são
substituídos.

| Camada | Pasta única | Workspace (multi-root ou arquivo salvo) |
|---|---|---|
| user | `<app_config>/User/settings.json` | idem |
| workspace | `<raiz>/.vscode/settings.json` + `<raiz>/.fluent/settings.json` | `settings` do `.fluent-workspace`/`.code-workspace` (ou em memória se não salvo) |
| folder | — (= workspace) | `.vscode/` + `.fluent/` de cada raiz local |

- `.fluent/settings.json` vence `.vscode/settings.json` na mesma pasta.
- Escrita no escopo Workspace/Pasta vai para `.fluent/settings.json` (ou
  `.vscode/`, por `fluent.settings.workspaceWriteTarget`). "Restaurar padrão"
  remove a chave dos dois arquivos.
- Escopo do schema limita o alvo: `application`/`machine` só no Usuário;
  `window` não vai para Pasta; `resource`/`language-overridable` vão a todos.
- Chaves desconhecidas (extensões não instaladas, settings do VS Code que o app
  não usa) são **preservadas** (edição pontual nunca reescreve o arquivo) e
  repassadas ao host de extensões.
- Raízes SSH: só a camada de Usuário nesta fase.

## Regras para quem mexe aqui

- **Toda setting nova é declarada em `coreSettings.ts`** (chave VS Code quando
  existir; `fluent.*` quando não). Nada de `localStorage` para preferência.
- Leia com `settings.get(key, { resource, languageId })` (fora do React) ou
  `useSetting(key)` (React, re-render só de quem usa). Para preferências que a
  UI também muda em tempo real (arrastar, Ctrl+=), `useSyncedSetting`.
- Grave com `settings.update(key, value, target, { resource, languageId,
  overrideInLanguage })` — a memória muda na hora e o arquivo é editado de
  forma pontual (comentários preservados). Nunca reescreva um settings.json
  inteiro.
- Os defaults do core reproduzem o comportamento anterior do app; mudar um
  default muda o app de todo mundo — trate como mudança de produto.

### O que é setting e o que fica no localStorage

Vira **setting** o que é preferência do usuário e faz sentido versionar ou
compartilhar (fonte, tema, tabSize, posição da sidebar/painel/activity bar,
zoom, format on save, exclusões, autofetch…).

Fica no **localStorage** o ESTADO de UI por janela: larguras/alturas de
painéis (`ui.sidebarWidth`, `ui.panelHeight`, `ui.panelWidth`,
`ui.agentsSidebarWidth`), `ui.viewLayout`, `ui.viewPanes.*`, ordem da activity
bar, seções recolhidas, toggles da caixa de busca (`search.regex/case/word`),
pastas recentes, último alvo SSH, último agente/modelo do chat
(`fluentChat.prefs`), posições do grafo e caches (`extensions.updates`…). É a
mesma divisão do VS Code entre settings e `state.vscdb`.

### Migração

Na primeira execução (`settings.migrated.v1`), `bootstrap.ts` move as chaves
antigas para o User settings (só o que difere do default; nunca sobrescreve o
que já existe no arquivo) e as remove do `localStorage`:

| localStorage | setting |
|---|---|
| `editor.formatOnSave` | `editor.formatOnSave` |
| `csharp.inlayHints` | `csharp.inlayHints.enabled` |
| `lsp.ts.preferEditor` | `fluent.typescript.preferEditorVersion` |
| `lsp.razorProjection` | `fluent.razor.projection` |
| `lsp.diagToFile` | `fluent.lsp.logToFile` |
| `files.exclude`, `search.exclude` | iguais |
| `fluent.quickOpen.maxFiles` | igual |
| `git.autofetch` (`on`/`off`) | `git.autofetch` (boolean) |
| `git.avatars`, `git.repositoryScanMaxDepth` | iguais |
| `ui.sidebarSide` | `workbench.sideBar.location` |
| `ui.activityBarPos` | `workbench.activityBar.location` |
| `ui.panelPos` | `workbench.panel.defaultLocation` |
| `ui.scale` | `fluent.ui.scale` |
| `ui.acrylicFlyouts` | `fluent.window.acrylicFlyouts` |

O antigo `<app_data>/ext-host/settings.json` (overrides gravados pelas
extensões) é mesclado no User settings e renomeado para `.bak`.

## Host de extensões

`tools/ext-host/src/shim/configuration.js` usa as MESMAS camadas:

- o app manda `configuration {defaults, user, workspace, folders}` logo após o
  `initialize` (antes de qualquer extensão ativar — `extHost.onInitialized`) e a
  cada mudança; o host dispara `onDidChangeConfiguration` com
  `affectsConfiguration` correto;
- `getConfiguration(section, scope)` respeita `resource`/`languageId`;
  `inspect()` devolve `globalValue`/`workspaceValue`/`workspaceFolderValue` e os
  `*LanguageValue`;
- `update(key, value, target)` vira o evento `configurationUpdate` e o app grava
  na camada pedida (`ConfigurationTarget.Global` → User, `Workspace` →
  workspace, `WorkspaceFolder` → `.fluent/settings.json` da pasta);
- os defaults de fallback do host batem com os do app (`editor.tabSize` 2).

## Onde cada setting é aplicada

| Área | Settings | Onde |
|---|---|---|
| Editor (Monaco) | `editor.font*`, `lineHeight`, `wordWrap*`, `rulers`, `lineNumbers`, `minimap.enabled`, `stickyScroll.enabled`, `renderWhitespace`, `renderLineHighlight`, `cursor*`, `smoothScrolling`, `mouseWheelZoom`, `formatOnPaste/OnType`, `autoClosingBrackets`, `bracketPairColorization.enabled`, `guides.*`, `folding`, `codeLens`, `inlayHints.enabled`, `linkedEditing`, `acceptSuggestionOnEnter`, `accessibilitySupport` | `editorSettings.ts` → `useEditorSettingsOptions` → `options` do `<Editor>` (EditorPane) |
| Indentação do modelo | `editor.tabSize`, `insertSpaces`, `detectIndentation` (+ `.editorconfig`) | `attachEditorSettings` (EditorPane `onMount`) → `model.updateOptions`/`detectIndentation`; barra de status via `useActiveIndentation` |
| Salvamento | `editor.formatOnSave` (por linguagem), `files.trimTrailingWhitespace`, `insertFinalNewline`, `trimFinalNewlines`, `files.eol`/`files.encoding` (arquivo novo) | `formatOnSave.ts` + `prepareSave` no `saveFile` do App |
| Auto save | `files.autoSave`, `autoSaveDelay` | `useAutoSave` (App) |
| Arquivos grandes | `fluent.editor.largeFileThresholdMB`, `files.maxMemoryForLargeFilesMB` (teto 50 MB do `read_file`) | `openFileGate.ts` |
| Exclusões | `files.exclude`, `search.exclude`, `fluent.quickOpen.maxFiles` | Explorer (`api.ts`), Quick Open, Busca (somadas às exclusões digitadas); mudar `files.exclude` relê o Explorer |
| Busca | `search.smartCase` | SearchPanel |
| Explorer | `explorer.confirmDelete` | FileExplorer |
| Abas | `workbench.editor.enablePreview` (App), `showTabs`, `wrapTabs`, `tabActionLocation`, `tabSizing`, `highlightModifiedTabs` | `applyWorkbench.ts` (`data-*`) + `styles/settings.css` |
| Layout | `workbench.sideBar.location`, `activityBar.location`, `panel.defaultLocation`, `fluent.ui.scale` | `useSyncedSetting` no App (arrastes/atalhos gravam com debounce) |
| Aparência / acessibilidade | `fluent.ui.density`, `fluent.ui.fontSize/fontFamily`, `workbench.statusBar.visible`, `workbench.reduceMotion`, `fluent.accessibility.highContrast/focusOutline`, `fluent.ui.reduceTransparency`, `fluent.window.acrylicFlyouts` | `applyWorkbench.ts` + `styles/settings.css`; acrílico em `theme/acrylic.ts` |
| Temas | `workbench.colorTheme`, `workbench.iconTheme` | `applyTheme.ts` → `src/theme/registry.ts` (interface; temas de extensões entram por `registerColorThemeProvider`) |
| Terminal | `terminal.integrated.font*`, `lineHeight`, `cursorStyle`, `cursorBlinking`, `scrollback`, `defaultProfile.<so>` + `profiles.<so>`, `fluent.terminal.shellPath/shellArgs` | `terminalSettings.ts` → TerminalView (ao vivo; shell só para terminais locais sem spawn de extensão) |
| Git | `git.autofetch`, `autofetchPeriod`, `confirmSync`, `avatars`, `repositoryScanMaxDepth` | App (autofetch/sync) e `git/gitSettings.ts` |
| Extensões | `extensions.autoCheckUpdates`, `autoUpdate`, `ignoreRecommendations` | `extensionsStore.ts`, view Extensões |
| Agentes de IA | `fluent.agents.defaultProvider`, `defaultMode` (bypass nunca é padrão) | `useFluentChat.ts` (vencem o "último usado") |
| Linguagens | `csharp.inlayHints.enabled`, `fluent.typescript.preferEditorVersion`, `fluent.razor.projection`, `fluent.lsp.logToFile` | módulos de `src/lsp/` |
| Monaco/LSP | `editor.tabSize`/`insertSpaces`/`detectIndentation`, `files.eol`, `files.associations` e as seções `python.*`, `yaml.*`, `json.*`, `css.*`, `html.*`, `typescript.*`… | `monacoBridge.ts` → `updateUserConfiguration` do serviço de configuração JÁ carregado (respostas de `workspace/configuration` dos servidores). `editor.semanticHighlighting.enabled` e `editor.wordBasedSuggestions` são sempre forçados aos valores do contrato do editor |

### EditorConfig

`.editorconfig` vence as settings (inclusive as de linguagem), como a extensão
EditorConfig do VS Code. O Rust (`editorconfig_chain`) devolve a cadeia até
`root = true`; `editorconfig.ts` faz o parse e o glob da spec.

| Propriedade | Efeito |
|---|---|
| `indent_style`, `indent_size`, `tab_width` | `insertSpaces`/`tabSize`/`indentSize` do modelo; desliga a detecção |
| `end_of_line` | EOL de arquivo novo (existentes mantêm o detectado) |
| `charset` | encoding de arquivo novo |
| `trim_trailing_whitespace`, `insert_final_newline` | pipeline de salvamento (depois do format-on-save) |
| `max_line_length` | régua extra |

O cache é invalidado quando um `.editorconfig` é salvo pelo app e quando a
janela volta ao foco (editado fora).

## Compatibilidade com os arquivos do VS Code

| Arquivo | O que o app faz |
|---|---|
| `.vscode/settings.json` | Camada workspace (pasta única) ou pasta (multi-root). Chaves mapeadas valem no app; as desconhecidas são preservadas e repassadas ao host de extensões. Escrita vai para `.fluent/settings.json` (ou `.vscode/`, por `fluent.settings.workspaceWriteTarget`). |
| `.code-workspace` | Lido como JSONC; pastas relativas ao arquivo (e `uri` `file://`) resolvidas; `settings` vira a camada workspace e a escrita no escopo Workspace edita o próprio arquivo (comentários preservados); `extensions.recommendations`, `tasks` e `launch` também são lidos. |
| `.vscode/extensions.json` | `recommendations` − `unwantedRecommendations` → seção "Recomendadas pelo workspace" da view Extensões (instala pelo catálogo Open VSX configurado). `extensions.ignoreRecommendations` esconde. |
| `.vscode/tasks.json` | Tipos `shell`/`process` (com `args`, `options.cwd`, blocos `windows`/`linux`/`osx`, `dependsOn` em sequência) e `npm` (`npm run <script>`, `path`) rodam no terminal integrado: seção "Do VS Code (.vscode)" do Executar e Depurar, Paleta "Tarefas: Executar Tarefa…" e **Ctrl+Shift+B** ("Executar Tarefa de Build": a `isDefault` do grupo build). Outros tipos aparecem desabilitados com o motivo. `problemMatcher` não é interpretado. |
| `.vscode/launch.json` | Sem depurador genérico: configurações `launch` de `node`/`pwa-node` (`node program`), `coreclr`/`clr`/`dotnet` (`dotnet program.dll` ou `dotnet run --project`) e `python`/`debugpy` viram "Executar sem depurar" (o `preLaunchTask` roda antes). `attach` e tipos sem equivalente ficam desabilitados — a depuração .NET continua pela seção netcoredbg. |
| Variáveis | `${workspaceFolder}`, `${workspaceFolderBasename}`, `${file}`, `${fileBasename}`, `${fileBasenameNoExtension}`, `${fileExtname}`, `${fileDirname}`, `${relativeFile}`, `${cwd}`, `${pathSeparator}`, `${env:X}` (vazio no WebView), `${config:x}` (settings). `${input:…}`/`${command:…}` ficam literais. |
| `.editorconfig` | Ver "EditorConfig" acima. |
| `keybindings.json` (usuário) | `<app_config>/User/keybindings.json`, formato do VS Code: `{ key, command, when?, args? }`; `-comando` remove um atalho padrão; acordes (`ctrl+k ctrl+s`). Ids do VS Code comuns são traduzidos (`workbench.action.files.save` → `menu.file.save`…, tabela em `keybindings.ts`); `editor.action.*` roda no editor focado e ids de extensões vão ao host. `when` suporta `!`, `&&`, `\|\|`, `==`, `!=`, `=~ /re/`, `<`/`>`, `in`/`not in` e as chaves `editorTextFocus`, `editorFocus`, `textInputFocus`, `inputFocus`, `terminalFocus`, `resourceLangId`, `resourceExtname`, `resourceFilename`, `resourcePath`, `sideBarVisible`, `workspaceFolderCount` e `config.*`. Ctrl e ⌘ são equivalentes (CtrlCmd), como nos menus. |
| `settings.json` do VS Code do usuário | Nunca lido nem escrito (regra das extensões hospedadas). |

### Execução estruturada de tarefas e launch

- `command` nos modelos de tarefas/launch é somente uma prévia de apresentação.
  Os dois pontos de entrada (view e Paleta/Ctrl+Shift+B) produzem um
  `TaskExecutionPlan` com executável, `args[]` e `cwd` separados até o Rust.
- `process` e programas de launch são executados por `std::process::Command`,
  sem PowerShell/`-Command` intermediário. Isso evita que `--%`, `$()` ou
  metacaracteres dos argumentos adquiram significado no binder PowerShell.
- `shell.command` continua sendo código intencional do interpretador. Seu
  `args[]` é transportado separadamente e citado na fronteira do shell; essa
  superfície preserva semântica de shell, não promete a semântica de argv de
  um processo nativo após comandos, funções ou scripts reinterpretarem dados.
  Para argv nativo literal, usar `process`/launch.
- Dependências são resolvidas antes do spawn, em ordem, com erro explícito para
  referências ausentes/ciclos. Cada cwd relativo é resolvido contra a raiz do
  plano, sem herdar o diretório da etapa anterior. Falha interrompe dependentes
  também no Windows (corrige a concatenação anterior com `;`).
- Um modo interno do app executa o plano no mesmo PTY e depois inicia o perfil
  interativo configurado. O payload não usa stdin, preservando entrada de
  programas interativos. O ambiente interno é removido antes dos filhos.
- O perfil configurado não pode fazer o plano ser ignorado: seleciona o prompt
  interativo após a execução. Comandos `shell` usam o interpretador padrão da
  plataforma. Os terminais de extensões mantêm seu contrato próprio.
- Planos estruturados são locais nesta etapa. SSH não deve ignorá-los nem
  convertê-los para uma string: deve informar que esse modo não é suportado.
- `.cmd`/`.bat` têm regras próprias. O backend usa a implementação nativa do
  Rust e não faz fallback para uma linha shell quando um argumento é recusado.
  O aceite inclui controle batch e caso adversarial no Windows.
- Antes de integrar: executar o teste explícito do runner em PTY com o app
  real, usando o binário **release GUI no Windows**, além dos testes de argv.
  Compilar/unidades no Linux não prova herança de stdin/stdout no ConPTY.

### Atalhos: convivência com o handler do App

O handler de teclado do `App.tsx` continua tratando os atalhos embutidos
(`DEFAULT_APP_KEYBINDINGS` os descreve como dados para a tela de atalhos). O
listener de `keybindingRuntime.ts` roda na fase de CAPTURA:

- regra do usuário (ou embutida que o App não trata, como `Ctrl+,`) → executa e
  consome a tecla;
- embutida tratada pelo App e não alterada → não intervém;
- embutida removida pelo usuário (`-comando`) → a tecla segue para o editor, mas
  o App a ignora (`isKeyClaimed` no início do `onKeyDown`);
- o 1º acorde de uma sequência nunca é consumido (os acordes do Monaco, como
  Ctrl+K Ctrl+C, continuam funcionando).

## Tela de Configurações e de Atalhos

- **Configurações** (`src/components/settings/SettingsEditor.tsx`, aba
  `fluentcoder://settings`, modo `settings`): abre por **Ctrl+,**, Paleta
  "Preferências: Abrir Configurações" ou a engrenagem "Gerenciar" da activity
  bar. Busca com destaque (`@modified`, `@lang:<id>` — edita o override
  `"[id]"` —, `@ext:<id>`, `@tag:<tag>`, `@id:<chave>`), árvore de categorias
  (vira um Select abaixo de 720 px), escopo Usuário / Workspace / Pasta (Select
  das raízes no multi-root), indicador de modificado + "Restaurar padrão",
  "Também modificado em…", controles por tipo (Switch, Select, número com
  stepper, texto, cor, lista; objetos → "Editar no settings.json"), pickers de
  tema/ícones a partir de `src/theme/registry.ts` e "Abrir settings.json" do
  escopo. Settings `application`/`machine` só no Usuário; `window` não vai
  para Pasta.
- **Atalhos de Teclado** (`KeybindingsEditor.tsx`, `fluentcoder://keybindings`):
  **Ctrl+K Ctrl+S**, Paleta ou Ajuda ▸ Atalhos de Teclado. Lista os comandos da
  Paleta com atalho, `when` e origem (Padrão/Usuário/Extensão), busca por
  comando ou tecla (`@source:user`), gravação de atalho (até 2 acordes),
  conflitos marcados e remover/restaurar — sempre por edição pontual do
  `keybindings.json`.
- **JSON**: `settingsJsonMonaco.ts` valida (`fluent-settings`: tipo, enum,
  mínimo/máximo, override de linguagem indevido, chave desconhecida como
  informação) e completa chaves/valores nos `settings.json`, no `settings` dos
  arquivos de workspace e os comandos do `keybindings.json` — na mesma instância
  do Monaco, sem servidor novo.
- Paleta: "Preferências: Abrir Configurações", "…do Usuário (JSON)", "…do
  Workspace (JSON)", "Abrir Atalhos de Teclado", "…(JSON)".
