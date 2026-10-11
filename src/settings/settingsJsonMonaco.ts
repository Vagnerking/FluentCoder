/**
 * Liga `settingsJson.ts` ao Monaco (a MESMA instância de `monaco-loader.ts`):
 * marcadores (owner `fluent-settings`) e completion de chaves/valores/comandos
 * nos arquivos de configuração. Só age em modelos cujo caminho é um arquivo de
 * configuração; não registra servidor de linguagem nem outro Monaco.
 */
import * as monaco from "monaco-editor";
import { fromFileUri } from "../lsp/uri";
import { settingsRegistry } from "./instance";
import { completionContext, defaultValueText, settingsDiagnostics, settingsFileKind } from "./settingsJson";
import { settingTitle } from "./settingsSearch";
import { getAppCommands } from "./keybindingRuntime";

const OWNER = "fluent-settings";

function kindOf(model: monaco.editor.ITextModel) {
  if (model.uri.scheme !== "file") return null;
  return settingsFileKind(fromFileUri(model.uri.toString()));
}

function validate(model: monaco.editor.ITextModel): void {
  const kind = kindOf(model);
  if (!kind) return;
  const text = model.getValue();
  const known = new Set(getAppCommands().map((c) => c.id));
  const diags = settingsDiagnostics(text, kind, settingsRegistry, (id) => known.has(id) || id.includes(".") );
  monaco.editor.setModelMarkers(
    model,
    OWNER,
    diags.map((d) => {
      const a = model.getPositionAt(d.offset);
      const b = model.getPositionAt(d.offset + Math.max(1, d.length));
      return {
        startLineNumber: a.lineNumber,
        startColumn: a.column,
        endLineNumber: b.lineNumber,
        endColumn: b.column,
        message: d.message,
        severity: d.severity === "error" ? monaco.MarkerSeverity.Error : d.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        source: "Configurações",
      };
    }),
  );
}

let installed = false;

export function installSettingsJsonSupport(): void {
  if (installed) return;
  installed = true;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watch = (model: monaco.editor.ITextModel) => {
    if (!kindOf(model)) return;
    validate(model);
    model.onDidChangeContent(() => {
      const k = model.uri.toString();
      clearTimeout(timers.get(k));
      timers.set(k, setTimeout(() => !model.isDisposed() && validate(model), 250));
    });
  };
  monaco.editor.getModels().forEach(watch);
  monaco.editor.onDidCreateModel(watch);
  settingsRegistry.onDidChange(() => monaco.editor.getModels().forEach((m) => kindOf(m) && validate(m)));

  monaco.languages.registerCompletionItemProvider(["json", "jsonc"], {
    triggerCharacters: ['"', ":"],
    provideCompletionItems(model, position) {
      const kind = kindOf(model);
      if (!kind) return { suggestions: [] };
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const ctx = completionContext(text, offset, kind);
      if (!ctx) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const line = model.getLineContent(position.lineNumber);
      // Faixa: do início da string (aspas) até o cursor/fim da string.
      let start = word.startColumn;
      while (start > 1 && /[\w.\-[\]"]/.test(line[start - 2])) start--;
      let end = position.column;
      while (end <= line.length && /[\w.\-[\]"]/.test(line[end - 1])) end++;
      const range = new monaco.Range(position.lineNumber, start, position.lineNumber, end);
      if (ctx.kind === "command") {
        return {
          suggestions: getAppCommands().map((c) => ({
            label: c.id,
            detail: c.title,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: c.id,
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          })),
        };
      }
      if (ctx.kind === "key") {
        const existing = new Set(ctx.existing);
        return {
          suggestions: settingsRegistry
            .all()
            .filter((s) => !existing.has(s.key) && (!ctx.inLanguage || s.scope === "language-overridable"))
            .map((s) => ({
              label: s.key,
              detail: settingTitle(s),
              documentation: s.description,
              kind: monaco.languages.CompletionItemKind.Property,
              insertText: `"${s.key}": ${defaultValueText(s)}`,
              filterText: `"${s.key}"`,
              range,
            })),
        };
      }
      const s = settingsRegistry.get(ctx.key);
      if (!s) return { suggestions: [] };
      const values: unknown[] = s.enum ? [...s.enum] : (Array.isArray(s.type) ? s.type : [s.type]).includes("boolean") ? [true, false] : [s.default];
      return {
        suggestions: values.map((v, i) => ({
          label: JSON.stringify(v),
          detail: s.enumLabels?.[i] ?? (JSON.stringify(v) === JSON.stringify(s.default) ? "padrão" : undefined),
          kind: monaco.languages.CompletionItemKind.Value,
          insertText: JSON.stringify(v),
          range: new monaco.Range(position.lineNumber, word.startColumn - (line[word.startColumn - 2] === '"' ? 1 : 0), position.lineNumber, end),
        })),
      };
    },
  });
}
