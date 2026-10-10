/**
 * Opções de construção do editor Monaco (EditorPane). Módulo folha SEM
 * dependências de runtime para que os testes unit possam travar as opções
 * conquistadas a duras penas (hover acima, word-based suggestions off,
 * semantic highlighting nativo off) contra regressões — cada uma tem um
 * comentário explicando POR QUE não pode voltar ao default.
 */
import type * as MonacoNs from "monaco-editor";

export const EDITOR_OPTIONS: MonacoNs.editor.IStandaloneEditorConstructionOptions = {
  fontSize: 14,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  // Sticky scroll vem LIGADO por default no Monaco. Deixamos DESLIGADO por
  // padrão; o usuário pode reativar pelo menu de contexto/configurações.
  stickyScroll: { enabled: false },
  automaticLayout: true,
  tabSize: 2,
  // Debugger gutter: explicit so breakpoint glyphs always have a lane.
  glyphMargin: true,
  // Indentation: keep Monaco's smartest auto-indent on, detect the file's
  // own tabs/spaces, and let the language server format on type/paste so
  // code stays properly indented (VSCode-like) across languages.
  autoIndent: "full",
  detectIndentation: true,
  formatOnType: true,
  formatOnPaste: true,
  padding: { top: 12 },
  mouseWheelZoom: true,
  // Hover ACIMA da linha (como o VS Code), caindo pra baixo só quando não
  // cabe em cima. O default do Monaco é `above: false`, que renderiza o
  // balão embaixo e cobre a linha seguinte — o texto que o usuário ia
  // clicar. `above: true` restaura o posicionamento do VS Code.
  hover: { above: true },
  // Suggest (IntelliSense) widget sizing. Monaco derives each row's
  // height from `suggestLineHeight` or, when 0, the editor's computed
  // `fontInfo.lineHeight`. Pinning both font size and line height keeps
  // the virtual list rows tall enough for the label + 22px type icon, so
  // entries don't overlap into an unreadable, doubled list.
  suggestFontSize: 13,
  suggestLineHeight: 22,
  // Desliga as sugestões baseadas em palavras do documento (os itens com
  // ícone `abc`). Na stack @codingame/v10 elas vêm LIGADAS por default e
  // poluíam o autocomplete do `.cshtml`: ao digitar `@Model` apareciam
  // palavras soltas do arquivo em vez (ou antes) dos membros C# do Roslyn,
  // e enquanto a completion da projeção (mais lenta) ainda não respondia,
  // só o lixo `abc` aparecia. Com isso off, só os providers reais
  // (Roslyn via projeção + HTML) preenchem o widget.
  wordBasedSuggestions: "off",
  // Semantic highlighting NATIVO desligado na stack monaco-languageclient
  // v10. Motivo (comprovado por experimento — ver docs/migration): a stack
  // `@codingame/monaco-vscode-api` resolve as cores de semantic tokens
  // pelo serviço de tema do VS Code (que exige theme/textmate
  // service-overrides + `semanticTokenColors`), NÃO pelas `rules` do
  // `defineTheme` standalone. Com o flag ligado, os semantic tokens do
  // Roslyn sobrescreviam a camada Monarch e ficavam SEM cor — deixando o
  // C# inteiro apagado. O Monarch (`csharpMonarch` em monacoSetup.ts)
  // colore o léxico via `rules` do tema, e a classificação semântica fina
  // do Roslyn (class vs struct vs enum, método vs variável) é aplicada
  // por DECORATIONS pelo bridge de semantic tokens — ver
  // src/lsp/semanticColorizer.ts. Este flag deve permanecer false: ligar
  // o engine nativo reintroduziria a camada sem cor POR CIMA de tudo.
  "semanticHighlighting.enabled": false,
};
