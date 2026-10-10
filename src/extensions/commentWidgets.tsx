/**
 * Widgets de comentário das extensões no Monaco (como o ZoneWidget do VS
 * Code): uma VIEW ZONE reserva a altura abaixo da linha do thread e um
 * OVERLAY WIDGET (que recebe cliques normalmente) é posicionado sobre ela com
 * a UI em React — botões com os primitivos Fluent (`ui-button`), codicons das
 * ações da extensão, corpo do comentário, reações e resposta.
 *
 * `attachCommentWidgets(editor, matches)` liga um editor (arquivo ou o lado
 * direito de um diff) aos threads cujo documento ele mostra.
 */
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as monaco from "monaco-editor";
import { extHost, extLog } from "./client";
import {
  commentThreads,
  sortActions,
  subscribeCommentThreads,
  threadAnchorLine,
  threadTitle,
  type CommentAction,
  type CommentThreadInfo,
} from "./comments";
import "./editorWidgets.css";

const MIN_HEIGHT = 34;

function ActionIcon({ icon }: { icon?: string }) {
  if (!icon || !/^[\w-]+$/.test(icon)) return null;
  return <span className={`codicon codicon-${icon}`} aria-hidden="true" />;
}

async function run(handle: string, a: CommentAction, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    const r = (await extHost.call("commentAction", { handle, command: a.command, ...extra })) as { ok: boolean; error?: string } | null;
    if (!r?.ok) extLog("ação de comentário recusada", a.command, r?.error);
  } catch (err) {
    extLog("ação de comentário falhou", a.command, err);
  }
}

