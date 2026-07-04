/**
 * Colorização semântica por DECORATIONS (bugfix: tipos C# sem cor no v10).
 *
 * Na stack `@codingame/monaco-vscode-api` o engine nativo de semantic
 * highlighting resolve cores pelo serviço de tema do VS Code (exige
 * theme/textmate service-overrides + `semanticTokenColors`) — NÃO pelas
 * `rules` do `defineTheme` standalone que o app usa. Com o engine ligado, os
 * tokens do Roslyn sobrescreviam o Monarch SEM cor (C# inteiro apagado); por
 * isso `'semanticHighlighting.enabled'` fica `false` no EditorPane.
 *
 * Este módulo é o caminho alternativo: o bridge de semantic tokens
 * (client.ts) puxa `textDocument/semanticTokens` do servidor e entrega o
 * stream cru aqui, que o converte em decorations `inlineClassName` com a
 * paleta própria (mesmas cores das `rules` do tema). O Monarch continua dono
 * do léxico (keywords/strings/comentários — tipos de token fora do mapa
 * abaixo não geram decoration); a camada semântica só pinta o que o léxico
 * não alcança: tipos, membros, parâmetros, namespaces etc.
 */
import * as monaco from "monaco-editor";

/**
 * Paleta por tipo de token semântico (Dark+; espelha as `rules` de
 * `fluent-acrylic-dark` no EditorPane). Tipos ausentes ficam com a cor do
 * Monarch/foreground — deliberado para keyword/string/comment/number, que o
 * léxico já cobre com escopos mais específicos.
 */
const SEMANTIC_TOKEN_COLORS: Record<string, string> = {
  namespace: "4EC9B0",
  type: "4EC9B0",
  class: "4EC9B0",
  recordClass: "4EC9B0",
  struct: "86C691",
  recordStruct: "86C691",
  interface: "B8D7A3",
  enum: "B8D7A3",
  delegate: "B8D7A3",
  typeParameter: "4EC9B0",
  enumMember: "4FC1FF",
  constant: "4FC1FF",
  parameter: "9CDCFE",
  variable: "9CDCFE",
  property: "9CDCFE",
  field: "9CDCFE",
  method: "DCDCAA",
  member: "DCDCAA",
  function: "DCDCAA",
  extensionMethod: "DCDCAA",
  event: "DCDCAA",
  // Nomes usados quando as extensões de protocolo do Visual Studio estão
  // ativas no Roslyn (o LSP padrão usa os nomes acima).
  "class name": "4EC9B0",
  "record class name": "4EC9B0",
  "struct name": "86C691",
  "record struct name": "86C691",
  "interface name": "B8D7A3",
  "enum name": "B8D7A3",
  "delegate name": "B8D7A3",
  "type parameter name": "4EC9B0",
  "enum member name": "4FC1FF",
  "constant name": "4FC1FF",
  "parameter name": "9CDCFE",
  "local name": "9CDCFE",
  "property name": "9CDCFE",
  "field name": "9CDCFE",
  "method name": "DCDCAA",
  "extension method name": "DCDCAA",
  "event name": "DCDCAA",
  "namespace name": "4EC9B0",
};

/** Backstop contra streams patológicos (arquivos gerados gigantes). */
const MAX_TOKENS_PER_MODEL = 50_000;

const cssClassByType = new Map<string, string>();
let styleElement: HTMLStyleElement | undefined;

/** `class name` → `fluent-sem-class-name` (uma classe CSS válida por tipo). */
function cssClassFor(tokenType: string): string | undefined {
  const cached = cssClassByType.get(tokenType);
  if (cached) return cached;
  if (!(tokenType in SEMANTIC_TOKEN_COLORS)) return undefined;
  const cls = `fluent-sem-${tokenType.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  cssClassByType.set(tokenType, cls);
  return cls;
}

/**
 * Injeta a folha de estilos uma única vez. `.monaco-editor .fluent-sem-*`
 * ganha em especificidade da classe de token do Monarch (`.mtk*`), então a
 * camada semântica pinta por cima do léxico sem `!important`.
 */
function ensureStylesInjected(): void {
  if (styleElement) return;
  const rules = Object.entries(SEMANTIC_TOKEN_COLORS)
    .map(([type, color]) => `.monaco-editor .${cssClassFor(type)} { color: #${color}; }`)
    .join("\n");
  styleElement = document.createElement("style");
  styleElement.setAttribute("data-fluent-semantic-tokens", "");
  styleElement.textContent = rules;
  document.head.appendChild(styleElement);
}

/** Ids de decoration vivos por model (chave: uri como string). */
const decorationIdsByModel = new Map<string, string[]>();

/** Remove as decorations semânticas de um model (dispose/idioma trocado). */
export function clearSemanticTokenDecorations(
  model: monaco.editor.ITextModel
): void {
  const key = model.uri.toString();
  const previous = decorationIdsByModel.get(key);
  if (previous && previous.length > 0 && !model.isDisposed()) {
    model.deltaDecorations(previous, []);
  }
  decorationIdsByModel.delete(key);
}

/**
 * Decodifica o stream LSP (`deltaLine`, `deltaStart`, `length`, `typeIndex`,
 * `modifiers` — 5 uints por token) e aplica as decorations no model,
 * substituindo atomicamente as da rodada anterior.
 */
export function applySemanticTokenDecorations(
  model: monaco.editor.ITextModel,
  data: number[],
  legend: { tokenTypes: string[] }
): void {
  if (model.isDisposed()) return;
  ensureStylesInjected();

  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  const tokenCount = Math.floor(data.length / 5);
  if (tokenCount <= MAX_TOKENS_PER_MODEL) {
    let line = 0;
    let character = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      const deltaLine = data[i];
      line += deltaLine;
      character = deltaLine === 0 ? character + data[i + 1] : data[i + 1];
      const length = data[i + 2];
      const tokenType = legend.tokenTypes[data[i + 3]];
      if (!tokenType || length <= 0) continue;
      const inlineClassName = cssClassFor(tokenType);
      if (!inlineClassName) continue;
      decorations.push({
        range: new monaco.Range(line + 1, character + 1, line + 1, character + 1 + length),
        options: {
          inlineClassName,
          // Não crescer com o que for digitado nas bordas do token.
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
  }
  // tokenCount acima do teto: aplica lista vazia (limpa a camada semântica e
  // deixa só o Monarch — melhor que travar a UI com dezenas de milhares de
  // decorations num arquivo gerado).

  const key = model.uri.toString();
  const previous = decorationIdsByModel.get(key) ?? [];
  decorationIdsByModel.set(key, model.deltaDecorations(previous, decorations));
}
