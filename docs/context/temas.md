# Temas e contribuições declarativas de extensões

Temas de cor, temas de ícones de arquivo, ícones de produto, gramáticas
TextMate, linguagens e snippets — os do app e os que extensões VS Code
contribuem — aplicados **sem executar código** da extensão (modo "somente
contribuições"). Segurança e portão de extensões: [Extensões VS Code](extensoes-vscode.md).

## Modo "somente contribuições"

`src/extensions/contributions/policy.ts` (puro, testado) decide, por extensão
instalada (`extensions_list`):

| Situação | Contribuições declarativas |
|---|---|
| Desabilitada | não |
| Sem `main`/`browser` | **sim** ("sem código"); o classificador dá **Compatível** com o motivo `no-code` |
| Código liberado pelo portão (Compatível/Parcial, ou Não avaliada com liberação) | sim, e o host roda o código |
| Código bloqueado (Incompatível, Não avaliada, portão de outra versão) | sim se `extensions.applyContributionsWhenCodeBlocked` (padrão `true`); o classificador avisa `contributions-only` |

Pontos declarativos: `themes`, `iconThemes`, `productIconThemes`, `grammars`,
`languages`, `snippets` (`capabilities.json` = `supported`; ícones de produto
`partial`). Extensão sem código com `engines.vscode` acima do shim não é
bloqueada (`engine-no-code`).

`src/extensions/contributions/source.ts` mantém a lista (boot em
`src/theme/boot.ts` e a cada mudança do view Extensões) e lê os arquivos como
TEXTO pelo Rust. Os motores assinam `onDidChangeContributions`.

### Regras de segurança

1. **Leitura** só por `extensions_read_contribution(id, path, file)`
   (`src-tauri/src/extensions/contrib.rs`): pasta da extensão validada como em
   `extensions_local_details` (filha direta da pasta do app ou do VS Code,
   `package.json` do mesmo id), caminho relativo limpo (o app normaliza
   `./`/`../`; fora da raiz = recusa), **realpath** dentro da pasta, só
   `json/jsonc/code-snippets/tmTheme/tmLanguage/plist/xml/json5`, ≤ 4 MB.
2. **Ativos** (ícones, fontes) só pelo protocolo `fcext://localhost/<id>/<caminho>`
   (`http://fcext.localhost/…` no Windows): só extensões já registradas por uma
   leitura, svg ≤ 512 KB, png/jpg/gif/webp ≤ 1 MB, woff/woff2/ttf/otf ≤ 2 MB,
   barra codificada no segmento → 400, fora da pasta → 403. SVG sanitizado
   (`<script>`, `<foreignObject>`, `on*=`, `href` que não seja `#id` ou
   `data:image/` raster, `<!ENTITY>`) e servido com CSP `default-src 'none'`
   + `nosniff`; CORS só para a origem do app (fontes).
3. **SVG nunca inline no DOM**: sempre `<img>`/`url()`.
4. **JSON/plist** com teto de tamanho e profundidade (`jsonc.ts`, `plist.ts`);
   `include` de tema ≤ 8 níveis, sem ciclo, dentro da pasta.
5. **Cores** só `#rgb[a]`/`#rrggbb[aa]` (`src/theme/colors.ts`); nada de
   `url()`/`var()` no CSS gerado. Glifos de fonte = um code point; ids de
   codicon `[a-z0-9-]`.
6. **ReDoS** (`src/editor/textmate/redos.ts`): ver "Gramáticas".
7. **Snippets** são texto; `CLIPBOARD` lê a área de transferência (resolvida
   pelo Monaco, só ao inserir).

## Registro de temas (interface para a UI de configurações)

`src/theme/registry.ts` — a ÚNICA API que a UI (frente F, seletores, view
Extensões) usa:

```ts
themeRegistry.list(kind)                 // ThemeEntry[]: embutidos + extensões
themeRegistry.get(kind, id)
themeRegistry.active(kind)               // aplicado agora (prévia inclusa)
themeRegistry.configured(kind)           // id salvo (pode ainda não estar na lista)
await themeRegistry.apply(kind, id)      // aplica e salva
await themeRegistry.apply(kind, id, { preview: true }) // só pré-visualiza
await themeRegistry.restore(kind)        // volta ao salvo (Esc no seletor)
themeRegistry.onDidChange((e) => …)      // { kind, type: "list" | "active", preview? }
```

| kind | setting | padrão |
|---|---|---|
| `color` | `workbench.colorTheme` | `Fluent Escuro` |
| `fileIcon` | `workbench.iconTheme` | `material-icon-theme` |
| `productIcon` | `workbench.productIconTheme` | `Default` |

Ids = os do VS Code (`id` ?? `label` de `contributes.themes[]`). Tema salvo de
extensão ainda não carregada: vale o padrão (a setting fica) e ele volta
sozinho quando aparecer. Persistência via `src/theme/settingsAdapter.ts`
(`localStorage` por enquanto; `setSettingsBackend(core)` aponta para o núcleo
de settings quando existir — nenhum consumidor muda). Outras settings:
`fluent.theme.applyToUi` (padrão `true`; `false` = só editor e terminal),
`extensions.applyContributionsWhenCodeBlocked`,
`editor.snippetSuggestions.enabled`.

Seletores: `src/theme/ThemePicker.tsx` — Paleta "Preferências: Tema de
Cores" / "Tema de Ícones de Arquivo" / "Tema de Ícones do Produto" e os
botões "Aplicar tema"/"Aplicar ícones" do view Extensões; setas = prévia ao
vivo, Enter salva, Esc restaura.

## Temas de cor

- Embutidos (`builtinThemes.ts`): **Fluent Escuro** (`fluent-acrylic-dark`,
  as regras/cores que viviam no EditorPane; não sobrescreve `tokens.css`),
  **Fluent Claro** e **Alto Contraste** (tokens próprios).
- De extensão (`colorThemeModel.ts`): JSONC, `include`, `tokenColors` como
  array ou caminho `.tmTheme`/JSON, `semanticTokenColors`, `uiTheme` do
  manifesto.
- **Editor**: caminho standalone (`defineTheme`, ADR 0003 — o
  theme-service-override não é usado). `monacoTheme.ts` gera as regras:
  tokens Monarch → escopo TextMate representativo (`MONARCH_SCOPES`),
  categorias semânticas/Roslyn → `semanticTokenColors` ou escopo padrão do VS
  Code (`SEMANTIC_SCOPES`), e `tm.<cor>[.<estilo>]` para as gramáticas
  TextMate. Seleção de estilo = `tmScopes.ts` (prefixo por segmentos,
  ancestrais, especificidade; cor e estilo resolvidos à parte). As
  categorias obrigatórias de [editor.md](editor.md) ("Cores") SEMPRE têm regra.
- **UI**: `vscodeThemeMap.ts` (`TOKEN_MAP`) — tabela workbench → tokens Fluent:

| Token | Chaves VS Code (ordem) | Reserva |
|---|---|---|
| `--editor-bg` | `editor.background` | — |
| `--sidebar-bg`, `--acrylic-tint(-strong)` | `sideBar.background`, `panel.background` | fundo do editor |
| `--shell-bg(-solid)`, `--titlebar-bg` | `titleBar.activeBackground`, `activityBar.background`, `statusBar.background` | editor escurecido 25% |
| `--tabbar-bg` | `editorGroupHeader.tabsBackground`, `tab.inactiveBackground` | barra lateral |
| `--color-surface-overlay/raised/flyout-acrylic` | `editorWidget.background`, `menu.background`, `quickInput.background`, `dropdown.background` | mistura 6% (sempre opaco) |
| `--color-surface-overlay-border` | `editorWidget.border`, `menu.border`, `widget.border`, `contrastBorder` | texto 20% |
| `--text` | `foreground`, `sideBar.foreground`, `editor.foreground` | — (AA 4,5:1) |
| `--text-secondary` | `sideBarTitle.foreground`, `sideBar.foreground` | texto 82% (AA) |
| `--text-muted` | `descriptionForeground`, `tab.inactiveForeground` | texto 60% (3:1) |
| `--text-disabled` | `disabledForeground` | texto 38% |
| `--accent`, `--stroke-focus` | `activityBarBadge.background`, `progressBar.background`, `focusBorder`, `textLink.foreground`, `button.background` | (3:1 contra o editor) |
| `--accent-strong/hover/pressed`, `--text-on-accent` | `button.background`, `button.hoverBackground`, `activityBarBadge.foreground`, `button.foreground` | derivados do acento |
| `--acrylic-control(-hover/-pressed)` | `input.background`, `toolbar.hoverBackground`, `list.hoverBackground`, `toolbar.activeBackground` | texto 7,5/12/5,5% |
| `--acrylic-border(-strong)`, `--border-subtle`, `--stroke` | `widget.border`, `sideBar.border`, `panel.border`, `input.border`, `editorGroup.border`, `tree.indentGuidesStroke` | texto 13/20/8/6% |
| `--fill-selected(-hover)` | `list.activeSelectionBackground`, `list.focusBackground` | acento 16/22% |
| status (`--color-status-*`, `--error`) | `editorError/Warning.foreground`, `errorForeground`, `testing.iconPassed`… | paleta VS Code |
| git (`--color-git-*`) | `gitDecoration.*ResourceForeground` | paleta VS Code |
| busca (`--color-find-match(-strong)`) | `editor.findMatchHighlightBackground`, `editor.findMatchBackground` | âmbar |

  Raios, espaçamento, tipografia, motion e estados continuam do Fluent 2.
- **Terminal**: `terminal.*`/`terminal.ansi*` (reserva: paleta ANSI do VS
  Code); xterm troca ao vivo.
- **Webviews de extensão**: `--vscode-*` = tokens Fluent derivados + as
  `colors` do tema; `kind` claro/escuro/alto contraste; troca ao vivo (mensagem
  `theme` ao iframe) e `window.activeColorTheme`/`onDidChangeActiveColorTheme`
  no host.
- O último tema aplicado fica em cache (`fluent.theme.colorCache`) e entra
  antes do 1º paint.

## Temas de ícones de arquivo

`src/icon-theme/engine.ts` (puro, testado) resolve na ordem do VS Code:
arquivo = `fileNames` → `fileExtensions` (composta mais longa primeiro) →
`languageIds` (id do `languageForFile`) → `file`; pasta = raiz do workspace
(`rootFolderNames*`/`rootFolder*`) → `folderNamesExpanded` → `folderNames` →
`folderExpanded` → `folder`; `light`/`highContrast` seguem o tema de cor.
`iconThemeService.ts`: Material embutido (padrão; uma extensão com o mesmo id
o substitui), "Nenhum" e os de extensão (SVG/PNG via `fcext`, ou glifos com
`@font-face`). Todos os consumidores usam `<FileIcon>` (Explorer, abas,
breadcrumbs, Quick Open, busca, Git). Limitação: chaves `fileNames` com pasta
(`pasta/arquivo`) não são suportadas.

## Ícones de produto

`src/icons/productIconTheme.ts` + `productIconCss.ts`: troca o glifo de
`.codicon-<id>` (UI e Monaco) por CSS gerado e validado. Melhor esforço.

## Linguagens e gramáticas

`src/editor/textmate/`:

- `contributedLanguages.ts`: `languages` (extensions, filenames,
  filenamePatterns, firstLine, aliases) e `grammars` (scopeName, path,
  embeddedLanguages, injectTo). **Precedência**: `PROTECTED_LANGUAGES` (C#,
  Razor/CSHTML, TS/JS/JSON/CSS/SCSS/Less/HTML) nunca recebem mapeamento,
  gramática, configuração nem injeção de extensão. Nos demais, a linguagem
  contribuída vence o fallback nativo de `languageForFile` (ex.: `.toml`).
- `languageConfig.ts`: `language-configuration.json` → `setLanguageConfiguration`.
- `grammarService.ts`: vscode-textmate + Oniguruma do Shiki, preguiçosos;
  `include` de gramáticas contribuídas ou embutidas do Shiki; re-tokeniza ao
  trocar de tema; modelos já abertos ganham a linguagem/gramática.
- **ReDoS** (`redos.ts`): (1) estático — teto por regex (16 KB; 1 KB nas de
  configuração) e recusa de quantificador aninhado (`(a+)+`) e alternância
  repetida (`(a|a)*`): a gramática inteira é recusada; (2) compilação no
  Oniguruma antes de usar; (3) tempo — `timeLimit` de 50 ms por linha, linha
  > 20 000 caracteres sem cor, 5 estouros desligam a gramática (saída
  "Extensões"); regex de configuração medidas em entradas adversariais (25 ms)
  e descartadas se lentas. A tokenização roda na thread do Monaco (sem worker
  hoje); o Oniguruma ainda limita retries internamente.

## Snippets

`src/editor/snippets/`: `contributes.snippets`, `<config>/snippets/<linguagem>.json`
e `*.code-snippets` do usuário (`snippets_user_list`, Rust) e
`.vscode/*.code-snippets` da pasta local aberta. Um provedor por linguagem
(nunca `cshtml`/`aspnetcorerazor`/`razor`), recriado sem acumular; itens
abaixo do LSP. Variáveis de arquivo/workspace/data/aleatórias resolvidas pelo
app; seleção/área de transferência pelo SnippetController.

## Aceite

- Unitários: `src/theme/themes.test.ts` (mapeamento, seleção TextMate,
  include/tmTheme, regras obrigatórias, registro), `src/icon-theme/engine.test.ts`
  (ordem de resolução), `src/icons/productIconCss.test.ts`,
  `src/editor/textmate/textmate.test.ts` (ReDoS, configuração, precedência,
  gramática real no Oniguruma), `src/editor/snippets/snippetParser.test.ts`,
  `src/extensions/contributions/contributions.test.ts`; Rust:
  `cargo test --lib extensions::contrib`.
- Visual (headless WebKitGTK, extensões reais do Open VSX numa pasta
  temporária): Dracula, One Dark Pro, GitHub Theme, vscode-icons, Material
  Icon Theme, Prisma e Even Better TOML — temas de cor, ícones no Explorer/
  abas, gramáticas Prisma/TOML e prévia ao vivo na Paleta.
