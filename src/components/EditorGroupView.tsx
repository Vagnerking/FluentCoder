import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BlameHunk,
  MatchSelection,
  EditorActionsApi,
  FileDecoration,
  GitAnnotationMode,
  OpenFile,
  Problem,
} from "../types";
import type { Edge, EditorGroup } from "../editorGroups";
import { isDropMeaningful } from "../editorGroups";
import { TAB_DRAG_MIME, type TabDragPayload } from "./TabBar";
import { EditorGroupHeader } from "./editor/EditorGroupHeader";
import type { BreadcrumbRoot } from "../editor/breadcrumbs";
import type { editor } from "monaco-editor";
import { EditorPane } from "./EditorPane";
import { ImagePreview } from "./ImagePreview";
import { MediaPreview } from "./MediaPreview";
import { GraphView } from "./GraphView";
import type { GitRevisionDiffTarget } from "../api";
import { ExtensionWebviewTab, handleOfWebviewTab } from "../extensions";
import { EditorActions, type EditorActionItem } from "./editor/EditorActions";
import { gitEditorAction } from "./editor/GitEditorActions";

export interface EditorGroupViewProps {
  group: EditorGroup;
  isActive: boolean;
  rootPath: string | null;
  /** Raízes do workspace para os breadcrumbs (multi-root/SSH). */
  breadcrumbRoots: readonly BreadcrumbRoot[];
  decorationFor: (path: string) => FileDecoration | undefined;
  onFocusGroup: () => void;
  // Tab actions (already bound to this group's id by the grid).
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onCloseAll: () => void;
  onCloseOthers: (path: string) => void;
  onCloseLeft: (path: string) => void;
  onCloseRight: (path: string) => void;
  onReorder: (from: string, to: string, before: boolean) => void;
  /** Fixar/desafixar e "manter aberta" (sair do preview). */
  onPin: (path: string, pinned: boolean) => void;
  onKeepOpen: (path: string) => void;
  externalDragActive: boolean;
  onTabStripDrop: (
    payload: { groupId: string; path: string },
    targetPath: string | null,
    before: boolean
  ) => void;
  onMoveToNewWindow: (path: string) => void;
  onDetach: (path: string, screenX: number, screenY: number) => void;
  onSplit: (edge: Edge) => void;
  // Editor.
  onChange: (value: string) => void;
  onCursorChange: (line: number, col: number) => void;
  onProblemsChange: (problems: Problem[]) => void;
  onOpenDefinition: (path: string, line: number, column: number) => void;
  onShowFileHistory?: (path: string, line?: number) => void;
  /** "Comparar alterações" do menu Git: abre o diff do arquivo. */
  onCompareChanges?: (path: string) => void;
  onOpenRevision?: (filePath: string, commitHash: string, shortHash: string) => void;
  onOpenRevisionDiff?: (
    filePath: string,
    commitHash: string,
    shortHash: string,
    compareTo: GitRevisionDiffTarget
  ) => void;
  onCurrentBlameChange?: (hunk: BlameHunk | null, filePath: string | null) => void;
  revealRef?: React.MutableRefObject<
    ((line: number, selection?: MatchSelection) => void) | null
  >;
  pendingReveal?: React.MutableRefObject<{
    line: number;
    selection?: MatchSelection;
  } | null>;
  actionsRef?: React.MutableRefObject<EditorActionsApi | null>;
  // Drop a dragged tab onto this group (move into it, or split off an edge).
  onTabDrop: (edge: Edge, fromGroupId: string, path: string) => void;
  /** Opens a file by path (used by the graph view's node clicks). */
  onOpenPath: (path: string, workspaceRemote?: OpenFile["workspaceRemote"]) => void;
  /** The workbench's active real file, highlighted in the graph view. */
  graphActivePath?: string | null;
  /** Root scanned by the graph tab. Defaults to rootPath for single-root mode. */
  graphRootPath?: string | null;
  /** SSH connection id when graphRootPath points at a remote root. */
  graphConnId?: string | null;
  /** Explicit SSH origin for graph node opens. */
  graphWorkspaceRemote?: OpenFile["workspaceRemote"];
  /** 1-based column of this group in the grid (`WebviewPanel.viewColumn`). */
  viewColumn?: number;
  /** True while ANY tab is being dragged — shields this group's editor with a
   *  capture overlay so Monaco doesn't move its cursor/scroll under the drag. */
  tabDragging: boolean;
  /** The tab currently in flight (its origin group + how many tabs that group
   *  holds), so this group can tell whether a drop here would actually do
   *  something and only then light up a drop-zone. Null when nothing's dragging. */
  dragSource: { groupId: string; fileCount: number } | null;
  onTabDragStart: (drag: TabDragPayload) => void;
  onTabDragEnd: () => void;
  onDragMove: (screenX: number, screenY: number) => void;
  /** Shown when this group has no active file (the home / welcome screen). */
  welcome?: React.ReactNode;
}

