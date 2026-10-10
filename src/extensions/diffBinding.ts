/**
 * Liga a revisão do Monaco (`ClaudeDiffReview`) de um diff aberto por uma
 * extensão ao documento do lado direito no host, como o editor de diff do VS
 * Code faz:
 *
 * - threads de comentário do lado direito (barra Aceitar/Rejeitar por hunk do
 *   Claude Code) viram widgets no editor modificado;
 * - decorações da extensão no lado direito (a faixa lateral dos hunks);
 * - edições da EXTENSÃO no lado direito (`diffContent`, ex.: rejeitar um hunk)
 *   entram no modelo como edição desfazível;
 * - edições do USUÁRIO no lado direito vão ao host (`diffEdited`), e a
 *   extensão recalcula os hunks (onDidChangeTextDocument).
 */
import * as monaco from "monaco-editor";
import { extHost } from "./client";
import { attachCommentWidgets } from "./commentWidgets";
import { extDecorationType } from "./editorBridge";
import { toMonacoRange } from "./editorModel";
import type { HostEvent, PlainRange } from "./protocol";
import { minimalEdit } from "./textEdits";

type DecoItems = { range: PlainRange; hoverMessage?: string }[];

/** Últimas decorações por uri virtual (podem chegar antes da revisão montar). */
const latestDecorations = new Map<string, Map<string, DecoItems>>();
const decoListeners = new Set<(uri: string, key: string, items: DecoItems) => void>();

extHost.on((ev: HostEvent) => {
  if (ev.event === "decorations") {
    const e = ev as { uri?: string; key: string; items: DecoItems };
    if (!e.uri) return;
    const map = latestDecorations.get(e.uri) ?? new Map<string, DecoItems>();
    map.set(e.key, e.items);
    latestDecorations.set(e.uri, map);
    decoListeners.forEach((l) => l(e.uri!, e.key, e.items));
  } else if (ev.event === "closeDiff") {
    latestDecorations.delete((ev as { right: string }).right);
  } else if (ev.event === "hostExit") {
    latestDecorations.clear();
  }
});

const EDIT_DEBOUNCE_MS = 150;

export function bindExtDiffEditor(diffId: string, rightUri: string, editor: monaco.editor.IStandaloneDiffEditor): () => void {
  const modified = editor.getModifiedEditor();
  const model = modified.getModel();
  const subs: monaco.IDisposable[] = [];
  subs.push(attachCommentWidgets(modified, (t) => t.uri === rightUri));

  // ---- decorações da extensão no lado direito
  const decoIds = new Map<string, string[]>();
  const applyDeco = (key: string, items: DecoItems) => {
    const type = extDecorationType(key);
    const m = modified.getModel();
    if (!type || !m) return;
    const next = items.map((it) => ({
      range: toMonacoRange(it.range) as monaco.IRange,
      options: { ...type.options, ...(it.hoverMessage ? { hoverMessage: { value: it.hoverMessage } } : {}) } as monaco.editor.IModelDecorationOptions,
    }));
    decoIds.set(key, m.deltaDecorations(decoIds.get(key) ?? [], next));
  };
  latestDecorations.get(rightUri)?.forEach((items, key) => applyDeco(key, items));
  const onDeco = (uri: string, key: string, items: DecoItems) => uri === rightUri && applyDeco(key, items);
  decoListeners.add(onDeco);

  // ---- extensão → modelo (desfazível) e usuário → host
  let applying = false;
  let timer: number | undefined;
  const offHost = extHost.on((ev) => {
    if (ev.event !== "diffContent" || (ev as { diffId: string }).diffId !== diffId) return;
    const text = (ev as { text: string }).text;
    const m = modified.getModel();
    if (!m || m.getValue() === text) return;
    const edit = minimalEdit(m.getValue(), text);
    if (!edit) return;
    applying = true;
    try {
      const start = m.getPositionAt(edit.start);
      const end = m.getPositionAt(edit.end);
      m.pushStackElement();
      m.pushEditOperations([], [{ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: edit.text }], () => null);
      m.pushStackElement();
    } finally {
      applying = false;
    }
  });
  if (model) {
    subs.push(
      model.onDidChangeContent(() => {
        if (applying) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          const m = modified.getModel();
          if (m) void extHost.notify("diffEdited", { diffId, text: m.getValue() });
        }, EDIT_DEBOUNCE_MS);
      }),
    );
  }

  return () => {
    window.clearTimeout(timer);
    offHost();
    decoListeners.delete(onDeco);
    subs.forEach((s) => s.dispose());
  };
}
