/**
 * Affordance "+" para comentar (como o VS Code): nas linhas que algum
 * `CommentController.commentingRangeProvider` declara comentáveis, a área de
 * decorações de linha mostra uma faixa discreta e, ao passar o mouse, um "+".
 * Clicar (ou a ação "Adicionar comentário" do menu de contexto) pede ao host
 * um thread vazio (`commentCreateThread`) na linha — ou na seleção, se ela
 * começa na linha — e o widget do thread abre com a caixa de texto.
 */
import * as monaco from "monaco-editor";
import { extHost, extLog } from "./client";
import { commentableLines, controllerForLine, type CommentingRanges } from "./comments";
import type { PlainRange } from "./protocol";

const REFRESH_MS = 400;

export function attachCommentingRanges(editor: monaco.editor.ICodeEditor, uriOf: () => string | null): monaco.IDisposable {
  let ranges: CommentingRanges[] = [];
  let rangeDecos: string[] = [];
  let hoverDecos: string[] = [];
  let timer: number | undefined;
  let seq = 0;
  let disposed = false;
  // Editores standalone (os do app) têm context keys e ações; os demais só o "+".
  const sa = editor as Partial<monaco.editor.IStandaloneCodeEditor>;
  const commentable = typeof sa.createContextKey === "function" ? sa.createContextKey<boolean>("fluentExtCommentable", false) : { set() {} };

  const updateCursorKey = () => {
    const pos = editor.getPosition();
    commentable.set(!!pos && controllerForLine(ranges, pos.lineNumber - 1) !== null);
  };

  const paint = () => {
    const model = editor.getModel();
    if (!model) return;
    const lines = commentableLines(ranges).filter((l) => l < model.getLineCount());
    rangeDecos = editor.deltaDecorations(
      rangeDecos,
      lines.map((l) => ({
        range: new monaco.Range(l + 1, 1, l + 1, 1),
        options: { linesDecorationsClassName: "ext-commenting-range" },
      })),
    );
    updateCursorKey();
  };

  const refresh = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const uri = uriOf();
      const my = ++seq;
      if (!uri || !extHost.running) {
        ranges = [];
        paint();
        return;
      }
      void extHost
        .call("commentingRanges", { uri })
        .then((r) => {
          if (disposed || my !== seq) return;
          ranges = Array.isArray(r) ? (r as CommentingRanges[]) : [];
          paint();
        })
        .catch(() => {
          /* host fora do ar: sem "+" */
        });
    }, REFRESH_MS);
  };

  const setHover = (line: number | null) => {
    hoverDecos = editor.deltaDecorations(
      hoverDecos,
      line === null ? [] : [{ range: new monaco.Range(line, 1, line, 1), options: { linesDecorationsClassName: "ext-comment-add" } }],
    );
  };

  /** Cria o rascunho na linha (1-based) — ou na seleção que começa nela. */
  const startThread = (line: number) => {
    const controllerId = controllerForLine(ranges, line - 1);
    const uri = uriOf();
    if (!controllerId || !uri) return;
    const sel = editor.getSelection();
    let range: PlainRange = { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 0 } };
    if (sel && !sel.isEmpty() && sel.startLineNumber <= line && sel.endLineNumber >= line && controllerForLine(ranges, sel.endLineNumber - 1) === controllerId) {
      range = { start: { line: sel.startLineNumber - 1, character: sel.startColumn - 1 }, end: { line: sel.endLineNumber - 1, character: sel.endColumn - 1 } };
    }
    void extHost
      .call("commentCreateThread", { controllerId, uri, range })
      .then((r) => {
        const res = r as { ok: boolean; error?: string } | null;
        if (!res?.ok) extLog("novo comentário recusado", res?.error);
      })
      .catch((err) => extLog("novo comentário falhou", err));
  };

  const subs: monaco.IDisposable[] = [
    editor.onDidChangeModel(() => {
      ranges = [];
      rangeDecos = editor.deltaDecorations(rangeDecos, []);
      setHover(null);
      refresh();
    }),
    editor.onDidChangeModelContent(() => refresh()),
    editor.onDidChangeCursorPosition(() => updateCursorKey()),
    editor.onMouseMove((e) => {
      const t = e.target;
      const line = t.position?.lineNumber ?? null;
      const onGutter = t.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || t.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
      setHover(onGutter && line !== null && controllerForLine(ranges, line - 1) !== null ? line : null);
    }),
    editor.onMouseLeave(() => setHover(null)),
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !e.target.position) return;
      const line = e.target.position.lineNumber;
      if (controllerForLine(ranges, line - 1) === null) return;
      e.event.preventDefault();
      startThread(line);
    }),
    sa.addAction?.({
      id: "fluent.ext.addComment",
      label: "Adicionar Comentário",
      precondition: "fluentExtCommentable",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 100,
      run: (ed: monaco.editor.ICodeEditor) => {
        const pos = ed.getPosition();
        if (pos) startThread(pos.lineNumber);
      },
    }) ?? { dispose() {} },
    // Um controller ganhou/perdeu o provider, ou o host subiu de novo.
    { dispose: extHost.on((ev) => {
      if (ev.event === "commentingRangesChanged" || ev.event === "hostReady" || ev.event === "extensionActivated") refresh();
      else if (ev.event === "hostExit") {
        ranges = [];
        paint();
      }
    }) },
  ];
  refresh();
  return {
    dispose() {
      disposed = true;
      window.clearTimeout(timer);
      subs.forEach((s) => s.dispose());
      editor.deltaDecorations([...rangeDecos, ...hoverDecos], []);
    },
  };
}
