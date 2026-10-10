/**
 * Espelho do editor do Fluent Coder (Monaco) no host de extensões, por EVENTOS
 * (sem polling — substitui o snapshot de 400 ms do PoC):
 *
 * - modelos `file://` → `TextDocument` (`documentOpened` com o texto; depois só
 *   `documentChanged` com as mudanças incrementais, versão e dirty; undo/redo
 *   marcados; `documentClosed` ao descartar; `documentSaved` no evento
 *   `fluent:file-saved` do App);
 * - foco/seleção/rolagem dos editores → `editorsChanged` / `selectionChanged` /
 *   `visibleRangesChanged` (debounce curto);
 * - markers do Monaco → `diagnostics` (só os recursos que mudaram);
 * - no sentido inverso atende `applyEdit` (edição no MODELO, com undo, sem
 *   gravar no disco), `saveDocument`, `setSelection`, `revealRange`,
 *   decorações e diagnósticos das extensões (markers com owner `ext:*`).
 *
 * Só começa a espelhar quando alguma extensão é ativada (antes disso ninguém
 * consome) e refaz a sincronização completa se o host reiniciar.
 */
import * as monaco from "monaco-editor";
import { whenMonacoReady } from "../monaco-loader";
import { fromFileUri, toFileUri } from "../lsp/uri";
import { extHost, extLog } from "./client";
import type { HostEvent, PlainRange, PlainSelection } from "./protocol";
import {
  markersToDiagnostics,
  renderDecorationType,
  themeColorVar,
  toMonacoRange,
  toMonacoSelection,
  toPlainChanges,
  toPlainRange,
  toPlainSelection,
  vscodeSeverityToMarker,
} from "./editorModel";
import { readFluentThemeVars } from "./theme";
import { attachCommentWidgets } from "./commentWidgets";

/**
 * Tipos de decoração das extensões (CSS gerado), compartilhados com a revisão
 * de diff (`diffBinding.ts` decora o lado direito virtual com eles).
 */
const decoTypes = new Map<string, ReturnType<typeof renderDecorationType>>();

export function extDecorationType(key: string): ReturnType<typeof renderDecorationType> | undefined {
  return decoTypes.get(key);
}

export interface EditorBridgeHost {
  /** Abas abertas no app (todas as grupos), com dirty e a ativa. */
  getTabs(): { path: string; dirty: boolean; active: boolean }[];
  /** Abre/foca um arquivo (selecionando a faixa, se houver). */
  openFile(path: string, opts?: { selection?: PlainRange; preserveFocus?: boolean; preview?: boolean }): Promise<void> | void;
  /** O conteúdo de um buffer mudou por edição de extensão (atualiza a aba: dirty). */
  bufferChanged(path: string, content: string): void;
  /** Salva a aba do arquivo pelo caminho normal do app. */
  saveFile(path: string): Promise<boolean>;
  /** Fecha a aba do arquivo (tabGroups.close). */
  closeFile?(path: string): void;
}

const SELECTION_DEBOUNCE_MS = 40;
const EDITORS_DEBOUNCE_MS = 40;
const SCROLL_DEBOUNCE_MS = 150;
const DIAGNOSTICS_DEBOUNCE_MS = 300;
/** Comando do Monaco que executa a lente no host (o id da lente vai como argumento). */
const LENS_COMMAND = "fluent.extensions.runCodeLens";

function isFileModel(m: monaco.editor.ITextModel | null | undefined): m is monaco.editor.ITextModel {
  return !!m && m.uri.scheme === "file" && !m.isDisposed();
}

function pathOf(m: monaco.editor.ITextModel): string {
  return fromFileUri(m.uri.toString());
}

function modelFor(path: string): monaco.editor.ITextModel | null {
  return monaco.editor.getModel(monaco.Uri.parse(toFileUri(path)));
}