/** Reads {groupId, path} from a tab-drag dataTransfer (null if not ours). */
function readTabPayload(
  dt: DataTransfer
): { groupId: string; path: string } | null {
  const raw = dt.getData(TAB_DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Picks the drop edge from where the cursor sits in the body (corners/edges =
 *  split that side; middle = move into this group). The edge bands are generous
 *  (outer ~30%) so the split targets are easy to hit. */
function edgeFromPoint(rect: DOMRect, x: number, y: number): Edge {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const left = rx,
    right = 1 - rx,
    top = ry,
    bottom = 1 - ry;
  const min = Math.min(left, right, top, bottom);
  if (min > 0.3) return "center";
  if (min === left) return "left";
  if (min === right) return "right";
  if (min === top) return "top";
  return "bottom";
}

/** Human-readable recommendation shown inside the drop-zone. */
function edgeLabel(edge: Edge): string {
  switch (edge) {
    case "center":
      return "Mover para este grupo";
    case "left":
      return "Dividir à esquerda";
    case "right":
      return "Dividir à direita";
    case "top":
      return "Dividir acima";
    case "bottom":
      return "Dividir abaixo";
  }
}

/**
 * One editor group (a leaf of the split grid): its breadcrumb + tab strip + the
 * editor/preview for its active file, plus drop-zones that let a dragged tab
 * move into it (center) or split a new group off an edge.
 */
export function EditorGroupView(props: EditorGroupViewProps) {
  const { group, isActive, tabDragging, dragSource } = props;
  const active = group.files.find((f) => f.path === group.activePath) ?? null;
  const mode = active?.mode ?? "text";
  const [dropEdge, setDropEdge] = useState<Edge | null>(null);
  // Editor Monaco do grupo (breadcrumbs: símbolos sob o cursor).
  const [editorInstance, setEditorInstance] = useState<editor.IStandaloneCodeEditor | null>(null);
  // Anotações Git por editor (arquivo deste grupo): toggles explícitos, nunca
  // persistidos — fechar a aba (ou reabrir pelo Explorer) volta a "off".
  const [annotationModes, setAnnotationModes] = useState<Record<string, GitAnnotationMode>>({});
  const [blameAvailable, setBlameAvailable] = useState<Record<string, boolean>>({});
  const openPathsKey = group.files.map((f) => f.path).join("\n");
  useEffect(() => {
    const open = new Set(group.files.map((f) => f.path));
    const prune = <T,>(rec: Record<string, T>) => {
      const keys = Object.keys(rec);
      return keys.every((k) => open.has(k))
        ? rec
        : Object.fromEntries(keys.filter((k) => open.has(k)).map((k) => [k, rec[k]]));
    };
    setAnnotationModes(prune);
    setBlameAvailable(prune);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPathsKey]);
  const handleAnnotationsAvailable = useCallback((path: string, available: boolean) => {
    setBlameAvailable((cur) => (cur[path] === available ? cur : { ...cur, [path]: available }));
  }, []);
  const annotationMode: GitAnnotationMode = active ? annotationModes[active.path] ?? "off" : "off";

  const actionCtx = useMemo(
    () => ({ file: active, groupId: group.id, isActiveGroup: isActive }),
    [active, group.id, isActive]
  );
  const editorActions = useMemo<EditorActionItem[]>(
    () => [
      {
        id: "open-source",
        icon: "file",
        label: "Abrir arquivo",
        order: 10,
        when: ({ file }) => !!file?.sourcePath && file.mode === "diff",
        run: ({ file }) => file?.sourcePath && props.onOpenPath(file.sourcePath, file.workspaceRemote),
      },
      gitEditorAction({
        mode: annotationMode,
        onModeChange: (path, mode) => setAnnotationModes((cur) => ({ ...cur, [path]: mode })),
        hasBlame: (path) => !!blameAvailable[path],
        decorationFor: props.decorationFor,
        onCompareChanges: props.onCompareChanges,
        onShowFileHistory: props.onShowFileHistory ? (path) => props.onShowFileHistory?.(path) : undefined,
      }),
      {
        id: "split",
        icon: "splitEditor",
        label: "Dividir editor para a direita",
        order: 90,
        run: () => props.onSplit("right"),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [annotationMode, blameAvailable, props.decorationFor, props.onCompareChanges, props.onShowFileHistory, props.onSplit, props.onOpenPath]
  );

  // When the drag finishes anywhere, drop the highlight in every group.
  useEffect(() => {
    if (!tabDragging) setDropEdge(null);
  }, [tabDragging]);

  /** A drop on `edge` only counts when it would actually change the layout —
   *  otherwise we show no highlight and refuse it (no misleading "split" hint
   *  when dragging a lone tab over its own group). */
  const edgeAllowed = (edge: Edge): boolean =>
    dragSource
      ? isDropMeaningful(edge, dragSource.groupId, dragSource.fileCount, group.id)
      : true;

  return (
    <div
      className={`editor-group${isActive ? " active" : ""}`}
      onMouseDownCapture={props.onFocusGroup}
    >
      <EditorGroupHeader
        tabs={{
        files: group.files,
        activePath: group.activePath,
        groupId: group.id,
        onSelect: props.onSelect,
        onClose: props.onClose,
        onCloseAll: props.onCloseAll,
        onCloseOthers: props.onCloseOthers,
        onCloseLeft: props.onCloseLeft,
        onCloseRight: props.onCloseRight,
        onMoveToNewWindow: props.onMoveToNewWindow,
        onDetach: props.onDetach,
        onReorder: props.onReorder,
        onPin: props.onPin,
        onKeepOpen: props.onKeepOpen,
        externalDragActive: props.externalDragActive,
        onTabStripDrop: props.onTabStripDrop,
        onDragStateChange: (d) => (d ? props.onTabDragStart(d) : props.onTabDragEnd()),
        onDragMove: props.onDragMove,
        decorationFor: props.decorationFor,
        }}
        breadcrumbs={
          active && mode !== "graph" && mode !== "webview"
            ? {
                file: active,
                roots: props.breadcrumbRoots,
                editor: mode === "text" ? editorInstance : null,
                onOpenFile: props.onOpenPath,
              }
            : null
        }
        actions={
          <EditorActions
            ctx={actionCtx}
            actions={editorActions}
            moreItems={[
              {
                id: "split-down",
                label: "Dividir editor para baixo",
                icon: "splitEditor",
                onSelect: () => props.onSplit("bottom"),
              },
              { id: "sep-close", separator: true },
              {
                id: "close-all",
                label: "Fechar todas",
                icon: "closeAll",
                onSelect: () => props.onCloseAll(),
              },
            ]}
          />
        }
      />
      <div className="editor-group-body">
        {!active && props.welcome ? (
          props.welcome
        ) : active && mode === "image" ? (
          <ImagePreview
            path={active.path}
            name={active.name}
            connId={active.workspaceRemote?.connId}
          />
        ) : active && (mode === "video" || mode === "audio") ? (
          <MediaPreview
            path={active.path}
            name={active.name}
            kind={mode}
            connId={active.workspaceRemote?.connId}
          />
        ) : active && mode === "webview" ? null : active && mode === "graph" ? (
          <GraphView
            rootPath={props.graphRootPath ?? props.rootPath}
            connId={props.graphConnId ?? null}
            workspaceRemote={props.graphWorkspaceRemote}
            activePath={props.graphActivePath ?? null}
            onOpenFile={props.onOpenPath}
          />
        ) : (
          // Text mode, or an empty group → EditorPane (shows the welcome screen
          // when `file` is null, matching the single-group behaviour).
          <EditorPane
            file={active}
            rootPath={props.rootPath}
            onChange={props.onChange}
            onCursorChange={props.onCursorChange}
            onProblemsChange={props.onProblemsChange}
            revealRef={props.revealRef}
            pendingReveal={props.pendingReveal}
            actionsRef={props.actionsRef}
            onOpenDefinition={props.onOpenDefinition}
            onShowFileHistory={props.onShowFileHistory}
            onOpenRevision={props.onOpenRevision}
            onOpenRevisionDiff={props.onOpenRevisionDiff}
            fileDecoration={active ? props.decorationFor(active.path) : undefined}
            onCurrentBlameChange={props.onCurrentBlameChange}
            gitAnnotationMode={annotationMode}
            onEditorReady={setEditorInstance}
            onGitAnnotationsAvailable={handleAnnotationsAvailable}
          />
        )}
        {/* Painéis de webview de extensões: ficam montados enquanto a aba está
            no grupo (retainContextWhenHidden) e só o ativo aparece. */}
        {group.files
          .filter((f) => f.mode === "webview")
          .map((f) => {
            const handle = handleOfWebviewTab(f.path);
            if (!handle) return null;
            const shown = f.path === group.activePath;
            return (
              <div key={f.path} className="editor-webview-pane" hidden={!shown}>
                <ExtensionWebviewTab handle={handle} visible={shown} active={shown && isActive} viewColumn={props.viewColumn ?? 1} />
              </div>
            );
          })}
        {/* While a tab is in flight, an opaque-to-events overlay sits over the
            editor: it captures the drag (so Monaco never sees it and can't move
            its cursor/scroll) and computes the drop edge. The visual highlight
            (`.drop-zone`) animates smoothly between edges. */}
        {tabDragging && (
          <div
            className="drop-capture"
            // The overlay only exists while a tab is being dragged, so EVERY
            // dragover here is a tab — always preventDefault to stay a valid drop
            // target (Chromium hides custom MIME types during dragover, so a
            // `types` check here would wrongly disable in-window drops).
            onDragOver={(e) => {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              const edge = edgeFromPoint(rect, e.clientX, e.clientY);
              // Only highlight/accept where the drop would actually do something;
              // elsewhere show the OS "no-drop" cursor and no zone.
              if (edgeAllowed(edge)) {
                e.dataTransfer.dropEffect = "move";
                setDropEdge(edge);
              } else {
                e.dataTransfer.dropEffect = "none";
                setDropEdge(null);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDropEdge(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              const payload = readTabPayload(e.dataTransfer);
              const edge = dropEdge ?? "center";
              setDropEdge(null);
              // Reset here too: a successful move may unmount the source tab
              // before its onDragEnd fires, which would otherwise leave the
              // overlay stuck on.
              props.onTabDragEnd();
              // Guard the drop with the same rule, so a no-op edge never fires.
              if (payload && edgeAllowed(edge))
                props.onTabDrop(edge, payload.groupId, payload.path);
            }}
          >
            {dropEdge && (
              <div className={`drop-zone drop-${dropEdge}`}>
                <span className="drop-zone-label">{edgeLabel(dropEdge)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