/** Corpo de um thread (cabeçalho com ações, comentários, resposta). */
export function CommentThreadView({ thread }: { thread: CommentThreadInfo }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const title = threadTitle(thread);
  const actions = sortActions(thread.actions);
  const click = (a: CommentAction, extra?: Record<string, unknown>) => {
    if (busy) return;
    setBusy(a.command);
    void run(thread.handle, a, extra).finally(() => setBusy(null));
  };
  return (
    <div
      className="ext-comment-thread"
      role="group"
      aria-label={title || thread.controllerLabel || "Comentário da extensão"}
    >
      <div className="ext-comment-header">
        {title && <span className="ext-comment-title">{title}</span>}
        <div className="ext-comment-actions">
          {actions.map((a, i) => (
            <button
              key={a.command}
              type="button"
              className={`ui-button ui-button-sm ${i === 0 ? "ui-button-primary" : "ui-button-secondary"}`}
              title={a.title}
              aria-busy={busy === a.command || undefined}
              disabled={busy !== null && busy !== a.command}
              onClick={() => click(a)}
            >
              <ActionIcon icon={a.icon} />
              <span>{a.title}</span>
            </button>
          ))}
        </div>
      </div>
      {thread.collapsibleState === 1 &&
        thread.comments.map((c) => (
          <div key={c.index} className="ext-comment">
            <div className="ext-comment-meta">
              {c.author && <span className="ext-comment-author">{c.author}</span>}
              {c.label && <span className="ext-comment-label">{c.label}</span>}
              <span className="ext-comment-spacer" />
              {sortActions([...c.actions, ...c.contextActions]).map((a) => (
                <button
                  key={a.command}
                  type="button"
                  className="ui-icon-button ui-icon-button-sm"
                  aria-label={a.title}
                  title={a.title}
                  onClick={() => click(a, { commentIndex: c.index })}
                >
                  {a.icon ? <ActionIcon icon={a.icon} /> : <span className="ext-comment-text-action">{a.title}</span>}
                </button>
              ))}
            </div>
            <div className="ext-comment-body">{c.body}</div>
            {(c.reactions.length > 0 || thread.canReact) && (
              <div className="ext-comment-reactions">
                {c.reactions.map((r) => (
                  <button
                    key={r.label}
                    type="button"
                    className={`ext-comment-reaction${r.authorHasReacted ? " reacted" : ""}`}
                    aria-pressed={r.authorHasReacted}
                    disabled={!thread.canReact}
                    onClick={() => void extHost.call("commentReaction", { handle: thread.handle, commentIndex: c.index, reaction: r.label }).catch(() => {})}
                  >
                    {r.label} {r.count > 0 ? r.count : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      {thread.collapsibleState === 1 && thread.canReply && thread.replyActions.length > 0 && (
        <div className="ext-comment-reply">
          <textarea
            className="ext-comment-input"
            aria-label="Responder"
            placeholder="Responder…"
            value={reply}
            rows={2}
            onChange={(e) => setReply(e.target.value)}
          />
          <div className="ext-comment-actions">
            {sortActions(thread.replyActions).map((a, i) => (
              <button
                key={a.command}
                type="button"
                className={`ui-button ui-button-sm ${i === 0 ? "ui-button-primary" : "ui-button-secondary"}`}
                disabled={busy !== null}
                onClick={() => {
                  click(a, { text: reply });
                  setReply("");
                }}
              >
                <ActionIcon icon={a.icon} />
                <span>{a.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface Widget {
  thread: CommentThreadInfo;
  zoneId: string | null;
  zone: monaco.editor.IViewZone;
  overlay: monaco.editor.IOverlayWidget;
  dom: HTMLDivElement;
  root: Root;
  height: number;
  top: number;
  resizeObserver: ResizeObserver | null;
}

let nextWidget = 1;

/**
 * Liga os threads que `matches` aceita ao `editor`. Devolve um IDisposable
 * (remove as zonas/overlays e para de assinar).
 */
export function attachCommentWidgets(
  editor: monaco.editor.ICodeEditor,
  matches: (t: CommentThreadInfo) => boolean,
): monaco.IDisposable {
  const widgets = new Map<string, Widget>();
  let disposed = false;

  const layoutOverlay = (w: Widget) => {
    const info = editor.getLayoutInfo();
    w.dom.style.left = `${info.contentLeft}px`;
    w.dom.style.width = `${Math.max(120, info.contentWidth - info.verticalScrollbarWidth - 8)}px`;
    w.dom.style.top = `${w.top}px`;
    // Fora da área visível o overlay some (a zona não é desenhada).
    const visible = w.top > -w.height && w.top < info.height;
    w.dom.style.visibility = visible ? "visible" : "hidden";
  };

  const relayoutZone = (w: Widget, height: number) => {
    if (height === w.height || w.zoneId === null) return;
    w.height = height;
    w.zone.heightInPx = height;
    editor.changeViewZones((acc) => acc.layoutZone(w.zoneId!));
  };

  const create = (thread: CommentThreadInfo) => {
    const dom = document.createElement("div");
    dom.className = "ext-comment-widget";
    const root = createRoot(dom);
    const id = `fluent.ext.comment.${nextWidget++}`;
    const w: Widget = {
      thread,
      zoneId: null,
      dom,
      root,
      height: MIN_HEIGHT,
      top: -10000,
      resizeObserver: null,
      zone: {
        afterLineNumber: threadAnchorLine(thread),
        heightInPx: MIN_HEIGHT,
        domNode: document.createElement("div"),
        suppressMouseDown: true,
        onDomNodeTop: (top) => {
          w.top = top;
          layoutOverlay(w);
        },
      },
      overlay: {
        getId: () => id,
        getDomNode: () => dom,
        getPosition: () => null,
      },
    };
    editor.changeViewZones((acc) => {
      w.zoneId = acc.addZone(w.zone);
    });
    editor.addOverlayWidget(w.overlay);
    root.render(<CommentThreadView thread={thread} />);
    if (typeof ResizeObserver !== "undefined") {
      w.resizeObserver = new ResizeObserver(() => relayoutZone(w, Math.max(MIN_HEIGHT, Math.ceil(dom.offsetHeight) + 4)));
      w.resizeObserver.observe(dom);
    }
    widgets.set(thread.handle, w);
  };

  const update = (w: Widget, thread: CommentThreadInfo) => {
    const line = threadAnchorLine(thread);
    w.thread = thread;
    if (line !== w.zone.afterLineNumber && w.zoneId !== null) {
      w.zone.afterLineNumber = line;
      editor.changeViewZones((acc) => acc.layoutZone(w.zoneId!));
    }
    w.root.render(<CommentThreadView thread={thread} />);
  };

  const remove = (w: Widget) => {
    w.resizeObserver?.disconnect();
    if (w.zoneId !== null) {
      const zid = w.zoneId;
      editor.changeViewZones((acc) => acc.removeZone(zid));
    }
    editor.removeOverlayWidget(w.overlay);
    // Desmontar fora do ciclo de render atual do React.
    queueMicrotask(() => w.root.unmount());
    widgets.delete(w.thread.handle);
  };

  const sync = () => {
    if (disposed) return;
    const wanted = new Map(commentThreads().filter(matches).map((t) => [t.handle, t]));
    for (const w of [...widgets.values()]) if (!wanted.has(w.thread.handle)) remove(w);
    for (const [handle, t] of wanted) {
      const w = widgets.get(handle);
      if (w) update(w, t);
      else create(t);
    }
  };

  const off = subscribeCommentThreads(sync);
  // A zona fora da tela não recebe onDomNodeTop: calcula a posição pelo layout
  // das linhas (o topo da linha seguinte já inclui a altura da zona).
  const estimateTop = (w: Widget) => {
    const model = editor.getModel();
    if (!model) return;
    const after = w.zone.afterLineNumber;
    const count = model.getLineCount();
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const base = after >= count ? editor.getTopForLineNumber(count) + lineHeight : editor.getTopForLineNumber(after + 1) - w.height;
    w.top = base - editor.getScrollTop();
  };
  const subs = [
    editor.onDidLayoutChange(() => widgets.forEach(layoutOverlay)),
    // Outro documento no mesmo editor: as zonas antigas saem, entram as do novo.
    editor.onDidChangeModel(() => {
      [...widgets.values()].forEach(remove);
      sync();
    }),
    editor.onDidScrollChange(() =>
      widgets.forEach((w) => {
        estimateTop(w);
        layoutOverlay(w);
      }),
    ),
  ];
  sync();
  return {
    dispose() {
      disposed = true;
      off();
      subs.forEach((s) => s.dispose());
      [...widgets.values()].forEach(remove);
    },
  };
}
