import Editor, { BeforeMount, OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import { whenMonacoReady } from "../monaco-loader";
import type {
  BlameHunk,
  EditorActionsApi,
  MatchSelection,
  OpenFile,
  Problem,
} from "../types";
import { languageForFile } from "../language";
import { gitBlame } from "../api";
import { toFileUri, fromFileUri, canonicalFileUriKey } from "../lsp/uri";
import { setupMonacoForLsp } from "../lsp/monacoSetup";
import { debugSession } from "../dap/debugSession";
import { palette } from "../theme/palette";

// Console-only debug logging. (It used to mirror to a hardcoded path on another
// machine and fire an IPC file write — with an ever-growing buffer — on EVERY
// cursor move, which wasted resources and hurt editor responsiveness.)
function glLog(...args: unknown[]) {
  console.debug("[GitLens]", ...args);
}

interface EditorPaneProps {
  file: OpenFile | null;
  /** Absolute path of the workspace root — needed for git blame. */
  rootPath: string | null;
  onChange: (value: string) => void;
  onCursorChange: (line: number, col: number) => void;
  /** Emits the current diagnostics whenever Monaco's markers change. */
  onProblemsChange: (problems: Problem[]) => void;
  /**
   * Imperatively reveals a line; set by the parent to jump from search/problems.
   * An optional `selection` highlights (selects) a range on that line — used by
   * search results to highlight the matched term in the editor.
   */
  revealRef?: React.MutableRefObject<
    ((line: number, selection?: MatchSelection) => void) | null
  >;
  /** A line (+ optional selection) to reveal as soon as the editor mounts. */
  pendingReveal?: React.MutableRefObject<{
    line: number;
    selection?: MatchSelection;
  } | null>;
  /**
   * Imperative bridge the App holds to drive the editor (run actions, trigger
   * commands, focus). The Edit/Selection menus from ISSUE-52 depend on it.
   */
  actionsRef?: React.MutableRefObject<EditorActionsApi | null>;
  /**
   * Opens a definition target that lives in another file (go-to-definition /
   * Ctrl+Click across files). The app loads the file into a tab and reveals the
   * line. Same-file jumps are handled by Monaco itself.
   */
  onOpenDefinition?: (path: string, line: number, column: number) => void;
}

/** Maps a Monaco marker severity (1/2/4/8) to our Problem severity. */
function mapSeverity(sev: number): Problem["severity"] {
  if (sev >= 8) return "error";
  if (sev >= 4) return "warning";
  return "info";
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** CSS class for the inline blame annotation shown on the cursor line. */
const BLAME_ACTIVE_CLASS = "git-lens-inline-active";

/**
 * Monaco's editor opener is a global, single registration. We register it once
 * and route through a ref so it always sees the latest `onOpenDefinition`.
 */
let openerRegistered = false;
const openDefinitionRef: { current: ((p: string, l: number, c: number) => void) | null } = {
  current: null,
};

export function EditorPane({
  file,
  rootPath,
  onChange,
  onCursorChange,
  onProblemsChange,
  revealRef,
  pendingReveal,
  actionsRef,
  onOpenDefinition,
}: EditorPaneProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  // The v10 `@codingame` services must finish `initialize()` before the first
  // editor mounts (documented constraint) — `whenMonacoReady` also points
  // `@monaco-editor/react` at the shared Monaco instance. Gate the <Editor> on
  // it so the editor never mounts against a CDN/uninitialized Monaco.
  const [monacoReady, setMonacoReady] = useState(false);
  // If `initialize()` rejects (see vscodeServices.ts) `whenMonacoReady` never
  // resolves; without handling the rejection the pane would sit on the
  // "Carregando editor…" placeholder forever and Node/the browser would log an
  // unhandled promise rejection. Capture the failure so we can surface it
  // instead of hanging silently.
  const [monacoError, setMonacoError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    whenMonacoReady.then(
      () => {
        if (alive) setMonacoReady(true);
      },
      (err) => {
        if (alive) setMonacoError(err);
      }
    );
    return () => {
      alive = false;
    };
  }, []);
  // This editor's own reveal fn + actions api, set on mount. Kept internally so
  // we can (re)bind them to the parent's refs whenever THIS pane becomes the
  // active group — Monaco panes are not remounted on group switch, so binding
  // only on mount would leave go-to-line / Edit menus pointed at the old editor.
  const internalReveal = useRef<
    ((line: number, selection?: MatchSelection) => void) | null
  >(null);
  const internalApi = useRef<EditorActionsApi | null>(null);

  // Keep the global opener pointed at the current callback (it's a single
  // Monaco-wide registration, so it can't close over a stale prop).
  openDefinitionRef.current = onOpenDefinition ?? null;

  // Blame data keyed by line number (1-based).
  const blameRef = useRef<Map<number, BlameHunk>>(new Map());
  // IDs of active decorations so we can replace them atomically.
  const decorationIdsRef = useRef<string[]>([]);
  // Current cursor line to highlight a specific blame.
  const cursorLineRef = useRef<number>(1);
  // Debugger decorations (breakpoint glyphs + stopped-line highlight) — a
  // separate id set so blame and debug never clobber each other's decorations.
  const debugDecorationIdsRef = useRef<string[]>([]);

  /** Renders breakpoints + the stopped line for the CURRENT model (by uri). */
  const applyDebugDecorations = () => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    const model = ed.getModel();
    if (!model || model.isDisposed() || model.uri.scheme !== "file") return;
    const path = fromFileUri(model.uri.toString());
    const decs: editor.IModelDeltaDecoration[] = debugSession
      .breakpointsFor(path)
      .filter((bp) => bp.line <= model.getLineCount())
      .map((bp) => {
        // Distinct glyph per kind so conditional/logpoint breakpoints read at a
        // glance; the hover shows the condition/message.
        const isLog = Boolean(bp.logMessage);
        const isConditional = Boolean(bp.condition || bp.hitCondition);
        const glyph = isLog
          ? "debug-logpoint-glyph"
          : isConditional
            ? "debug-breakpoint-conditional-glyph"
            : "debug-breakpoint-glyph";
        const hover = isLog
          ? `Logpoint: ${bp.logMessage}`
          : bp.condition
            ? `Breakpoint condicional: ${bp.condition}`
            : bp.hitCondition
              ? `Breakpoint (hit ${bp.hitCondition})`
              : "Breakpoint";
        return {
          range: new monaco.Range(bp.line, 1, bp.line, 1),
          options: {
            glyphMarginClassName: glyph,
            glyphMarginHoverMessage: { value: hover },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        };
      });
    const stopped = debugSession.getState().stoppedAt;
    if (
      stopped &&
      canonicalFileUriKey(toFileUri(stopped.path)) === canonicalFileUriKey(model.uri.toString()) &&
      stopped.line <= model.getLineCount()
    ) {
      decs.push({
        range: new monaco.Range(stopped.line, 1, stopped.line, 1),
        options: {
          isWholeLine: true,
          className: "debug-stopped-line",
          glyphMarginClassName: "debug-stopped-glyph",
        },
      });
    }
    debugDecorationIdsRef.current = ed.deltaDecorations(debugDecorationIdsRef.current, decs);
  };

  // Re-render debug decorations whenever the session state changes (breakpoint
  // toggled anywhere, execution stopped/continued) — and on model switches.
  useEffect(() => debugSession.subscribe(applyDebugDecorations));

  // Bind THIS editor's reveal/actions to the parent refs whenever they're handed
  // to us (i.e. this pane became the active group) and clear them when they're
  // taken away or on unmount. React flushes all effect cleanups before all new
  // effects, so a group switch (old pane clears, new pane sets) ends with the
  // refs pointing at the newly-active editor.
  useEffect(() => {
    if (revealRef) revealRef.current = internalReveal.current;
    if (actionsRef) actionsRef.current = internalApi.current;
    return () => {
      if (revealRef) revealRef.current = null;
      if (actionsRef) actionsRef.current = null;
    };
  }, [revealRef, actionsRef]);

  // When there is no file, the <Editor> unmounts (empty-state below), so its
  // api is gone — clear both the internal cache and the parent bridge so the App
  // reports "no active editor" and can disable menu items.
  useEffect(() => {
    if (!file) {
      internalReveal.current = null;
      internalApi.current = null;
      if (actionsRef) actionsRef.current = null;
      if (revealRef) revealRef.current = null;
    }
  }, [file, actionsRef, revealRef]);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function applyBlameDecorations() {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;

    const model = ed.getModel();
    const blame = blameRef.current;
    glLog("applyBlameDecorations, blame.size =", blame.size, "hasModel =", !!model);
    if (!model || blame.size === 0) {
      decorationIdsRef.current = ed.deltaDecorations(decorationIdsRef.current, []);
      return;
    }

    const cursorLine = cursorLineRef.current;
    const lineCount = model.getLineCount();
    const newDecorations: editor.IModelDeltaDecoration[] = [];

    // Like GitLens, the inline blame is shown only on the current cursor line,
    // not on every line of the file.
    const lineNum = cursorLine;
    const hunk = blame.get(lineNum);
    if (hunk && lineNum >= 1 && lineNum <= lineCount) {
      const label = hunk.short
        ? `${hunk.author}, ${hunk.date} · ${hunk.short} ${hunk.subject}`
        : hunk.author;

      // Anchor the `after` decoration at the real end-of-line column. Using
      // MAX_SAFE_INTEGER here makes Monaco silently drop the decoration.
      const endCol = model.getLineMaxColumn(lineNum);

      newDecorations.push({
        range: new monaco.Range(lineNum, endCol, lineNum, endCol),
        options: {
          after: {
            content: `    ${label}`,
            inlineClassName: BLAME_ACTIVE_CLASS,
            // Sem isto o Monaco às vezes não reserva largura para o texto
            // injetado e a anotação fica com largura 0 (invisível).
            inlineClassNameAffectsLetterSpacing: true,
          },
          showIfCollapsed: true,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }

    glLog("aplicando", newDecorations.length, "decorações; primeira:", newDecorations[0]?.options?.after?.content ?? "(nenhuma)");
    decorationIdsRef.current = ed.deltaDecorations(decorationIdsRef.current, newDecorations);
    glLog("ids após deltaDecorations:", decorationIdsRef.current.length);
  }

  async function loadBlame() {
    const ed = editorRef.current;
    glLog("loadBlame", { hasEditor: !!ed, rootPath, filePath: file?.path });
    if (!ed || !rootPath || !file) return;
    // Untitled buffers aren't on disk — no git blame to fetch.
    if (file.path.startsWith("untitled:")) return;

    try {
      const hunks = await gitBlame(rootPath, file.path);
      glLog("hunks recebidos:", hunks.length, "amostra:", hunks.slice(0, 2));
      const map = new Map<number, BlameHunk>();
      hunks.forEach((h) => map.set(h.line, h));
      blameRef.current = map;
      applyBlameDecorations();
    } catch (err) {
      // Not a git repo or file not tracked — silently skip blame.
      glLog("ERRO no gitBlame:", String(err));
      blameRef.current = new Map();
      decorationIdsRef.current =
        editorRef.current?.deltaDecorations(decorationIdsRef.current, []) ?? [];
    }
  }

  // -------------------------------------------------------------------------
  // Reload blame when the active file changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    blameRef.current = new Map();
    decorationIdsRef.current =
      editorRef.current?.deltaDecorations(decorationIdsRef.current, []) ?? [];

    if (file && rootPath) {
      loadBlame();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, rootPath]);

  // -------------------------------------------------------------------------
  // Monaco setup
  // -------------------------------------------------------------------------

  const handleBeforeMount: BeforeMount = (monaco) => {
    monacoRef.current = monaco;

    // LSP pipeline setup (idempotent): disable the built-in TS/JS worker so the
    // real typescript-language-server owns IntelliSense, register the React
    // language ids, and register the `razor` language + tokenizer. Must run
    // before any model is created.
    setupMonacoForLsp(monaco);

    // Register a Monaco editor opener ONCE so go-to-definition / Ctrl+Click that
    // lands in a DIFFERENT file opens that file in a tab. Monaco calls this when
    // a definition resolves to a URI other than the current model. Same-file
    // jumps return false so Monaco handles them itself.
    if (!openerRegistered) {
      openerRegistered = true;
      monaco.editor.registerEditorOpener({
        openCodeEditor(_source, resource, selectionOrPosition) {
          const currentUri = editorRef.current?.getModel()?.uri.toString();
          if (resource.toString() === currentUri) {
            return false; // same file — let Monaco reveal the position
          }
          const open = openDefinitionRef.current;
          if (!open) return false;
          // Extract a 1-based line/column from either a Range or a Position.
          let line = 1;
          let column = 1;
          if (selectionOrPosition) {
            if ("startLineNumber" in selectionOrPosition) {
              line = selectionOrPosition.startLineNumber;
              column = selectionOrPosition.startColumn;
            } else {
              line = selectionOrPosition.lineNumber;
              column = selectionOrPosition.column;
            }
          }
          open(fromFileUri(resource.toString()), line, column);
          return true; // we handled the cross-file open
        },
      });
    }

    monaco.editor.defineTheme("fluent-acrylic-dark", {
      base: "vs-dark",
      inherit: true,
      // Token color rules. With `'semanticHighlighting.enabled': false` (see the
      // editor options below) these now drive the LEXICAL (Monarch) tokens — the
      // standalone theme matches each token scope (`keyword`, `keyword.if`,
      // `type`, `string`…) against these `rules`. They are also the rules that
      // WOULD color LSP semantic tokens if semantic highlighting were re-enabled
      // via the full VS Code theme path (the deferred follow-up noted below), so
      // the bare LSP type names (class, enum, method…) are kept here too.
      rules: [
        // C# Monarch emits specific scopes such as `keyword.if` and
        // `keyword.return`. Keep declarations/modifiers blue and make
        // control-flow keywords visually distinct, matching the Dark+ family.
        { token: "keyword", foreground: "569CD6" },
        { token: "keyword.if", foreground: "C586C0" },
        { token: "keyword.else", foreground: "C586C0" },
        { token: "keyword.switch", foreground: "C586C0" },
        { token: "keyword.case", foreground: "C586C0" },
        { token: "keyword.default", foreground: "C586C0" },
        { token: "keyword.for", foreground: "C586C0" },
        { token: "keyword.foreach", foreground: "C586C0" },
        { token: "keyword.while", foreground: "C586C0" },
        { token: "keyword.do", foreground: "C586C0" },
        { token: "keyword.break", foreground: "C586C0" },
        { token: "keyword.continue", foreground: "C586C0" },
        { token: "keyword.return", foreground: "C586C0" },
        { token: "keyword.throw", foreground: "C586C0" },
        { token: "keyword.try", foreground: "C586C0" },
        { token: "keyword.catch", foreground: "C586C0" },
        { token: "keyword.finally", foreground: "C586C0" },
        { token: "keyword.goto", foreground: "C586C0" },
        { token: "keyword.yield", foreground: "C586C0" },
        // Roslyn classifies flow keywords with this semantic token. It arrives
        // after Monarch's `keyword.if` / `keyword.return` token and therefore
        // must have its own rule or it falls back to the editor foreground.
        { token: "controlKeyword", foreground: "C586C0" },
        { token: "modifier", foreground: "569CD6" },
        { token: "namespace", foreground: "4EC9B0" },
        { token: "type", foreground: "4EC9B0" },
        { token: "class", foreground: "4EC9B0" },
        { token: "recordClass", foreground: "4EC9B0" },
        { token: "struct", foreground: "86C691" },
        { token: "recordStruct", foreground: "86C691" },
        { token: "interface", foreground: "B8D7A3" },
        { token: "enum", foreground: "B8D7A3" },
        { token: "delegate", foreground: "B8D7A3" },
        { token: "enumMember", foreground: "4FC1FF" },
        { token: "constant", foreground: "4FC1FF" },
        { token: "typeParameter", foreground: "4EC9B0" },
        { token: "parameter", foreground: "9CDCFE" },
        { token: "variable", foreground: "9CDCFE" },
        { token: "property", foreground: "9CDCFE" },
        { token: "field", foreground: "9CDCFE" },
        { token: "enumMember", foreground: "4FC1FF" },
        { token: "method", foreground: "DCDCAA" },
        { token: "member", foreground: "DCDCAA" },
        { token: "function", foreground: "DCDCAA" },
        { token: "extensionMethod", foreground: "DCDCAA" },
        { token: "event", foreground: "DCDCAA" },
        { token: "stringEscapeCharacter", foreground: "D7BA7D" },
        { token: "stringVerbatim", foreground: "CE9178" },
        // Roslyn uses these names when Visual Studio protocol extensions are
        // enabled. Standard LSP maps them to class/enum/etc.; keeping both makes
        // the theme resilient to either server schema.
        { token: "class name", foreground: "4EC9B0" },
        { token: "struct name", foreground: "86C691" },
        { token: "interface name", foreground: "B8D7A3" },
        { token: "enum name", foreground: "B8D7A3" },
        { token: "type parameter name", foreground: "4EC9B0" },
      ],
      // Chrome colors derive from the shared palette so the editor surfaces
      // track the CSS token layer (F2-AUD-001). Monaco needs literals at
      // registration time, so we read them from `palette` (hex without `#`
      // where Monaco expects a bare token is not required — it accepts `#rgb`).
      // Syntax-token foregrounds in `rules` above are a separate highlighting
      // concern and intentionally stay inline.
      colors: {
        "editor.background": palette.editorBg,
        "editorGutter.background": palette.editorBg,
        "editorLineNumber.foreground": palette.textMuted,
        "editorLineNumber.activeForeground": palette.textActive,
        "editor.lineHighlightBackground": "#FFFFFF0A",
        "editor.selectionBackground": "#60CDFF35",
        "editor.inactiveSelectionBackground": "#60CDFF20",
        "editorCursor.foreground": palette.accent,
        "editorIndentGuide.background1": "#FFFFFF12",
        "editorIndentGuide.activeBackground1": "#8BB7D94D",
        "minimap.background": palette.editorBg,
        "scrollbarSlider.background": "#B8C7D526",
        "scrollbarSlider.hoverBackground": "#B8C7D540",
        "scrollbarSlider.activeBackground": "#B8C7D55A",
        // Completion (IntelliSense) widget. Without these the suggest list
        // falls back to vs-dark defaults, which read as near-invisible text
        // against this theme's customized surfaces — the dropdown of
        // references becomes unreadable. Opaque surface (no acrylic alpha)
        // so the editor text never bleeds through the list.
        "editorSuggestWidget.background": palette.surfaceOverlay,
        "editorSuggestWidget.border": palette.surfaceOverlayBorder,
        "editorSuggestWidget.foreground": palette.textActive,
        "editorSuggestWidget.selectedBackground": "#2C5E80",
        "editorSuggestWidget.selectedForeground": palette.textBright,
        "editorSuggestWidget.highlightForeground": palette.accent,
        "editorSuggestWidget.focusHighlightForeground": "#9DDCFF",
        // Hover, signature-help and parameter-hint popups share the same
        // surface so all editor flyouts stay legible and consistent.
        "editorHoverWidget.background": palette.surfaceOverlay,
        "editorHoverWidget.border": palette.surfaceOverlayBorder,
        "editorHoverWidget.foreground": palette.textActive,
        "editorWidget.background": palette.surfaceOverlay,
        "editorWidget.border": palette.surfaceOverlayBorder,
        "editorWidget.foreground": palette.textActive,
        // Inline (ghost text) completion preview — the dimmed italic text.
        "editorGhostText.foreground": palette.textMuted,
      },
    });
  };

  const handleMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;

    // Breakpoint toggling: click on the glyph margin (left of the line numbers).
    // The path comes from the CURRENT model uri (not the `file` prop) so the
    // handler survives tab switches without re-registration.
    editorInstance.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      const model = editorInstance.getModel();
      if (!line || !model || model.uri.scheme !== "file") return;
      debugSession.toggleBreakpoint(fromFileUri(model.uri.toString()), line);
    });
    // Right-click on the glyph margin: edit the breakpoint's condition / logpoint
    // (a conditional breakpoint or logpoint, VS Code-style). Prompt-based to match
    // the app's lightweight input idiom (branch name, stash message, …).
    editorInstance.onContextMenu((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      const model = editorInstance.getModel();
      if (!line || !model || model.uri.scheme !== "file") return;
      e.event.preventDefault();
      e.event.stopPropagation();
      const path = fromFileUri(model.uri.toString());
      const current = debugSession.breakpointsFor(path).find((b) => b.line === line);
      const condition = window.prompt(
        "Condição do breakpoint (vazio = incondicional):",
        current?.condition ?? ""
      );
      if (condition === null) return; // cancelled
      const logMessage = window.prompt(
        "Logpoint (mensagem, {expr} interpolado; vazio = breakpoint normal):",
        current?.logMessage ?? ""
      );
      if (logMessage === null) return;
      const hitCondition = window.prompt(
        'Contagem de hits (ex.: "5", ">3"; vazio = toda vez):',
        current?.hitCondition ?? ""
      );
      if (hitCondition === null) return;
      debugSession.setBreakpointSpec(path, line, {
        condition: condition.trim() || undefined,
        logMessage: logMessage.trim() || undefined,
        hitCondition: hitCondition.trim() || undefined,
      });
    });
    editorInstance.onDidChangeModel(() => applyDebugDecorations());
    applyDebugDecorations();
    // v10 (#77): força a aplicação do tema custom. Na stack @codingame a prop
    // `theme` do @monaco-editor/react nem sempre aplica o tema definido em
    // beforeMount (o serviço de tema do VS Code intercepta), deixando o editor
    // no tema default claro → C# em azul/preto sobre fundo escuro = "apagado".
    // Reaplicar aqui, após o define + mount, garante o fluent-acrylic-dark.
    monaco.editor.setTheme("fluent-acrylic-dark");

    editorInstance.onDidChangeCursorPosition((e) => {
      const line = e.position.lineNumber;
      onCursorChange(line, e.position.column);

      // Update active blame highlight when cursor moves to a different line.
      if (line !== cursorLineRef.current) {
        cursorLineRef.current = line;
        applyBlameDecorations();
      }
    });

    const reveal = (line: number, selection?: MatchSelection) => {
      if (selection) {
        // Select the matched term so it's highlighted, then center the range.
        const range = new monaco.Range(
          line,
          selection.startColumn,
          line,
          selection.endColumn
        );
        editorInstance.setSelection(range);
        editorInstance.revealRangeInCenter(range);
      } else {
        editorInstance.revealLineInCenter(line);
        editorInstance.setPosition({ lineNumber: line, column: 1 });
      }
      editorInstance.focus();
    };

    internalReveal.current = reveal;
    if (revealRef) revealRef.current = reveal;

    const api: EditorActionsApi = {
      run: (actionId) => {
        editorInstance.getAction(actionId)?.run();
      },
      trigger: (source, handlerId, payload) => {
        editorInstance.trigger(source, handlerId, payload);
      },
      focus: () => editorInstance.focus(),
      getSelection: () => {
        const model = editorInstance.getModel();
        const sel = editorInstance.getSelection();
        if (!model || !sel || sel.isEmpty()) return null;
        const text = model.getValueInRange(sel);
        if (!text.trim()) return null;
        return {
          text,
          startLine: sel.startLineNumber,
          endLine: sel.endLineNumber,
        };
      },
    };
    internalApi.current = api;
    if (actionsRef) actionsRef.current = api;

    if (pendingReveal?.current != null) {
      reveal(pendingReveal.current.line, pendingReveal.current.selection);
      pendingReveal.current = null;
    }

    // Reload blame when the model is replaced (file switch handled by useEffect,
    // but this also catches reloads triggered by model events).
    editorInstance.onDidChangeModel(() => loadBlame());

    const pushMarkers = () => {
      const markers = monaco.editor.getModelMarkers({});
      onProblemsChange(
        markers.map((m) => {
          const path = fromFileUri(m.resource.toString());
          return {
            path,
            name: baseName(path),
            severity: mapSeverity(m.severity),
            message: m.message,
            line: m.startLineNumber,
            column: m.startColumn,
          };
        })
      );
    };
    monaco.editor.onDidChangeMarkers(pushMarkers);
    pushMarkers();

    // Load blame for the first file (useEffect fires before mount completes
    // on initial render, so we also trigger here for the initial file).
    if (file && rootPath) loadBlame();
  };

  if (!file) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-inner">
          <h2>Fluent Coder</h2>
          <p>Abra uma pasta pelo menu Arquivo (ou Ctrl+K Ctrl+O) para começar.</p>
        </div>
      </div>
    );
  }

  // Hold the editor back until the @codingame services are initialized. Without
  // this the first <Editor> could call monaco.editor.create() before
  // initialize() resolves (which the v10 stack forbids) or against the CDN
  // Monaco (breaking the single-instance contract → empty getModels(), no LSP).
  if (monacoError) {
    // Boot failed — show the reason instead of an endless spinner so the user
    // (and a screen reader, via role="alert") knows the editor won't appear.
    return (
      <div className="editor-empty">
        <div className="editor-empty-inner" role="alert">
          <p>Falha ao carregar o editor.</p>
          <p>{monacoError instanceof Error ? monacoError.message : String(monacoError)}</p>
        </div>
      </div>
    );
  }
  if (!monacoReady) {
    return (
      <div className="editor-empty">
        {/* role="status" + aria-live so a screen reader announces the loading
            state (and its resolution) instead of leaving AT users in silence. */}
        <div className="editor-empty-inner" role="status" aria-live="polite">
          <p>Carregando editor…</p>
        </div>
      </div>
    );
  }

  // Untitled buffers have no on-disk path; use their synthetic `untitled:` URI
  // directly so Monaco doesn't mangle it through `file://` (LSP/blame stay off —
  // they're plaintext until saved).
  const modelPath = file.path.startsWith("untitled:")
    ? file.path
    : toFileUri(file.path);

  return (
    <Editor
      height="100%"
      theme="fluent-acrylic-dark"
      // The model URI must use the `file://` scheme so LSP clients whose
      // documentSelector is `{ scheme: "file" }` attach to it. Passing the raw
      // Windows path would make Monaco treat the drive letter as the URI scheme.
      path={modelPath}
      // KEEP the model alive across tab switches. By default @monaco-editor/react
      // DISPOSES the previous model when `path` changes (switching tabs), which
      // fires Monaco's `onWillDisposeModel` → the Razor broker's `forgetDoc`
      // (clears the `.cshtml` diagnostics + drops the source map) and forces a
      // slow, race-prone re-prepare on return. That made the C# projection error
      // (and Roslyn diagnostics in general) vanish after visiting another file and
      // coming back. With the model kept, switching tabs no longer tears the LSP
      // document down; the real dispose happens only when the tab is truly closed
      // (App's open-paths reconciliation effect, guarded against split groups).
      keepCurrentModel
      language={languageForFile(file.name, file.path)}
      value={file.content}
      onChange={(value) => onChange(value ?? "")}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      options={{
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
      }}
    />
  );
}