function waitForModel(path: string, ms: number): Promise<monaco.editor.ITextModel | null> {
  const existing = modelFor(path);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const sub = monaco.editor.onDidCreateModel(() => {
      const m = modelFor(path);
      if (m) {
        sub.dispose();
        window.clearTimeout(t);
        resolve(m);
      }
    });
    const t = window.setTimeout(() => {
      sub.dispose();
      resolve(modelFor(path));
    }, ms);
  });
}

export function startEditorBridge(hostRef: { current: EditorBridgeHost }): { dispose(): void; tabsChanged(): void } {
  let disposed = false;
  let syncing = false;
  let lastFocused: monaco.editor.ICodeEditor | null = null;
  const subs: monaco.IDisposable[] = [];
  const modelSubs = new Map<monaco.editor.ITextModel, monaco.IDisposable[]>();
  const savedAlt = new Map<string, number>();
  const editorSubs = new Map<monaco.editor.ICodeEditor, monaco.IDisposable[]>();
  const sameFile = (a: string, b: string) => (/^[a-zA-Z]:/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);
  let editorsTimer: number | undefined;
  let selTimer: number | undefined;
  let scrollTimer: number | undefined;
  let diagTimer: number | undefined;
  const dirtyDiagUris = new Set<string>();
  // Decorações: (path,key) → ids no modelo (os tipos ficam em `decoTypes`).
  const decoIds = new Map<string, string[]>();
  const pendingDecos = new Map<string, Map<string, { range: PlainRange; hoverMessage?: string }[]>>();
  const pendingMarkers = new Map<string, Map<string, monaco.editor.IMarkerData[]>>();
  let styleEl: HTMLStyleElement | null = null;

  const dirtyOf = (m: monaco.editor.ITextModel) => {
    const saved = savedAlt.get(pathOf(m));
    return saved !== undefined && saved !== m.getAlternativeVersionId();
  };

  // ------------------------------------------------------------ modelos → host
  const sendOpened = (m: monaco.editor.ITextModel) => {
    if (!syncing || !isFileModel(m)) return;
    void extHost.notify("documentOpened", {
      path: pathOf(m),
      text: m.getValue(),
      version: m.getVersionId(),
      languageId: m.getLanguageId(),
      dirty: dirtyOf(m),
    });
  };

  const trackModel = (m: monaco.editor.ITextModel) => {
    if (m.uri.scheme !== "file" || modelSubs.has(m)) return;
    const path = pathOf(m);
    if (!savedAlt.has(path)) savedAlt.set(path, m.getAlternativeVersionId());
    const list: monaco.IDisposable[] = [
      m.onDidChangeContent((e) => {
        if (!syncing) return;
        void extHost.notify("documentChanged", {
          path,
          version: m.getVersionId(),
          changes: toPlainChanges(e.changes),
          dirty: dirtyOf(m),
          reason: e.isUndoing ? "undo" : e.isRedoing ? "redo" : undefined,
        });
      }),
      m.onDidChangeLanguage(() => sendOpened(m)),
    ];
    modelSubs.set(m, list);
    sendOpened(m);
    applyPendingFor(m);
  };

  const untrackModel = (m: monaco.editor.ITextModel) => {
    const list = modelSubs.get(m);
    if (!list) return;
    list.forEach((d) => d.dispose());
    modelSubs.delete(m);
    const path = pathOf(m);
    savedAlt.delete(path);
    for (const k of [...decoIds.keys()]) if (k.startsWith(`${path}\u0000`)) decoIds.delete(k);
    if (syncing) void extHost.notify("documentClosed", { path });
  };

  const onSaved = (e: Event) => {
    const path = (e as CustomEvent<{ path: string }>).detail?.path;
    if (!path) return;
    const m = modelFor(path);
    if (m) savedAlt.set(path, m.getAlternativeVersionId());
    if (syncing && m) void extHost.notify("documentSaved", { path, text: m.getValue() });
  };

  // ------------------------------------------------------------ editores → host
  const fileEditors = () =>
    monaco.editor.getEditors().filter((ed) => {
      const m = ed.getModel();
      const node = ed.getDomNode();
      return isFileModel(m) && !!node && node.isConnected;
    });

  const selectionsOf = (ed: monaco.editor.ICodeEditor): PlainSelection[] => (ed.getSelections() ?? []).map(toPlainSelection);

  const pushEditors = () => {
    window.clearTimeout(editorsTimer);
    editorsTimer = window.setTimeout(() => {
      if (disposed || !syncing) return;
      const visible = fileEditors();
      const active = lastFocused && visible.includes(lastFocused) ? lastFocused : visible[0] ?? null;
      const tabs = hostRef.current.getTabs();
      void extHost.notify("editorsChanged", {
        active: active ? { path: pathOf(active.getModel()!), selections: selectionsOf(active) } : null,
        visible: visible.map((ed) => ({ path: pathOf(ed.getModel()!), selections: selectionsOf(ed) })),
        tabs,
      });
    }, EDITORS_DEBOUNCE_MS);
  };

  const pushSelection = (ed: monaco.editor.ICodeEditor, source: string) => {
    window.clearTimeout(selTimer);
    selTimer = window.setTimeout(() => {
      const m = ed.getModel();
      if (disposed || !syncing || !isFileModel(m)) return;
      const kind = source === "keyboard" ? "keyboard" : source === "mouse" ? "mouse" : source === "api" ? "command" : undefined;
      void extHost.notify("selectionChanged", { path: pathOf(m), selections: selectionsOf(ed), kind });
    }, SELECTION_DEBOUNCE_MS);
  };

  const pushVisibleRanges = (ed: monaco.editor.ICodeEditor) => {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      const m = ed.getModel();
      if (disposed || !syncing || !isFileModel(m)) return;
      void extHost.notify("visibleRangesChanged", { path: pathOf(m), ranges: ed.getVisibleRanges().map(toPlainRange) });
    }, SCROLL_DEBOUNCE_MS);
  };

  const trackEditor = (ed: monaco.editor.ICodeEditor) => {
    if (editorSubs.has(ed)) return;
    editorSubs.set(ed, [
      // Threads de comentário das extensões no arquivo deste editor.
      attachCommentWidgets(ed, (t) => {
        const m = ed.getModel();
        return !!t.path && isFileModel(m) && sameFile(t.path, pathOf(m));
      }),
      ed.onDidFocusEditorText(() => {
        lastFocused = ed;
        pushEditors();
      }),
      ed.onDidChangeModel(() => pushEditors()),
      ed.onDidChangeCursorSelection((e) => {
        if (ed === lastFocused || ed.hasTextFocus()) {
          if (lastFocused !== ed) {
            lastFocused = ed;
            pushEditors();
          }
          pushSelection(ed, e.source);
        }
      }),
      ed.onDidScrollChange((e) => {
        if (e.scrollTopChanged) pushVisibleRanges(ed);
      }),
      ed.onDidDispose(() => {
        editorSubs.get(ed)?.forEach((d) => d.dispose());
        editorSubs.delete(ed);
        if (lastFocused === ed) lastFocused = null;
        pushEditors();
      }),
    ]);
  };

  // ------------------------------------------------------------ diagnósticos → host
  const pushDiagnostics = (uris: readonly monaco.Uri[] | null) => {
    if (uris) uris.forEach((u) => u.scheme === "file" && dirtyDiagUris.add(u.toString()));
    window.clearTimeout(diagTimer);
    diagTimer = window.setTimeout(() => {
      if (disposed || !syncing) return;
      const targets = uris === null && dirtyDiagUris.size === 0 ? null : [...dirtyDiagUris];
      dirtyDiagUris.clear();
      const all = monaco.editor.getModelMarkers({}).filter((m) => m.resource.scheme === "file" && !String(m.owner).startsWith("ext:"));
      const byUri = new Map<string, monaco.editor.IMarker[]>();
      for (const m of all) {
        const k = m.resource.toString();
        if (targets && !targets.includes(k)) continue;
        (byUri.get(k) ?? byUri.set(k, []).get(k)!).push(m);
      }
      for (const k of targets ?? []) if (!byUri.has(k)) byUri.set(k, []);
      const entries = [...byUri.entries()].map(([k, ms]) => ({ path: fromFileUri(k), diagnostics: markersToDiagnostics(ms) }));
      if (entries.length) void extHost.notify("diagnostics", { entries });
    }, DIAGNOSTICS_DEBOUNCE_MS);
  };

  // ------------------------------------------------------------ sincronização completa
  const fullSync = () => {
    if (disposed) return;
    syncing = true;
    monaco.editor.getModels().forEach((m) => {
      if (m.uri.scheme === "file") {
        if (modelSubs.has(m)) sendOpened(m);
        else trackModel(m);
      }
    });
    pushEditors();
    pushDiagnostics(null);
  };

  // ------------------------------------------------------------ host → editor
  const decoKey = (path: string, key: string) => `${path}\u0000${key}`;

  const resolveThemeColor = (() => {
    let vars: Record<string, string> | null = null;
    return (id: string) => {
      vars = vars ?? readFluentThemeVars();
      return vars[themeColorVar(id)];
    };
  })();

  const rebuildStyles = () => {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "fluent-ext-decorations";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = [...decoTypes.values()].map((d) => d.css).join("\n");
  };

  const applyDecorations = (m: monaco.editor.ITextModel, key: string, items: { range: PlainRange; hoverMessage?: string }[]) => {
    const type = decoTypes.get(key);
    if (!type) return;
    const k = decoKey(pathOf(m), key);
    const next = items.map((it) => ({
      range: toMonacoRange(it.range) as monaco.IRange,
      options: {
        ...type.options,
        ...(it.hoverMessage ? { hoverMessage: { value: it.hoverMessage } } : {}),
        ...(type.options.overviewRulerColor ? { overviewRuler: { color: type.options.overviewRulerColor, position: monaco.editor.OverviewRulerLane.Center } } : {}),
      } as monaco.editor.IModelDecorationOptions,
    }));
    decoIds.set(k, m.deltaDecorations(decoIds.get(k) ?? [], next));
  };

  const applyPendingFor = (m: monaco.editor.ITextModel) => {
    const path = pathOf(m);
    const decos = pendingDecos.get(path);
    if (decos) {
      pendingDecos.delete(path);
      decos.forEach((items, key) => applyDecorations(m, key, items));
    }
    const markers = pendingMarkers.get(path);
    if (markers) markers.forEach((list, owner) => monaco.editor.setModelMarkers(m, owner, list));
  };

  const editorsOf = (path: string) => monaco.editor.getEditors().filter((ed) => ed.getModel()?.uri.toString() === monaco.Uri.parse(toFileUri(path)).toString());

  const respond = (requestId: number, result: unknown) => void extHost.notify("respond", { requestId, result });

  const applyEdit = async (params: Record<string, unknown>) => {
    const batch = (params.edits as { path: string; edits: { range: PlainRange; text: string }[] }[]) ?? [];
    const docs: { path: string; text: string; version: number; dirty: boolean }[] = [];
    for (const { path, edits } of batch) {
      let m = modelFor(path);
      if (!m) {
        // Como o VS Code, editar um arquivo fechado o abre (e deixa sujo, sem gravar).
        await hostRef.current.openFile(path, { preserveFocus: true, preview: false });
        m = await waitForModel(path, 5000);
      }
      if (!m) return { applied: false };
      if (params.undoStopBefore !== false) m.pushStackElement();
      m.pushEditOperations(
        [],
        edits.map((e) => ({ range: toMonacoRange(e.range) as monaco.IRange, text: e.text, forceMoveMarkers: false })),
        () => null,
      );
      if (params.undoStopAfter !== false) m.pushStackElement();
      const text = m.getValue();
      hostRef.current.bufferChanged(path, text);
      docs.push({ path, text, version: m.getVersionId(), dirty: dirtyOf(m) });
    }
    return { applied: true, docs };
  };

  // ---- CodeLens das extensões (ex.: "Implement with Codex" em TODOs).
  let lensProvider: monaco.IDisposable | null = null;
  let lensCommand: monaco.IDisposable | null = null;
  const lensChanged = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  const setLensProvider = (on: boolean) => {
    if (on && !lensProvider) {
      lensCommand = monaco.editor.registerCommand(LENS_COMMAND, (_accessor: unknown, id: unknown) => {
        if (typeof id === "string") void extHost.call("executeCodeLens", { id }).catch((err) => extLog("CodeLens falhou", err));
      });
      const provider: monaco.languages.CodeLensProvider = {
        onDidChange: lensChanged.event,
        provideCodeLenses: async (model) => {
          if (!syncing || !isFileModel(model)) return { lenses: [], dispose() {} };
          const lenses = ((await extHost.call("provideCodeLenses", { path: pathOf(model) }).catch(() => [])) ?? []) as {
            id: string;
            range: PlainRange;
            title: string;
            tooltip?: string;
          }[];
          return {
            lenses: lenses.map((l) => ({
              range: toMonacoRange(l.range) as monaco.IRange,
              id: l.id,
              command: { id: LENS_COMMAND, title: l.title, tooltip: l.tooltip, arguments: [l.id] },
            })),
            dispose() {},
          };
        },
      };
      lensProvider = monaco.languages.registerCodeLensProvider("*", provider);
    } else if (!on && lensProvider) {
      lensProvider.dispose();
      lensCommand?.dispose();
      lensProvider = lensCommand = null;
    }
  };

  const onHostEvent = (ev: HostEvent) => {
    switch (ev.event) {
      case "codeLensProviders":
        void whenMonacoReady.then(() => setLensProvider(((ev as unknown as { count: number }).count ?? 0) > 0));
        break;
      case "codeLensChanged":
        lensChanged.fire(undefined as unknown as monaco.languages.CodeLensProvider);
        break;
      case "extensionActivated":
        if (!syncing) fullSync();
        break;
      case "hostExit":
        syncing = false;
        setLensProvider(false);
        break;
      case "hostRestarted":
        if (extHost.anyActive) fullSync();
        break;
      case "request": {
        const e = ev as { requestId: number; kind: string; params: Record<string, unknown> };
        if (e.kind === "applyEdit") {
          void applyEdit(e.params)
            .catch((err) => {
              extLog("applyEdit falhou", err);
              return { applied: false };
            })
            .then((r) => respond(e.requestId, r));
        } else if (e.kind === "saveDocument") {
          void Promise.resolve(hostRef.current.saveFile(String(e.params.path)))
            .catch(() => false)
            .then((saved) => respond(e.requestId, { saved }));
        } else if (e.kind === "clipboardRead") {
          void (navigator.clipboard?.readText() ?? Promise.reject(new Error("sem clipboard")))
            .then((text) => respond(e.requestId, { text }))
            .catch(() => respond(e.requestId, null));
        }
        break;
      }
      case "setSelection": {
        const e = ev as { path: string; selections: PlainSelection[] };
        const eds = editorsOf(e.path);
        if (eds.length) {
          eds[0].setSelections(e.selections.map((s) => toMonacoSelection(s) as monaco.ISelection));
        } else if (e.selections[0]) {
          const s = e.selections[0];
          void hostRef.current.openFile(e.path, { selection: { start: s.anchor, end: s.active }, preserveFocus: true });
        }
        break;
      }
      case "revealRange": {
        const e = ev as { path: string; range: PlainRange; revealType: number };
        const r = toMonacoRange(e.range) as monaco.IRange;
        for (const ed of editorsOf(e.path)) {
          if (e.revealType === 1) ed.revealRangeInCenter(r);
          else if (e.revealType === 3) ed.revealRangeAtTop(r);
          else ed.revealRangeInCenterIfOutsideViewport(r);
        }
        break;
      }
      case "decorationType": {
        const e = ev as { key: string; options: Record<string, unknown> };
        decoTypes.set(e.key, renderDecorationType(e.key, e.options, resolveThemeColor));
        rebuildStyles();
        break;
      }
      case "decorationTypeDisposed": {
        const key = (ev as { key: string }).key;
        decoTypes.delete(key);
        for (const [k, ids] of [...decoIds]) {
          if (!k.endsWith(`\u0000${key}`)) continue;
          const m = modelFor(k.slice(0, k.indexOf("\u0000")));
          if (m) m.deltaDecorations(ids, []);
          decoIds.delete(k);
        }
        rebuildStyles();
        break;
      }
      case "decorations": {
        const e = ev as { path?: string; uri?: string; key: string; items: { range: PlainRange; hoverMessage?: string }[] };
        if (!e.path) break; // lado virtual de um diff: diffBinding.ts
        const m = modelFor(e.path);
        if (m) applyDecorations(m, e.key, e.items);
        else {
          const map = pendingDecos.get(e.path) ?? new Map();
          map.set(e.key, e.items);
          pendingDecos.set(e.path!, map);
        }
        break;
      }
      case "extDiagnostics": {
        const e = ev as { owner: string; path: string; diagnostics: { range: PlainRange; message: string; severity: number; source?: string }[] };
        const markers: monaco.editor.IMarkerData[] = e.diagnostics.map((d) => ({
          ...(toMonacoRange(d.range) as monaco.IRange),
          message: d.message,
          severity: vscodeSeverityToMarker(d.severity),
          source: d.source,
        }));
        const map = pendingMarkers.get(e.path) ?? new Map();
        map.set(e.owner, markers);
        pendingMarkers.set(e.path, map);
        const m = modelFor(e.path);
        if (m) monaco.editor.setModelMarkers(m, e.owner, markers);
        break;
      }
      case "closeEditor":
        hostRef.current.closeFile?.((ev as { path: string }).path);
        break;
      default:
        break;
    }
  };

  const offHost = extHost.on(onHostEvent);
  const onFocus = () => syncing && void extHost.notify("windowState", { focused: true });
  const onBlur = () => syncing && void extHost.notify("windowState", { focused: false });
  window.addEventListener("fluent:file-saved", onSaved);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);

  void whenMonacoReady.then(() => {
    if (disposed) return;
    monaco.editor.getModels().forEach(trackModel);
    subs.push(
      monaco.editor.onDidCreateModel(trackModel),
      monaco.editor.onWillDisposeModel(untrackModel),
      monaco.editor.onDidChangeMarkers((uris) => pushDiagnostics(uris)),
    );
    monaco.editor.getEditors().forEach(trackEditor);
    subs.push(monaco.editor.onDidCreateEditor(trackEditor));
    if (extHost.anyActive) fullSync();
  });

  return {
    tabsChanged: () => pushEditors(),
    dispose() {
      disposed = true;
      offHost();
      window.removeEventListener("fluent:file-saved", onSaved);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      [editorsTimer, selTimer, scrollTimer, diagTimer].forEach((t) => window.clearTimeout(t));
      subs.forEach((s) => s.dispose());
      modelSubs.forEach((l) => l.forEach((d) => d.dispose()));
      editorSubs.forEach((l) => l.forEach((d) => d.dispose()));
      styleEl?.remove();
      setLensProvider(false);
      lensChanged.dispose();
    },
  };
}
