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
