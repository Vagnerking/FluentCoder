import Editor, { BeforeMount, OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEffect, useRef } from "react";
import type { BlameHunk, EditorActionsApi, OpenFile, Problem } from "../types";
import { languageForFile } from "../language";
import { gitBlame, writeFile } from "../api";
import { toFileUri, fromFileUri } from "../lsp/uri";
import { setupMonacoForLsp } from "../lsp/monacoSetup";

// --- TEMP: log de diagnóstico do Git Lens em arquivo, para depuração ---
let _glBuffer = "";
function glLog(...args: unknown[]) {
  const line =
    "[GitLens] " +
    args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
  console.log(line);
  _glBuffer += line + "\n";
  // Best-effort flush; ignore errors.
  writeFile("C:\\Users\\Vagner\\gitlens-debug.log", _glBuffer).catch(() => {});
}

interface EditorPaneProps {
  file: OpenFile | null;
  /** Absolute path of the workspace root — needed for git blame. */
  rootPath: string | null;
  onChange: (value: string) => void;
  onCursorChange: (line: number, col: number) => void;
  /** Emits the current diagnostics whenever Monaco's markers change. */
  onProblemsChange: (problems: Problem[]) => void;
  /** Imperatively reveals a line; set by the parent to jump from search/problems. */
  revealRef?: React.MutableRefObject<((line: number) => void) | null>;
  /** A line to reveal as soon as the editor mounts (for just-opened files). */
  pendingRevealLine?: React.MutableRefObject<number | null>;
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
  pendingRevealLine,
  actionsRef,
  onOpenDefinition,
}: EditorPaneProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);

  // Keep the global opener pointed at the current callback (it's a single
  // Monaco-wide registration, so it can't close over a stale prop).
  openDefinitionRef.current = onOpenDefinition ?? null;

  // Blame data keyed by line number (1-based).
  const blameRef = useRef<Map<number, BlameHunk>>(new Map());
  // IDs of active decorations so we can replace them atomically.
  const decorationIdsRef = useRef<string[]>([]);
  // Current cursor line to highlight a specific blame.
  const cursorLineRef = useRef<number>(1);

  // Clear the actions bridge when the EditorPane unmounts, so the App's helper
  // (`actionsRef.current != null`) correctly reports "no active editor".
  useEffect(() => {
    return () => {
      if (actionsRef) actionsRef.current = null;
    };
  }, [actionsRef]);

  // When there is no file, the <Editor> doesn't mount (empty-state below), so
  // the bridge is never repopulated. Clear it so the App can disable menu items.
  useEffect(() => {
    if (!file && actionsRef) actionsRef.current = null;
  }, [file, actionsRef]);

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
      // Semantic-token color rules: the standalone theme matches a token's
      // [type,...modifiers] against these `rules` keyed by the bare LSP semantic
      // type names (class, enum, method…). Without them, semantic highlighting
      // flows but types render in the default foreground (no visible coloring).
      // Pairs with `'semanticHighlighting.enabled': true` on the editor options.
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
      colors: {
        "editor.background": "#1C222B",
        "editorGutter.background": "#1C222B",
        "editorLineNumber.foreground": "#7D8795",
        "editorLineNumber.activeForeground": "#D6E2F0",
        "editor.lineHighlightBackground": "#FFFFFF0A",
        "editor.selectionBackground": "#60CDFF35",
        "editor.inactiveSelectionBackground": "#60CDFF20",
        "editorCursor.foreground": "#60CDFF",
        "editorIndentGuide.background1": "#FFFFFF12",
        "editorIndentGuide.activeBackground1": "#8BB7D94D",
        "minimap.background": "#1C222B",
        "scrollbarSlider.background": "#B8C7D526",
        "scrollbarSlider.hoverBackground": "#B8C7D540",
        "scrollbarSlider.activeBackground": "#B8C7D55A",
        // Completion (IntelliSense) widget. Without these the suggest list
        // falls back to vs-dark defaults, which read as near-invisible text
        // against this theme's customized surfaces — the dropdown of
        // references becomes unreadable. Opaque surface (no acrylic alpha)
        // so the editor text never bleeds through the list.
        "editorSuggestWidget.background": "#202734",
        "editorSuggestWidget.border": "#3A4150",
        "editorSuggestWidget.foreground": "#D6E2F0",
        "editorSuggestWidget.selectedBackground": "#2C5E80",
        "editorSuggestWidget.selectedForeground": "#FFFFFF",
        "editorSuggestWidget.highlightForeground": "#60CDFF",
        "editorSuggestWidget.focusHighlightForeground": "#9DDCFF",
        // Hover, signature-help and parameter-hint popups share the same
        // surface so all editor flyouts stay legible and consistent.
        "editorHoverWidget.background": "#202734",
        "editorHoverWidget.border": "#3A4150",
        "editorHoverWidget.foreground": "#D6E2F0",
        "editorWidget.background": "#202734",
        "editorWidget.border": "#3A4150",
        "editorWidget.foreground": "#D6E2F0",
        // Inline (ghost text) completion preview — the dimmed italic text.
        "editorGhostText.foreground": "#7D8795",
      },
    });
  };

  const handleMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;

    editorInstance.onDidChangeCursorPosition((e) => {
      const line = e.position.lineNumber;
      onCursorChange(line, e.position.column);

      // Update active blame highlight when cursor moves to a different line.
      if (line !== cursorLineRef.current) {
        cursorLineRef.current = line;
        applyBlameDecorations();
      }
    });

    const reveal = (line: number) => {
      editorInstance.revealLineInCenter(line);
      editorInstance.setPosition({ lineNumber: line, column: 1 });
      editorInstance.focus();
    };

    if (revealRef) revealRef.current = reveal;

    if (actionsRef) {
      actionsRef.current = {
        run: (actionId) => {
          editorInstance.getAction(actionId)?.run();
        },
        trigger: (source, handlerId, payload) => {
          editorInstance.trigger(source, handlerId, payload);
        },
        focus: () => editorInstance.focus(),
      };
    }

    if (pendingRevealLine?.current != null) {
      reveal(pendingRevealLine.current);
      pendingRevealLine.current = null;
    }

    // Reload blame when the model is replaced (file switch handled by useEffect,
    // but this also catches reloads triggered by model events).
    editorInstance.onDidChangeModel(() => loadBlame());

    const pushMarkers = () => {
      const markers = monaco.editor.getModelMarkers({});
      onProblemsChange(
        markers.map((m) => ({
          path: m.resource.path,
          name: baseName(m.resource.path),
          severity: mapSeverity(m.severity),
          message: m.message,
          line: m.startLineNumber,
          column: m.startColumn,
        }))
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

  return (
    <Editor
      height="100%"
      theme="fluent-acrylic-dark"
      // The model URI must use the `file://` scheme so LSP clients whose
      // documentSelector is `{ scheme: "file" }` attach to it. Passing the raw
      // Windows path would make Monaco treat the drive letter as the URI scheme.
      path={toFileUri(file.path)}
      language={languageForFile(file.name)}
      value={file.content}
      onChange={(value) => onChange(value ?? "")}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      options={{
        fontSize: 14,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        padding: { top: 12 },
        mouseWheelZoom: true,
        // Suggest (IntelliSense) widget sizing. Monaco derives each row's
        // height from `suggestLineHeight` or, when 0, the editor's computed
        // `fontInfo.lineHeight`. Pinning both font size and line height keeps
        // the virtual list rows tall enough for the label + 22px type icon, so
        // entries don't overlap into an unreadable, doubled list.
        suggestFontSize: 13,
        suggestLineHeight: 22,
        // Render LSP semantic tokens. Literal `true` (not 'configuredByTheme')
        // because the standalone theme flag is hardcoded off; this turns the
        // type/method/param coloring on, resolved via the theme `rules` above.
        "semanticHighlighting.enabled": true,
      }}
    />
  );
}
