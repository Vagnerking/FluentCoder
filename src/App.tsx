import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  subscribeDiagnostics,
  diagnosticsVersion,
  allStoredProblems,
  clearAllDiagnostics,
} from "./lsp/diagnosticsStore";
import {
  runBuildDiagnostics,
  clearBuildDiagnostics,
} from "./lsp/buildDiagnostics";
import { FileExplorer } from "./components/FileExplorer";
import { SearchPanel } from "./components/SearchPanel";
import { GitPanel } from "./components/GitPanel";
import { RunPanel } from "./components/RunPanel";
import { PackagesPanel } from "./components/PackagesPanel";
import { PlaceholderPanel } from "./components/PlaceholderPanel";
import { EditorGrid } from "./components/EditorGrid";
import { EditorGroupView } from "./components/EditorGroupView";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { invalidateGraph } from "./graph/graphCache";
import { invalidateIndex } from "./knowledge/knowledgeCache";
import type { TabDragPayload } from "./components/TabBar";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { addRecentFolder, getRecentFolders } from "./recentFolders";
import { ImagePreview } from "./components/ImagePreview";
import { OpenWithPicker } from "./explorer/OpenWithPicker";
import { defaultModeFor } from "./explorer/openWith";
import { TitleBar } from "./components/TitleBar";
import { ActivityBar } from "./components/ActivityBar";
import { StatusBar } from "./components/StatusBar";
import { TerminalPanel, type PanelTab } from "./components/TerminalPanel";
import { QuickOpen } from "./components/QuickOpen";
import { CommandPalette, type Command } from "./components/CommandPalette";
import {
  RAZOR_PROJECTION_FLAG_KEY,
  isRazorProjectionEnabled,
} from "./lsp/razorProjectionFlag";
import {
  formatModelForSave,
  isFormatOnSaveEnabled,
  toggleFormatOnSave,
} from "./lsp/formatOnSave";
import { AboutDialog } from "./components/AboutDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { AgentSidebar } from "./components/AgentSidebar";
import { BranchPicker } from "./components/BranchPicker";
import { SshConnectDialog } from "./components/SshConnectDialog";
import { RemoteFolderBrowser } from "./components/RemoteFolderBrowser";
import { RemoteConnectionMenu } from "./components/RemoteConnectionMenu";
import { QuickPick, type QuickPickItem } from "./components/QuickPick";
import { QuickInput } from "./components/QuickInput";
import {
  acpCancel,
  acpPrompt,
  acpStopWorkspace,
  acpWarm,
  agentsLoad,
  agentsSave,
  buildSearchIndex,
  gitBranch,
  gitCheckout,
  gitCreateBranch,
  gitDiffFile,
  gitDiffFileStaged,
  gitFetch,
  gitPublish,
  gitPull,
  gitPush,
  gitDiffFileRevision,
  gitLogFile,
  gitShowFileStaged,
  gitShowFileAtCommit,
  gitSnapshotCreate,
  gitSnapshotRestore,
  gitStatus,
  isFreshWindow,
  listProjectFiles,
  buildContextBundle,
  mcpConfig,
  mcpWriteProjectConfig,
  openNewWindow,
  openedWorkspaceFiles,
  pickFile,
  pickFolder,
  pickSavePath,
  pickWorkspaceFile,
  pickWorkspaceSavePath,
  readLocalTextFile,
  readSshTextFile,
  readDir,
  readFile,
  readFileWithEncoding,
  setExplorerWorkspaceRoot,
  sessionLoad,
  sessionSetLastFolder,
  sessionSetOpenFiles,
  sessionSetWorkspace,
  sshConnect,
  sshDisconnect,
  sshListSavedHosts,
  tsVersions,
  clearRemoteTerminals,
  clearRemoteLspServers,
  writeLocalTextFile,
  writeSshTextFile,
  writeFile,
} from "./api";
import type { GitChangeView, GitRevisionDiffTarget, SshConnectInput, SavedHost } from "./api";
import {
  getActiveRemote,
  isRemoteActive,
  setActiveRemote,
  type RemoteSession,
} from "./remote/host";
import { loadLastRemoteTarget, saveLastRemoteTarget } from "./remote/persist";
import {
  clearLocalAttachParam,
  clearRemoteAttachParam,
  encodeLocalAttach,
  encodeRemoteAttach,
  readLocalAttach,
  readRemoteAttach,
  shouldOpenRemoteInNewWindow,
} from "./remote/window";
import {
  clearActiveEditor,
  cursorPosition,
  editorRelease,
  getActiveEditor,
  openDetachedEditor,
  openInDetached,
  takeDetachedState,
  windowAtPosition,
  adoptTabInWindow,
  type DetachedState,
} from "./detach/editorWindow";
import {
  activateFile,
  buildLayout,
  closeFile,
  createLayout,
  getActiveGroup,
  groupOrder,
  insertFileInGroup,
  maxGroupSeq,
  moveFileToGroup,
  openInGroup,
  patchFileEverywhere,
  removeGroup,
  reorderInGroup,
  resizeBranch,
  serializeLayout,
  splitGroupWith,
  splitWithFile,
  type Edge,
  type EditorGroup,
  type EditorLayout,
  type SerializedLayout,
} from "./editorGroups";
import { dropTargetAt } from "./detach/dropTarget";
import { listen, emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as monaco from "monaco-editor";
import { languageForFile, languageLabel, setLanguageOverride } from "./language";
import { toFileUri } from "./lsp/uri";
import { samePath } from "./paths";
import { buildDecorations, decoKey } from "./icon-theme/decorations";
import { useLspManager } from "./lsp/useLspManager";
import { serverIdForLanguage } from "./lsp/servers";
import { TS_PREFER_EDITOR_KEY } from "./lsp/servers/typescript";
import type {
  ConfirmButton,
  EditorActionsApi,
  FileDecoration,
  FileNode,
  BlameHunk,
  GitHistoryTarget,
  GitStatus,
  MatchSelection,
  MenuDef,
  OpenFile,
  OpenMode,
  OpenTab,
  SessionWorkspace,
  Problem,
} from "./types";
import type { LspServerStatus } from "./components/StatusBar";
import {
  createNavigationHistory,
  mouseNavigationDirection,
  navigationTarget,
  recordNavigation,
} from "./navigationHistory";
import {
  buildAgentPrompt,
  createLocalId,
  EMPTY_AGENT_STORE,
  formatEditorContextReference,
  normalizeAgentStore,
  replaceConversation,
} from "./agents/store";
import {
  READ_ONLY_MODES,
  type AgentConversation,
  type AgentDraft,
  type AgentEditorContext,
  type AgentMessage,
  type AgentMode,
  type AgentSelection,
  type AgentStore,
} from "./agents/types";
import { acpResolveModel } from "./acp/providers";
import {
  DEFAULT_GIT_ASSIST_PREFERENCES,
  buildGitAssistPrompt,
  type GitAssistRequest,
} from "./git/assist";
import {
  FLUENT_WORKSPACE_EXTENSION,
  fluentWorkspaceFromCodeWorkspace,
  isFluentWorkspaceFile,
  normalizeWorkspaceFile,
  parseWorkspaceFile,
  serializeWorkspaceFile,
  type NormalizedWorkspace,
} from "./workspace/workspaceFile";

/** Returns the last path segment, handling both Windows and POSIX separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function pathWithinRoot(path: string, root: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const child = normalize(path);
  const parent = normalize(root);
  const windows = /^[a-zA-Z]:\//.test(child) && /^[a-zA-Z]:\//.test(parent);
  const childKey = windows ? child.toLocaleLowerCase("en-US") : child;
  const parentKey = windows ? parent.toLocaleLowerCase("en-US") : parent;
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
}

/** Untitled buffers use a synthetic `untitled:<name>` path (never on disk). */
const UNTITLED_PREFIX = "untitled:";

/** Synthetic path of the (single) context-graph tab — never on disk, so it's
 *  excluded from saving and session restore. */
const GRAPH_URI = "fluentcoder://graph";
function isGraphTab(path: string): boolean {
  return path === GRAPH_URI;
}

const GIT_REVISION_URI_PREFIX = "fluentcoder://git/";
const GIT_DIFF_URI_PREFIX = "fluentcoder://git-diff/";
function gitRevisionUri(filePath: string, shortHash: string): string {
  return `${GIT_REVISION_URI_PREFIX}${encodeURIComponent(shortHash)}/${encodeURIComponent(filePath)}`;
}
function gitRevisionDiffUri(
  filePath: string,
  shortHash: string,
  compareTo: GitRevisionDiffTarget
): string {
  return `${GIT_DIFF_URI_PREFIX}${encodeURIComponent(shortHash)}/${compareTo}/${encodeURIComponent(filePath)}`;
}
function gitWorkingDiffUri(filePath: string): string {
  return `${GIT_DIFF_URI_PREFIX}working/${encodeURIComponent(filePath)}`;
}
function gitStagedDiffUri(filePath: string): string {
  return `${GIT_DIFF_URI_PREFIX}staged/${encodeURIComponent(filePath)}`;
}
function isGitRevisionTab(path: string): boolean {
  return path.startsWith(GIT_REVISION_URI_PREFIX);
}
function isGitDiffTab(path: string): boolean {
  return path.startsWith(GIT_DIFF_URI_PREFIX);
}
function isVirtualTab(path: string): boolean {
  return isGraphTab(path) || isGitRevisionTab(path) || isGitDiffTab(path);
}

type ActiveWorkspace = NormalizedWorkspace & {
  filePath: string | null;
  dirty: boolean;
};

type SshFolderPickMode = "openRemote" | "addToWorkspace";

type WorkspaceSshConnection = {
  status: "connecting" | "connected" | "error";
  connId?: string;
  error?: string;
};

type WorkspaceGitTarget = {
  id: string;
  rootPath: string;
  connId?: string;
};

type WorkspaceGitState = WorkspaceGitTarget & {
  status: GitStatus | null;
};

function workspaceSessionSnapshot(workspace: ActiveWorkspace): SessionWorkspace {
  return {
    filePath: workspace.filePath,
    data: {
      fluentWorkspace: 1,
      name: workspace.name,
      folders: workspace.folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        path: folder.path,
        remote: folder.remote,
      })),
      git: { mode: workspace.gitMode },
      settings: workspace.settings,
    },
  };
}

function workspaceNameAfterAddingRoot(workspace: ActiveWorkspace): string {
  if (workspace.filePath) return workspace.name;
  return hasImplicitWorkspaceName(workspace)
    ? createUntitledWorkspaceName()
    : workspace.name;
}

function createUntitledWorkspaceName(): string {
  return `Workspace ${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function needsUntitledWorkspaceName(workspace: ActiveWorkspace): boolean {
  return !workspace.filePath && workspace.folders.length > 1 && hasImplicitWorkspaceName(workspace);
}

function hasImplicitWorkspaceName(workspace: ActiveWorkspace): boolean {
  const name = workspace.name.trim();
  const firstFolderName = workspace.folders[0]?.name.trim();
  return (
    name === "" ||
    name === "Workspace" ||
    (Boolean(firstFolderName) && name === firstFolderName)
  );
}

async function readGitFileAtCommitOrEmpty(
  rootPath: string,
  filePath: string,
  commit: string,
  connId?: string
): Promise<string> {
  try {
    return await gitShowFileAtCommit(rootPath, filePath, commit, connId);
  } catch {
    return "";
  }
}

async function readWorkingFileOrEmpty(filePath: string, connId?: string): Promise<string> {
  try {
    return connId
      ? (await readSshTextFile(connId, filePath)).content
      : (await readFile(filePath)).content;
  } catch {
    return "";
  }
}

/** How long the user must press-and-hold a draggable chrome element (activity bar,
 * panel) before the drag arms. A deliberate hold tells "I want to move this" apart
 * from a click; the cursor and a charging ring give feedback while it builds up. */
const DRAG_HOLD_MS = 600;

/** Sidebar width clamps. With the activity bar on TOP/BOTTOM it's a horizontal
 * strip with all primary + utility icons, so the sidebar cannot be narrower than
 * the strip itself. Otherwise the bar clips or visually becomes a stranded column
 * while the explorer keeps shrinking beneath it. */
const SIDEBAR_MIN = 180;
const SIDEBAR_MIN_HORIZONTAL_ACTIVITY = 396;
// Sidebar secundária (chat de agentes), no lado oposto à principal.
const AGENTS_SIDEBAR_MIN = 320;
const AGENTS_SIDEBAR_DEFAULT = 500;

function isUntitled(path: string): boolean {
  return path.startsWith(UNTITLED_PREFIX);
}

/** Editor tab size — kept in one place so the StatusBar and Monaco agree. */
const TAB_SIZE = 2;

/** Encodings offered in the "Reopen with Encoding" picker. `id` is the label
 *  understood by the Rust backend (encoding_rs `for_label`). */
const COMMON_ENCODINGS: { id: string; label: string }[] = [
  { id: "UTF-8", label: "UTF-8" },
  { id: "UTF-16LE", label: "UTF-16 LE" },
  { id: "UTF-16BE", label: "UTF-16 BE" },
  { id: "windows-1252", label: "Windows 1252 (Latin-1)" },
  { id: "ISO-8859-1", label: "ISO 8859-1" },
  { id: "windows-1251", label: "Windows 1251 (Cyrillic)" },
  { id: "Shift_JIS", label: "Shift JIS" },
  { id: "GBK", label: "GBK (Simplified Chinese)" },
];

/** Reads a persisted layout number from localStorage, falling back on error. */
function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

/** Reads the persisted sidebar side ("left"/"right"), defaulting on error. */
function readStoredSide(key: string, fallback: "left" | "right"): "left" | "right" {
  try {
    const raw = localStorage.getItem(key);
    return raw === "left" || raw === "right" ? raw : fallback;
  } catch {
    return fallback;
  }
}

/** Activity bar placement around the primary sidebar/explorer.
    The bar is always visible — it can't be fully hidden (it hosts the views). */
type ActivityBarPos = "side" | "right" | "top" | "bottom";
function readStoredActivityPos(key: string, fallback: ActivityBarPos): ActivityBarPos {
  try {
    const raw = localStorage.getItem(key);
    // A previously-stored "hidden" now falls back to the lateral bar.
    return raw === "side" || raw === "right" || raw === "top" || raw === "bottom"
      ? raw
      : fallback;
  } catch {
    return fallback;
  }
}

/** A drop target for the activity-bar drag. `window-*` moves the whole dock. */
type DropZone = "left" | "right" | "top" | "bottom" | "window-left" | "window-right";
/** Maps a pointer position to the activity-bar drop zone under it (or null). */
function activityZoneAtPoint(x: number, y: number, dockRect?: DOMRect | null): DropZone | null {
  if (dockRect) {
    const margin = 72;
    const nearDock =
      x >= dockRect.left - margin &&
      x <= dockRect.right + margin &&
      y >= dockRect.top - margin &&
      y <= dockRect.bottom + margin;
    if (nearDock) {
      const verticalEdge = Math.min(112, Math.max(64, dockRect.height * 0.14));
      const horizontalEdge = Math.min(76, Math.max(38, dockRect.width * 0.18));
      if (y >= dockRect.bottom - verticalEdge) return "bottom";
      if (y <= dockRect.top + verticalEdge) return "top";
      if (x >= dockRect.right - horizontalEdge) return "right";
      if (x <= dockRect.left + horizontalEdge) return "left";
    }
  }

  const w = window.innerWidth;
  const h = window.innerHeight;
  if (x < w * 0.12) return "window-left";
  if (x > w * 0.88) return "window-right";
  if (y < h * 0.16) return "top";
  if (y > h * 0.84) return "bottom";
  return null;
}

/** Where the bottom panel (terminal/problems) is docked relative to the editor. */
type PanelPos = "bottom" | "right" | "left";
function readStoredPanelPos(key: string, fallback: PanelPos): PanelPos {
  try {
    const raw = localStorage.getItem(key);
    return raw === "bottom" || raw === "right" || raw === "left" ? raw : fallback;
  } catch {
    return fallback;
  }
}
/** Maps a pointer position to a panel drop zone (bottom / right / left, or null). */
function panelZoneAtPoint(x: number, y: number): PanelPos | null {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (y > h * 0.7) return "bottom";
  if (x > w * 0.7) return "right";
  if (x < w * 0.3) return "left";
  return null;
}

export default function App() {
  const [rootName, setRootName] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<ActiveWorkspace | null>(null);
  const [workspaceSshConnections, setWorkspaceSshConnections] = useState<
    Record<string, WorkspaceSshConnection>
  >({});
  // Mirrors rootPath for async callbacks (e.g. ACP streaming) that must detect a
  // workspace switch mid-flight without capturing a stale closure value.
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;
  const agentWorkspaceRootRef = useRef<string | null>(null);
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Resizable + side-swappable sidebar (VSCode-style), persisted across sessions.
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredNumber("ui.sidebarWidth", 260)
  );
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">(() =>
    readStoredSide("ui.sidebarSide", "left")
  );
  // Activity bar placement (independent of the sidebar) — lateral, top, or hidden.
  const [activityBarPos, setActivityBarPos] = useState<ActivityBarPos>(() =>
    readStoredActivityPos("ui.activityBarPos", "side")
  );
  // Secondary side bar hosting the AI agents chat: docks on the side OPPOSITE
  // the primary sidebar, toggled from the title bar, resizable and persisted.
  const [agentsSidebarOpen, setAgentsSidebarOpen] = useState(false);
  const [agentsSidebarWidth, setAgentsSidebarWidth] = useState(() =>
    readStoredNumber("ui.agentsSidebarWidth", AGENTS_SIDEBAR_DEFAULT)
  );
  // The agents chat lives on the opposite edge from the primary sidebar.
  const agentsSide = sidebarSide === "left" ? "right" : "left";
  const [branch, setBranch] = useState<string | null>(null);

  // The editor area is a tree of groups (VS Code-style split grid). `layout` is
  // the single source of truth; `openFiles`/`activePath` below are the ACTIVE
  // group's view, and `setOpenFiles`/`setActivePath` are stable wrappers that
  // edit the active group — so the existing handlers keep working unchanged
  // while the data model is already multi-group.
  const [layout, setLayout] = useState<EditorLayout>(() =>
    createLayout({ id: "g0", files: [], activePath: null })
  );
  const FALLBACK_GROUP = useRef<EditorGroup>({
    id: "g0",
    files: [],
    activePath: null,
  }).current;
  const activeGroup = getActiveGroup(layout) ?? FALLBACK_GROUP;
  const openFiles = activeGroup.files;
  const activePath = activeGroup.activePath;

  const setOpenFiles = useCallback<Dispatch<SetStateAction<OpenFile[]>>>(
    (action) => {
      setLayout((l) => {
        const g = l.groups[l.activeGroup];
        if (!g) return l;
        const next =
          typeof action === "function"
            ? (action as (p: OpenFile[]) => OpenFile[])(g.files)
            : action;
        if (next === g.files) return l;
        return {
          ...l,
          groups: { ...l.groups, [l.activeGroup]: { ...g, files: next } },
        };
      });
    },
    []
  );
  const setActivePath = useCallback<Dispatch<SetStateAction<string | null>>>(
    (action) => {
      setLayout((l) => {
        const g = l.groups[l.activeGroup];
        if (!g) return l;
        const next =
          typeof action === "function"
            ? (action as (p: string | null) => string | null)(g.activePath)
            : action;
        if (next === g.activePath) return l;
        return {
          ...l,
          groups: { ...l.groups, [l.activeGroup]: { ...g, activePath: next } },
        };
      });
    },
    []
  );

  const activeGroupId = layout.activeGroup;
  // Latest layout, readable from stable callbacks without re-subscribing.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Monotonic group-id source ("g0" already exists; next ones start at "g1").
  const groupSeq = useRef(1);
  const allOpenFiles = useCallback(() => {
    const byPath = new Map<string, OpenFile>();
    for (const group of Object.values(layoutRef.current.groups)) {
      for (const file of group.files) byPath.set(file.path, file);
    }
    return [...byPath.values()];
  }, []);
  const resetEditorLayout = useCallback(() => {
    setLayout(createLayout({ id: "g0", files: [], activePath: null }));
    groupSeq.current = 1;
  }, []);
  const nextGroupId = useCallback(() => `g${groupSeq.current++}`, []);
  // True while a tab is being dragged, so every group shields its editor with a
  // drop-zone overlay (Monaco mustn't move its cursor/scroll under the drag).
  const [tabDragging, setTabDragging] = useState(false);
  // The tab in flight (origin group + path), so each group can judge whether a
  // drop on it would actually change the layout before lighting up a drop-zone.
  const [activeTabDrag, setActiveTabDrag] = useState<TabDragPayload | null>(null);
  // The last REAL file the user looked at (not the graph tab), so the graph view
  // can highlight "where you are" even while its own tab is focused.
  const [lastRealFile, setLastRealFile] = useState<string | null>(null);
  // A tab dragged from ANOTHER window is hovering THIS one: either over a tab
  // strip (show the insertion bar at `dropBar`) or elsewhere (whole-window hint).
  const [dropHint, setDropHint] = useState(false);
  const [dropBar, setDropBar] = useState<
    { left: number; top: number; height: number } | null
  >(null);
  // The window we last sent a hint to (as the drag source).
  const lastHintRef = useRef<string | null>(null);
  const handledLaunchWorkspaceRef = useRef(false);

  // As the drag source, continuously tell whichever OTHER window is under the
  // cursor where the cursor is, so it can place its own insertion indicator.
  const handleDragMove = useCallback(async (x: number, y: number) => {
    let target: string | null = null;
    try {
      target = await windowAtPosition(x, y, "");
    } catch {
      target = null;
    }
    const myLabel = getCurrentWindow().label;
    const hint = target && target !== myLabel ? target : null;
    if (lastHintRef.current && lastHintRef.current !== hint) {
      void emitTo(lastHintRef.current, "drop-hint", { active: false });
    }
    lastHintRef.current = hint;
    if (hint) void emitTo(hint, "drop-hint", { active: true, x, y });
  }, []);
  const clearDragHint = useCallback(() => {
    if (lastHintRef.current) {
      void emitTo(lastHintRef.current, "drop-hint", { active: false });
      lastHintRef.current = null;
    }
  }, []);

  // Poll the GLOBAL cursor while dragging: HTML5 `drag` freezes once the cursor
  // leaves this window, so we read the OS cursor to keep hinting other windows.
  const dragPoll = useRef(0);
  const startDragPoll = useCallback(() => {
    if (dragPoll.current) return;
    dragPoll.current = window.setInterval(async () => {
      try {
        const [x, y] = await cursorPosition();
        void handleDragMove(x, y);
      } catch {
        /* ignore */
      }
    }, 50);
  }, [handleDragMove]);
  const stopDragPoll = useCallback(() => {
    if (dragPoll.current) {
      clearInterval(dragPoll.current);
      dragPoll.current = 0;
    }
  }, []);

  // This window reacts to hints aimed at it: resolve the cursor to a tab-strip
  // insertion point (bar) or fall back to the whole-window highlight.
  useEffect(() => {
    const un = listen<{ active: boolean; x?: number; y?: number }>(
      "drop-hint",
      (e) => {
        if (!e.payload.active || e.payload.x == null || e.payload.y == null) {
          setDropHint(false);
          setDropBar(null);
          return;
        }
        const t = dropTargetAt(e.payload.x, e.payload.y);
        if (t) {
          setDropBar(t.bar);
          setDropHint(false);
        } else {
          setDropBar(null);
          setDropHint(true);
        }
      }
    );
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  // Safety net: any drag end/drop anywhere clears the shield + hints, so they
  // can never get stuck on (e.g. if the source tab unmounts mid-drag).
  useEffect(() => {
    const reset = () => {
      setTabDragging(false);
      setDropHint(false);
      setDropBar(null);
      clearDragHint();
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [clearDragHint]);

  const navigationHistoryRef = useRef(createNavigationHistory());
  const historyNavigationTargetRef = useRef<string | null>(null);
  const historyNavigationPendingRef = useRef(false);
  // True while the launch-time restore is reopening saved tabs. Guards the
  // session-save effect so the partial state mid-restore never overwrites the
  // good session on disk (e.g. saving an empty tab list before the first tab
  // reopens). Cleared once the restore finishes.
  const restoringSessionRef = useRef(false);
  // Guards the boot restore against React.StrictMode's double-invoke in dev (it
  // would otherwise reopen every saved tab twice).
  const bootRestoredRef = useRef(false);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelHeight, setPanelHeight] = useState(() =>
    readStoredNumber("ui.panelHeight", 220)
  );
  // Bottom panel placement (bottom / docked right / docked left) + its width when
  // docked to a side. Both persisted, like the rest of the layout.
  const [panelPos, setPanelPos] = useState<PanelPos>(() =>
    readStoredPanelPos("ui.panelPos", "bottom")
  );
  const [panelWidth, setPanelWidth] = useState(() =>
    readStoredNumber("ui.panelWidth", 360)
  );
  // Which bottom-panel tab to focus + a nonce so the same tab can be re-focused.
  // Lets the status bar's diagnostic counts open the panel straight to Problems.
  const [panelTab, setPanelTab] = useState<PanelTab>("terminal");
  const [panelTabNonce, setPanelTabNonce] = useState(0);
  const [activeView, setActiveView] = useState("explorer");
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branchPickerTarget, setBranchPickerTarget] = useState<WorkspaceGitTarget | null>(null);
  // Generic VS Code-style quick-pick, reused by any "pick one option" flow (the
  // TypeScript version picker today; future runtime/version selectors next).
  const [quickPick, setQuickPick] = useState<{
    title: string;
    placeholder: string;
    items: QuickPickItem[];
    onPick: (item: QuickPickItem) => void;
  } | null>(null);
  // User-chosen language modes (VS Code's "Change Language Mode"), keyed by file
  // path. Mirrored into the `language.ts` override map so `languageForFile`
  // everywhere — including the editor's Monaco model — honors the choice; kept in
  // React state here purely so the status bar + LSP recompute when it changes.
  const [languageOverrides, setLanguageOverrides] = useState<
    Record<string, string>
  >({});
  // SSH connect flow (VS Code style): a host quick-pick → password prompt / form.
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [sshHostsOpen, setSshHostsOpen] = useState(false);
  const [sshSavedHosts, setSshSavedHosts] = useState<SavedHost[]>([]);
  const [sshPasswordFor, setSshPasswordFor] = useState<SavedHost | null>(null);
  const [sshFormInitial, setSshFormInitial] = useState<
    Partial<SshConnectInput> | undefined
  >(undefined);
  const [reconnectWorkspaceRootId, setReconnectWorkspaceRootId] = useState<string | null>(null);
  const [sshFolderPickMode, setSshFolderPickMode] =
    useState<SshFolderPickMode>("openRemote");
  // After a successful connect, holds the open connection while the user browses
  // for a folder. `input` is the credentials for a brand-new connection (cancel
  // disconnects); null when reusing an already-attached session (cancel keeps it).
  const [remoteBrowser, setRemoteBrowser] = useState<{
    connId: string;
    host: string;
    user: string;
    input: SshConnectInput | null;
    mode: SshFolderPickMode;
  } | null>(null);
  // Connection-management menu (opened by clicking the status-bar SSH chip).
  const [manageMenuOpen, setManageMenuOpen] = useState(false);
  // True while attached to a remote host (drives the status-bar indicator and
  // read-only guards). Mirrors the ambient `getActiveRemote()` for rendering.
  const [remoteSession, setRemoteSession] = useState<RemoteSession | null>(null);
  const [agentStore, setAgentStore] = useState<AgentStore>(() => ({
    ...EMPTY_AGENT_STORE,
  }));
  const [agentSelection, setAgentSelection] = useState<AgentSelection>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  // Status/erro do chat amarrados à conversa que os produziu (`conversationId:
  // null` = aviso global, ex.: falha ao carregar/persistir o store). A UI só
  // exibe o aviso na conversa dona — abrir outro chat não mostra o erro alheio.
  const [agentStatus, setAgentStatus] = useState<{
    conversationId: string | null;
    message: string;
  } | null>(null);
  const [agentError, setAgentError] = useState<{
    conversationId: string | null;
    message: string;
  } | null>(null);
  // Raciocínio em streaming do turno atual (thinking do Claude / resumo de
  // reasoning do Codex). Efêmero: exibido ao vivo na conversa dona enquanto o
  // modelo pensa e descartado quando a resposta começa — nunca persistido.
  const [agentThought, setAgentThought] = useState<{
    conversationId: string;
    text: string;
  } | null>(null);
  // Conversa com turno em andamento (para o Stop reportar status no chat certo).
  const streamingConversationIdRef = useRef<string | null>(null);
  // Operating mode for the chat composer. Lifted here (not local to AgentChat)
  // so the choice survives switching conversations, views, or sidebar panels.
  const [agentMode, setAgentMode] = useState<AgentMode>("ask");

  // "Open With…" selector (ISSUE-70): the file + anchor point while it's shown.
  const [openWith, setOpenWith] = useState<
    { path: string; x: number; y: number } | null
  >(null);

  // File whose git history the Source Control panel should show (ISSUE-71 ·
  // File History). Null = the panel shows its normal repo-wide history.
  const [historyFile, setHistoryFile] = useState<string | null>(null);
  const [historyTarget, setHistoryTarget] = useState<GitHistoryTarget | null>(null);
  // Which Help dialog is open: the About box, the shortcuts list, or none.
  const [helpDialog, setHelpDialog] = useState<"about" | "shortcuts" | null>(null);

  // The unsaved-changes confirmation dialog, when one is open. `resolve` feeds
  // the user's choice back to the awaiting `askConfirm` Promise. The buttons are
  // typed as strings so each caller can use its own answer set.
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    buttons: ConfirmButton<string>[];
    resolve: (value: string | null) => void;
  } | null>(null);

  /**
   * Opens the {@link ConfirmDialog} and resolves with the chosen button's value
   * (or `null` on Esc/overlay). The dialog is modeless to React state, so this
   * just parks a `resolve` until the user picks. Reused by the close-tab,
   * close-window and switch-folder guards.
   */
  const askConfirm = useCallback(
    (
      title: string,
      message: string,
      buttons: ConfirmButton<string>[]
    ): Promise<string | null> =>
      new Promise((resolve) => {
        setConfirm({ title, message, buttons, resolve });
      }),
    []
  );

  // Paths whose close is mid-confirmation, so a second X/Ctrl+W on the same tab
  // doesn't stack a duplicate dialog (simple debounce per path).
  const closingPaths = useRef<Set<string>>(new Set());

  // Current "Run": command line + a nonce that bumps on each ▶ to respawn the PTY.
  const [runCommand, setRunCommand] = useState<string | null>(null);
  const [runCwd, setRunCwd] = useState<string | null>(null);
  const [runConnId, setRunConnId] = useState<string | null>(null);
  const [runNonce, setRunNonce] = useState(0);

  // "Abrir no Terminal" target: a cwd + nonce that spawns a fresh PTY there.
  const [terminalOpenCwd, setTerminalOpenCwd] = useState<string | null>(null);
  const [terminalOpenConnId, setTerminalOpenConnId] = useState<string | null>(null);
  const [terminalOpenNonce, setTerminalOpenNonce] = useState(0);
  // "Localizar na pasta": sub-folder the search is scoped to (null = root).
  const [searchScope, setSearchScope] = useState<{ path: string; rootId?: string } | null>(null);

  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [currentLineBlame, setCurrentLineBlame] = useState<{
    hunk: BlameHunk;
    filePath: string;
  } | null>(null);

  useEffect(() => {
    setCurrentLineBlame(null);
  }, [activePath, activeGroupId]);

  const [problems, setProblems] = useState<Problem[]>([]);

  // Workspace-wide diagnostics (issue #6): the editor markers (`problems`) cover
  // OPEN files; the LSP store adds diagnostics the servers reported for the rest
  // of the workspace (e.g. Roslyn's `relatedDocuments`). Merge + de-dupe so the
  // Problems panel, counts and explorer badges reflect the whole project.
  const diagVersion = useSyncExternalStore(
    subscribeDiagnostics,
    diagnosticsVersion
  );
  const allProblems = useMemo(() => {
    void diagVersion; // re-run when the store changes
    const seen = new Set<string>();
    const merged: Problem[] = [];
    for (const p of [...problems, ...allStoredProblems()]) {
      // Canonicalize the path in the dedup key (decoKey: slashes + drive-letter
      // case). The same diagnostic can arrive twice — as a Monaco marker (path
      // from the model URI, e.g. `c:\…`) and from the workspace store (path the
      // server keyed on, e.g. `C:/…`); without canonicalization the Problems
      // panel would list each `.cshtml` diagnostic twice. (The Razor projection
      // mirrors its `.cshtml` diagnostics into both.)
      const key = `${decoKey(p.path)}|${p.line}|${p.column}|${p.severity}|${p.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(p);
    }
    return merged;
  }, [problems, diagVersion]);

  // Git status of the open folder, used (with diagnostics) to decorate the
  // explorer/tabs. Refreshed when the folder changes; null when not a repo.
  const [gitState, setGitState] = useState<GitStatus | null>(null);
  const [workspaceGitStates, setWorkspaceGitStates] = useState<
    Record<string, WorkspaceGitState>
  >({});
  const [recents, setRecents] = useState<string[]>(() => getRecentFolders());
  const [gitBusy, setGitBusy] = useState(false);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [autoFetch, setAutoFetch] = useState(
    () => localStorage.getItem("git.autofetch") !== "off"
  );

  const activeGitTarget = useMemo(() => {
    const candidatePath = activePath && !isVirtualTab(activePath) ? activePath : rootPath;
    let owner:
      | {
          id: string;
          name: string;
          path: string;
          provider: "local" | "ssh";
        }
      | null = null;

    if (activeWorkspace && candidatePath) {
      for (const folder of activeWorkspace.folders) {
        if (!pathWithinRoot(candidatePath, folder.path)) continue;
        if (!owner || folder.path.length > owner.path.length) owner = folder;
      }
    }

    if (owner) {
      if (owner.provider === "ssh") {
        const conn = workspaceSshConnections[owner.id];
        if (conn?.status !== "connected" || !conn.connId) return null;
        return {
          rootPath: owner.path,
          connId: conn.connId,
          label: owner.name,
          provider: owner.provider,
        };
      }
      return {
        rootPath: owner.path,
        connId: undefined,
        label: owner.name,
        provider: owner.provider,
      };
    }

    if (!rootPath) return null;
    return {
      rootPath,
      connId: remoteSession?.connId,
      label: rootName ?? baseName(rootPath),
      provider: remoteSession ? ("ssh" as const) : ("local" as const),
    };
  }, [activePath, activeWorkspace, remoteSession, rootName, rootPath, workspaceSshConnections]);

  const branchPickerGitTarget = useMemo<WorkspaceGitTarget | null>(() => {
    if (branchPickerTarget) return branchPickerTarget;
    if (!activeGitTarget) return null;
    return {
      id: "active",
      rootPath: activeGitTarget.rootPath,
      connId: activeGitTarget.connId,
    };
  }, [activeGitTarget, branchPickerTarget]);

  const openActiveBranchPicker = useCallback(() => {
    setBranchPickerTarget(null);
    setBranchPickerOpen(true);
  }, []);

  const gitTargetForPath = useCallback(
    (filePath: string) => {
      if (activeWorkspace) {
        let best:
          | {
              rootPath: string;
              connId?: string;
              matchLength: number;
            }
          | null = null;
        for (const folder of activeWorkspace.folders) {
          if (!pathWithinRoot(filePath, folder.path)) continue;
          if (folder.provider === "ssh") {
            const conn = workspaceSshConnections[folder.id];
            if (conn?.status !== "connected" || !conn.connId) continue;
            if (!best || folder.path.length > best.matchLength) {
              best = {
                rootPath: folder.path,
                connId: conn.connId,
                matchLength: folder.path.length,
              };
            }
            continue;
          }
          if (!best || folder.path.length > best.matchLength) {
            best = {
              rootPath: folder.path,
              matchLength: folder.path.length,
            };
          }
        }
        if (best) {
          const { matchLength: _matchLength, ...target } = best;
          return target;
        }
      }

      if (!rootPath) return null;
      return {
        rootPath,
        connId: remoteSession?.connId,
      };
    },
    [activeWorkspace, remoteSession, rootPath, workspaceSshConnections]
  );

  const workspaceGitTargets = useMemo<WorkspaceGitTarget[]>(() => {
    if (!activeWorkspace) return [];
    return activeWorkspace.folders.flatMap((folder) => {
      if (folder.provider === "ssh") {
        const conn = workspaceSshConnections[folder.id];
        if (conn?.status !== "connected" || !conn.connId) return [];
        return [{ id: folder.id, rootPath: folder.path, connId: conn.connId }];
      }
      return [{ id: folder.id, rootPath: folder.path }];
    });
  }, [activeWorkspace, workspaceSshConnections]);

  const refreshWorkspaceGitStatuses = useCallback(async () => {
    if (!activeWorkspace || workspaceGitTargets.length === 0) {
      setWorkspaceGitStates({});
      return;
    }

    const entries = await Promise.all(
      workspaceGitTargets.map(async (target) => {
        try {
          return {
            ...target,
            status: await gitStatus(target.rootPath, target.connId),
          };
        } catch {
          return { ...target, status: null };
        }
      })
    );

    setWorkspaceGitStates(
      Object.fromEntries(entries.map((entry) => [entry.id, entry]))
    );
  }, [activeWorkspace, workspaceGitTargets]);

  useEffect(() => {
    if (!activeWorkspace || workspaceGitTargets.length === 0) {
      setWorkspaceGitStates({});
      return;
    }

    void refreshWorkspaceGitStatuses();
    const id = window.setInterval(() => {
      void refreshWorkspaceGitStatuses();
    }, 5000);
    const onFocus = () => {
      void refreshWorkspaceGitStatuses();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeWorkspace, refreshWorkspaceGitStatuses, workspaceGitTargets.length]);

  // Keep git status live while a repo is open, so the status bar's ahead/behind,
  // conflicts and branch stay current (VS Code refreshes on focus + on a timer).
  const refreshGitStatus = useCallback(() => {
    if (!activeGitTarget) {
      setGitState(null);
      setBranch(null);
      return;
    }
    gitStatus(activeGitTarget.rootPath, activeGitTarget.connId)
      .then((s) => {
        setGitState(s);
        setBranch(s.isRepo ? s.branch : null);
      })
      .catch(() => {});
  }, [activeGitTarget]);

  useEffect(() => {
    if (!activeGitTarget) return;
    refreshGitStatus();
    const id = window.setInterval(refreshGitStatus, 5000);
    const onFocus = () => refreshGitStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeGitTarget, refreshGitStatus]);

  // Periodic background fetch (VS Code's git.autofetch), so behind-counts show up
  // without a manual fetch. Toggleable + persisted in localStorage.
  useEffect(() => {
    if (!activeGitTarget || !autoFetch) return;
    const id = window.setInterval(() => {
      gitFetch(activeGitTarget.rootPath, activeGitTarget.connId)
        .then(() => {
          setLastFetch(Date.now());
          refreshGitStatus();
        })
        .catch(() => {});
    }, 180_000);
    return () => clearInterval(id);
  }, [activeGitTarget, autoFetch, refreshGitStatus]);

  const toggleAutoFetch = useCallback(() => {
    setAutoFetch((v) => {
      const next = !v;
      localStorage.setItem("git.autofetch", next ? "on" : "off");
      return next;
    });
  }, []);

  // Runs a git op with a spinner, surfaces errors, then refreshes status.
  const runGitOp = useCallback(
    async (fn: (root: string, connId?: string) => Promise<unknown>) => {
      if (!activeGitTarget || gitBusy) return;
      setGitBusy(true);
      try {
        await fn(activeGitTarget.rootPath, activeGitTarget.connId);
      } catch (err) {
        alert(`Git: ${err}`);
      } finally {
        setGitBusy(false);
        refreshGitStatus();
        void refreshWorkspaceGitStatuses();
      }
    },
    [activeGitTarget, gitBusy, refreshGitStatus, refreshWorkspaceGitStatuses]
  );

  const handleGitSync = useCallback(
    () =>
      runGitOp(async (root, connId) => {
        await gitPull(root, connId);
        await gitPush(root, connId);
      }),
    [runGitOp]
  );
  const handleGitFetch = useCallback(
    () =>
      runGitOp(async (root, connId) => {
        await gitFetch(root, connId);
        setLastFetch(Date.now());
      }),
    [runGitOp]
  );
  const handleGitPull = useCallback(
    () => runGitOp((root, connId) => gitPull(root, connId)),
    [runGitOp]
  );
  const handleGitPush = useCallback(
    () => runGitOp((root, connId) => gitPush(root, connId)),
    [runGitOp]
  );
  const handleGitPublish = useCallback(
    () => runGitOp((root, connId) => gitPublish(root, connId)),
    [runGitOp]
  );

  // path → decoration (label color + git badge), rebuilt only when an input
  // changes. The lookup normalizes separators so callers can pass any path.
  const decorations = useMemo(() => {
    if (!activeWorkspace) return buildDecorations(rootPath, gitState, allProblems);

    const merged = new Map<string, FileDecoration>();
    for (const target of workspaceGitTargets) {
      const rootProblems = allProblems.filter((problem) =>
        pathWithinRoot(problem.path, target.rootPath)
      );
      const rootDecorations = buildDecorations(
        target.rootPath,
        workspaceGitStates[target.id]?.status ?? null,
        rootProblems
      );
      for (const [path, decoration] of rootDecorations) {
        merged.set(path, decoration);
      }
    }
    return merged;
  }, [activeWorkspace, allProblems, gitState, rootPath, workspaceGitStates, workspaceGitTargets]);
  const decorationFor = useCallback(
    (path: string) => decorations.get(decoKey(path)),
    [decorations]
  );

  // Absolute paths of files changed in the working tree (issue #19) — feeds the
  // explorer's "only changed files" toggle. Relative git paths are joined to the
  // root with the same scheme GitPanel uses to open them.
  const changedPaths = useMemo(() => {
    if (activeWorkspace) {
      return workspaceGitTargets.flatMap((target) => {
        const status = workspaceGitStates[target.id]?.status;
        if (!status?.isRepo) return [];
        return status.files.map((f) => `${target.rootPath}/${f.path}`);
      });
    }
    if (!rootPath || !gitState?.isRepo) return [];
    return gitState.files.map((f) => `${rootPath}/${f.path}`);
  }, [activeWorkspace, gitState, rootPath, workspaceGitStates, workspaceGitTargets]);

  const explorerWorkspaceRoots = useMemo(
    () =>
      activeWorkspace?.folders.map((folder) => {
        const ssh = workspaceSshConnections[folder.id];
        return {
          ...folder,
          connId: ssh?.connId,
          status: ssh?.status,
          error: ssh?.error,
        };
      }),
    [activeWorkspace, workspaceSshConnections]
  );

  const explorerIsWorkspace = useMemo(
    () =>
      Boolean(
        activeWorkspace &&
          (activeWorkspace.filePath ||
            activeWorkspace.dirty ||
            activeWorkspace.folders.length > 1 ||
            activeWorkspace.folders.some((folder) => folder.provider === "ssh"))
      ),
    [activeWorkspace]
  );

  useEffect(() => {
    setActiveWorkspace((current) =>
      current && needsUntitledWorkspaceName(current)
        ? { ...current, name: createUntitledWorkspaceName(), dirty: true }
        : current
    );
  }, [activeWorkspace]);

  const workspaceRemoteForPath = useCallback(
    (path: string): OpenFile["workspaceRemote"] | undefined => {
      if (!activeWorkspace) return undefined;
      const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
      let best:
        | (OpenFile["workspaceRemote"] & { matchLength: number })
        | undefined;
      for (const folder of activeWorkspace.folders) {
        if (folder.provider !== "ssh" || !folder.remote) continue;
        const conn = workspaceSshConnections[folder.id];
        if (conn?.status !== "connected" || !conn.connId) continue;
        const normalizedRoot = folder.path.replace(/\\/g, "/").replace(/\/+$/, "");
        if (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)) {
          if (!best || normalizedRoot.length > best.matchLength) {
            best = {
              folderId: folder.id,
              connId: conn.connId,
              host: folder.remote.host,
              user: folder.remote.user,
              rootPath: folder.path,
              matchLength: normalizedRoot.length,
            };
          }
        }
      }
      if (!best) return undefined;
      const { matchLength: _matchLength, ...remote } = best;
      return remote;
    },
    [activeWorkspace, workspaceSshConnections]
  );

  const activeContextTarget = useMemo(() => {
    const candidatePath =
      activePath && !isVirtualTab(activePath) ? activePath : lastRealFile;

    if (activeWorkspace && candidatePath) {
      let best:
        | {
            rootPath: string;
            connId?: string;
            label: string;
            workspaceRemote?: OpenFile["workspaceRemote"];
            matchLength: number;
          }
        | null = null;
      for (const folder of activeWorkspace.folders) {
        if (!pathWithinRoot(candidatePath, folder.path)) continue;
        if (folder.provider === "ssh") {
          const conn = workspaceSshConnections[folder.id];
          if (conn?.status !== "connected" || !conn.connId) continue;
          if (!best || folder.path.length > best.matchLength) {
            best = {
              rootPath: folder.path,
              connId: conn.connId,
              label: folder.name,
              workspaceRemote: folder.remote
                ? {
                    folderId: folder.id,
                    connId: conn.connId,
                    host: folder.remote.host,
                    user: folder.remote.user,
                    rootPath: folder.path,
                  }
                : undefined,
              matchLength: folder.path.length,
            };
          }
          continue;
        }
        if (!best || folder.path.length > best.matchLength) {
          best = {
            rootPath: folder.path,
            label: folder.name,
            matchLength: folder.path.length,
          };
        }
      }
      if (best) {
        const { matchLength: _matchLength, ...target } = best;
        return target;
      }
    }

    if (!rootPath) return null;
    return {
      rootPath,
      connId: remoteSession?.connId,
      label: rootName ?? baseName(rootPath),
    };
  }, [
    activePath,
    activeWorkspace,
    lastRealFile,
    remoteSession,
    rootName,
    rootPath,
    workspaceSshConnections,
  ]);

  const agentWorkspaceRoot = useMemo(() => {
    if (!activeWorkspace) return rootPath;
    if (activeContextTarget && !activeContextTarget.connId) {
      return activeContextTarget.rootPath;
    }
    if (rootPath) return rootPath;
    return (
      activeWorkspace.folders.find((folder) => folder.provider === "local")
        ?.path ?? null
    );
  }, [activeContextTarget, activeWorkspace, rootPath]);
  agentWorkspaceRootRef.current = agentWorkspaceRoot;

  const workspaceContextDisplay = useMemo(() => {
    if (!activeWorkspace || !explorerIsWorkspace) return null;
    const activeRoot =
      activeContextTarget ??
      (activeWorkspace.folders[0]
        ? {
            rootPath: activeWorkspace.folders[0].path,
            label: activeWorkspace.folders[0].name,
            workspaceRemote: undefined,
          }
        : null);
    const branches = activeWorkspace.folders.map((folder) => {
      const gitState = workspaceGitStates[folder.id] ?? null;
      const status = gitState?.status ?? null;
      return {
        id: folder.id,
        name: folder.name,
        path: folder.path,
        connId: gitState?.connId,
        branch: status?.isRepo ? status.branch : null,
        isRepo: Boolean(status?.isRepo),
        remote: folder.provider === "ssh",
        changes: status?.isRepo ? status.files.length : 0,
        conflicted: status?.isRepo ? status.conflicted : 0,
        ahead: status?.isRepo ? status.ahead : 0,
        behind: status?.isRepo ? status.behind : 0,
        hasUpstream: status?.isRepo ? status.hasUpstream : false,
      };
    });
    return {
      name: activeWorkspace.name || "Workspace",
      activeRootName: activeRoot?.label ?? null,
      activeRootPath: activeRoot?.rootPath ?? null,
      folderCount: activeWorkspace.folders.length,
      remote: Boolean(activeRoot?.workspaceRemote || activeRoot?.connId),
      branches,
    };
  }, [activeContextTarget, activeWorkspace, explorerIsWorkspace, workspaceGitStates]);

  // Lets Search/Problems jump to a line in the active editor, optionally
  // selecting a range on that line (search results highlight the matched term).
  const revealRef = useRef<
    ((line: number, selection?: MatchSelection) => void) | null
  >(null);
  // A line (+ optional selection) to reveal once a freshly-opened file mounts.
  const pendingReveal = useRef<
    { line: number; selection?: MatchSelection } | null
  >(null);
  // Imperative bridge to the active Monaco editor; consumed by the Edit/Selection
  // menus (ISSUE-52). Null when no file is open.
  const editorActionsRef = useRef<EditorActionsApi | null>(null);

  // Persist layout preferences so the workbench reopens the way it was left.
  useEffect(() => {
    try {
      localStorage.setItem("ui.sidebarWidth", String(sidebarWidth));
    } catch {
      /* storage unavailable — ignore */
    }
  }, [sidebarWidth]);
  useEffect(() => {
    try {
      localStorage.setItem("ui.sidebarSide", sidebarSide);
    } catch {
      /* storage unavailable — ignore */
    }
  }, [sidebarSide]);
  useEffect(() => {
    try {
      localStorage.setItem("ui.activityBarPos", activityBarPos);
    } catch {
      /* storage unavailable — ignore */
    }
  }, [activityBarPos]);
  useEffect(() => {
    try {
      localStorage.setItem("ui.agentsSidebarWidth", String(agentsSidebarWidth));
    } catch {
      /* storage unavailable — ignore */
    }
  }, [agentsSidebarWidth]);
  useEffect(() => {
    try {
      localStorage.setItem("ui.panelHeight", String(panelHeight));
    } catch {
      /* storage unavailable — ignore */
    }
  }, [panelHeight]);
  useEffect(() => {
    try {
      localStorage.setItem("ui.panelPos", panelPos);
      localStorage.setItem("ui.panelWidth", String(panelWidth));
    } catch {
      /* storage unavailable — ignore */
    }
  }, [panelPos, panelWidth]);

  const activeFile = openFiles.find((f) => f.path === activePath) ?? null;

  const errorCount = allProblems.filter((p) => p.severity === "error").length;
  const warningCount = allProblems.filter((p) => p.severity === "warning").length;

  // Languages currently open in tabs — drives which LSP servers the manager
  // brings up. Recomputed only when the set of open paths changes.
  const openedLanguages = useMemo(() => {
    const set = new Set<string>();
    for (const group of Object.values(layout.groups)) {
      for (const file of group.files) {
        set.add(languageForFile(file.name, file.path));
      }
    }
    return set;
    // `languageOverrides` is read indirectly via `languageForFile`; list it so a
    // language-mode change re-derives which servers should be running.
  }, [layout.groups, languageOverrides]);

  // LSP lifecycle: starts/stops servers per workspace + open languages. Its
  // diagnostics surface as Monaco markers, which EditorPane already funnels into
  // `problems` (and thus the Problems panel) — no extra wiring needed here.
  const {
    status: lspStatus,
    errors: lspErrors,
    workspaces: lspWorkspaces,
    restart: restartLsp,
    restartAll: restartAllLsp,
  } = useLspManager(rootPath, openedLanguages);

  const lspServers: LspServerStatus[] = useMemo(
    () =>
      [...lspStatus.entries()].map(([id, status]) => ({
        id,
        status,
        error: lspErrors.get(id),
        workspace: lspWorkspaces.get(id),
      })),
    [lspStatus, lspErrors, lspWorkspaces]
  );

  // Status bar shows only the server for the file you're actually editing — like
  // VSCode, which surfaces the active file's language, not every running server.
  // (Servers for other open files keep running in the background for instant tab
  // switches; they're just hidden until you focus a file they handle.)
  const activeServerId = activeFile
    ? serverIdForLanguage(languageForFile(activeFile.name, activeFile.path))
        ?.serverId
    : undefined;
  const activeLspServers = useMemo(
    () =>
      activeServerId ? lspServers.filter((s) => s.id === activeServerId) : [],
    [lspServers, activeServerId]
  );

  // Command Palette registry (Ctrl+Shift+P, issue #12). Extensible: add a command
  // by pushing another entry. The status bar already reflects the LSP restart
  // (servers flip to "starting" → "ready"), so resetting gives visible feedback.
  const commands = useMemo<Command[]>(
    () => [
      {
        id: "lsp.resetServers",
        title: "Resetar Servidores de Código",
        detail: "LSP",
        run: () => {
          void restartAllLsp();
        },
      },
      {
        id: "csharp.rebuild",
        title: "Recompilar (mostrar erros de C#/Razor)",
        detail: "Build",
        run: () => {
          if (rootPath) void runBuildDiagnostics(rootPath);
        },
      },
      {
        id: "razor.toggleProjection",
        title: isRazorProjectionEnabled()
          ? "Razor: desligar projeção .cshtml (voltar ao cohost)"
          : "Razor: ligar projeção .cshtml (experimental)",
        detail: "Razor",
        run: () => {
          // Flip the ADR-0002 projection flag and reload so `.cshtml` re-opens
          // under the chosen engine. No DevTools needed (release has none).
          if (isRazorProjectionEnabled()) {
            localStorage.removeItem(RAZOR_PROJECTION_FLAG_KEY);
          } else {
            localStorage.setItem(RAZOR_PROJECTION_FLAG_KEY, "1");
          }
          location.reload();
        },
      },
      {
        id: "editor.toggleFormatOnSave",
        title: isFormatOnSaveEnabled()
          ? "Editor: desligar Formatar ao Salvar"
          : "Editor: ligar Formatar ao Salvar (C#)",
        detail: "Editor",
        run: () => {
          // Read live at every save (formatOnSave.ts) — no reload needed.
          toggleFormatOnSave();
        },
      },
    ],
    [restartAllLsp, rootPath]
  );

  /**
   * Clears every workspace-derived bit of UI state so nothing from the previous
   * project leaks into the empty state — or into the next project while its git
   * branch/status and LSP load asynchronously (issue #17). The LSP servers and
   * their workspace info (C# solution/projects) tear down separately when
   * `rootPath` changes (see useLspManager).
   */
  const resetWorkspaceState = useCallback(() => {
    setBranch(null);
    setGitState(null);
    setProblems([]);
    clearAllDiagnostics();
    clearBuildDiagnostics();
  }, []);

  const workspaceForSingleRoot = useCallback((folder: string, remote: RemoteSession | null): ActiveWorkspace => {
    const normalized = normalizeWorkspaceFile({
      fluentWorkspace: 1,
      name: baseName(folder),
      folders: [
        {
          name: baseName(folder),
          path: folder,
          remote: remote
            ? {
                type: "ssh",
                host: remote.host,
                user: remote.user,
                port: remote.input?.port,
                keyPath: remote.input?.keyPath,
              }
            : undefined,
        },
      ],
    });
    return { ...normalized, filePath: null, dirty: false };
  }, []);

  useEffect(() => {
    const sshFolders = activeWorkspace?.folders.filter((folder) => folder.provider === "ssh" && folder.remote) ?? [];
    if (sshFolders.length === 0) {
      for (const conn of Object.values(workspaceSshConnections)) {
        if (conn.connId) void sshDisconnect(conn.connId).catch(() => {});
      }
      if (Object.keys(workspaceSshConnections).length > 0) setWorkspaceSshConnections({});
      return;
    }

    const validIds = new Set(sshFolders.map((folder) => folder.id));
    for (const [id, conn] of Object.entries(workspaceSshConnections)) {
      if (!validIds.has(id) && conn.connId) void sshDisconnect(conn.connId).catch(() => {});
    }
    setWorkspaceSshConnections((current) => {
      let changed = false;
      const next: Record<string, WorkspaceSshConnection> = {};
      for (const folder of sshFolders) {
        if (current[folder.id]) next[folder.id] = current[folder.id];
      }
      for (const id of Object.keys(current)) {
        if (!validIds.has(id)) changed = true;
      }
      if (!changed && Object.keys(next).length === Object.keys(current).length) return current;
      return next;
    });

    for (const folder of sshFolders) {
      const current = workspaceSshConnections[folder.id];
      if (current) continue;
      const remote = folder.remote!;
      if (!remote.keyPath) {
        setWorkspaceSshConnections((connections) => ({
          ...connections,
          [folder.id]: { status: "error", error: "Credenciais necessárias." },
        }));
        if (!sshDialogOpen && !sshPasswordFor && !reconnectWorkspaceRootId) {
          setReconnectWorkspaceRootId(folder.id);
          setSshHostsOpen(false);
          setSshFolderPickMode("addToWorkspace");
          setSshFormInitial({
            host: remote.host,
            port: remote.port ?? 22,
            user: remote.user,
          });
          setSshDialogOpen(true);
        }
        continue;
      }
      setWorkspaceSshConnections((connections) => ({
        ...connections,
        [folder.id]: { status: "connecting" },
      }));
      void sshConnect({
        host: remote.host,
        port: remote.port,
        user: remote.user,
        keyPath: remote.keyPath,
      })
        .then((connId) => {
          setWorkspaceSshConnections((connections) => ({
            ...connections,
            [folder.id]: { status: "connected", connId },
          }));
        })
        .catch((err) => {
          setWorkspaceSshConnections((connections) => ({
            ...connections,
            [folder.id]: { status: "error", error: String(err) },
          }));
        });
    }
  }, [
    activeWorkspace,
    reconnectWorkspaceRootId,
    sshDialogOpen,
    sshPasswordFor,
    workspaceSshConnections,
  ]);

  /**
   * Loads a project folder into the explorer. Shared by the folder picker and
   * the launch-time restore. When `persist` is true (the normal case), the path
   * is recorded so the next launch reopens it. `silent` swallows the error alert
   * (used on restore: a since-deleted folder shouldn't pop a dialog on startup).
   */
  const openFolder = useCallback(
    async (folder: string, opts?: { persist?: boolean; silent?: boolean; preserveWorkspace?: boolean }) => {
      const persist = opts?.persist ?? true;
      // When attached to a remote host, `readDir` routes over SFTP; git, the
      // search index and local-session persistence are local-only (later phases),
      // so they're skipped here. The remote attachment must already be set.
      const remote = isRemoteActive();
      // Anchor prefix-based `files.exclude` globs (e.g. `src/generated`) to the
      // opened folder. Remote listings go over SFTP (never the `read_dir` command),
      // so there's no local root to anchor against.
      setExplorerWorkspaceRoot(remote ? null : folder);
      try {
        const entries = await readDir(folder);
        // Now that the folder is confirmed to open, drop the previous project's
        // branch/git/diagnostics before the new git/LSP load (issue #17) — a
        // failed open must NOT leave the UI half-cleared (CodeRabbit).
        resetWorkspaceState();
        setRoots(entries);
        setRootName(baseName(folder).toUpperCase());
        setRootPath(folder);
        if (!opts?.preserveWorkspace) {
          setActiveWorkspace(workspaceForSingleRoot(folder, getActiveRemote()));
        }
        // git routes to the host over SSH when remote, so branch + decorations
        // work for both local and remote workspaces.
        gitBranch(folder).then(setBranch).catch(() => setBranch(null));
        gitStatus(folder).then(setGitState).catch(() => setGitState(null));
        if (!remote) {
          // Warm the search index so the first Ctrl+Shift+F is instant (remote
          // search uses live `grep`, so it needs no local index).
          buildSearchIndex(folder).catch(() => {});
          if (persist) {
            sessionSetLastFolder(folder).catch(() => {});
            addRecentFolder(folder);
            setRecents(getRecentFolders());
          }
        }
        return true;
      } catch (err) {
        console.error(err);
        if (!opts?.silent) alert(`Não foi possível abrir a pasta:\n${err}`);
        // A folder that no longer opens shouldn't be reopened next launch.
        if (persist) sessionSetLastFolder(null).catch(() => {});
        return false;
      }
    },
    [resetWorkspaceState, workspaceForSingleRoot]
  );

  /**
   * Step 1 of opening a remote workspace (issue #8): connect to the host. On
   * success the connection is held in `remoteBrowser` so the user can navigate
   * the host's filesystem and pick a folder. Throws on auth/connect failure so
   * the dialog can surface the message.
   */
  const connectRemote = useCallback(async (input: SshConnectInput) => {
    const connId = await sshConnect(input);

    if (reconnectWorkspaceRootId) {
      const previousConnId = workspaceSshConnections[reconnectWorkspaceRootId]?.connId;
      if (previousConnId && previousConnId !== connId) {
        void sshDisconnect(previousConnId).catch(() => {});
      }
      setWorkspaceSshConnections((connections) => ({
        ...connections,
        [reconnectWorkspaceRootId]: { status: "connected", connId },
      }));
      if (input.keyPath) {
        setActiveWorkspace((current) => {
          if (!current) return current;
          return {
            ...current,
            folders: current.folders.map((folder) =>
              folder.id === reconnectWorkspaceRootId && folder.remote
                ? {
                    ...folder,
                    remote: {
                      ...folder.remote,
                      port: input.port,
                      keyPath: input.keyPath,
                    },
                  }
                : folder
            ),
            dirty: true,
          };
        });
      }
      setReconnectWorkspaceRootId(null);
      setSshDialogOpen(false);
      setSshHostsOpen(false);
      setSshPasswordFor(null);
      setSshFormInitial(undefined);
      return;
    }

    setRemoteBrowser({
      connId,
      host: input.host,
      user: input.user,
      input,
      mode: sshFolderPickMode,
    });
    setSshDialogOpen(false);
    setSshHostsOpen(false);
    setSshPasswordFor(null);
  }, [reconnectWorkspaceRootId, sshFolderPickMode, workspaceSshConnections]);

  /**
   * Opens the VS Code-style SSH host quick-pick: the saved `~/.ssh/config` hosts
   * plus an "add new host" action. This is the entry point for connecting.
   */
  const openSshFlow = useCallback(async (mode: SshFolderPickMode = "openRemote") => {
    setReconnectWorkspaceRootId(null);
    setSshFolderPickMode(mode);
    setSshPasswordFor(null);
    setSshFormInitial(undefined);
    try {
      const hosts = await sshListSavedHosts();
      const seen = new Set<string>();
      setSshSavedHosts(
        hosts.filter((h) => {
          const k = `${h.label} ${h.host} ${h.user ?? ""} ${h.port ?? ""}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
      );
    } catch {
      setSshSavedHosts([]);
    }
    setSshHostsOpen(true);
  }, []);

  /** Routes a chosen saved host: password prompt, or the full form (key/no user). */
  const pickSavedHost = useCallback((h: SavedHost) => {
    setSshHostsOpen(false);
    if (h.identityFile || !h.user) {
      // Key auth or a host without a user → the form (prefilled) gives full control.
      setSshFormInitial({
        host: h.host,
        port: h.port ?? undefined,
        user: h.user ?? undefined,
        keyPath: h.identityFile ?? undefined,
      });
      setSshDialogOpen(true);
    } else {
      setSshPasswordFor(h);
    }
  }, []);

  type RemoteBrowserCtx = {
    connId: string;
    host: string;
    user: string;
    input: SshConnectInput | null;
    mode: SshFolderPickMode;
  };

  async function addRemoteFolderToWorkspace(browser: RemoteBrowserCtx, remotePath: string) {
    const current = workspaceToSave();
    if (!current) {
      alert("Abra uma pasta ou workspace antes de adicionar uma pasta SSH ao workspace.");
      if (browser.input) void sshDisconnect(browser.connId).catch(() => {});
      setRemoteBrowser(null);
      return;
    }

    try {
      const added = normalizeWorkspaceFile(
        {
          fluentWorkspace: 1,
          name: workspaceNameAfterAddingRoot(current),
          folders: [
            ...current.folders.map((item) => ({
              id: item.id,
              name: item.name,
              path: item.path,
              remote: item.remote,
            })),
            {
              name: baseName(remotePath),
              path: remotePath,
              remote: {
                type: "ssh",
                host: browser.host,
                user: browser.user,
                port: browser.input?.port,
                keyPath: browser.input?.keyPath,
              },
            },
          ],
          settings: current.settings,
        },
        current.filePath
      );
      setActiveWorkspace({
        ...added,
        filePath: current.filePath,
        dirty: true,
      });
      const addedFolder = added.folders.find(
        (folder) =>
          folder.provider === "ssh" &&
          folder.remote?.host === browser.host &&
          folder.remote.user === browser.user &&
          folder.path === remotePath
      );
      if (addedFolder) {
        setWorkspaceSshConnections((connections) => ({
          ...connections,
          [addedFolder.id]: { status: "connected", connId: browser.connId },
        }));
      } else if (browser.input) {
        void sshDisconnect(browser.connId).catch(() => {});
      }
      setRemoteBrowser(null);
    } catch (err) {
      console.error(err);
      alert(`Não foi possível adicionar a pasta SSH ao workspace:\n${err}`);
      if (browser.input) void sshDisconnect(browser.connId).catch(() => {});
    }
  }

  /**
   * Step 2: attach the chosen remote folder and open it. Sets the ambient remote
   * session first so `openFolder`'s `readDir`/git/search route over SSH, then
   * persists the (secret-free) target for next-launch reconnect.
   */
  async function finalizeRemoteFolder(browser: RemoteBrowserCtx, rootPath: string) {
    const { connId, host, user, input } = browser;

    if (browser.mode === "addToWorkspace") {
      await addRemoteFolderToWorkspace(browser, rootPath);
      return;
    }

    // A new SSH connection must not replace an existing workspace. Hand the
    // already-open backend connection to a warm same-process window instead.
    if (shouldOpenRemoteInNewWindow(rootPathRef.current, input !== null)) {
      try {
        await openNewWindow(
          encodeRemoteAttach({ connId, host, user, rootPath })
        );
        setRemoteBrowser(null);

        const last = loadLastRemoteTarget();
        const sameHost = last?.host === host;
        saveLastRemoteTarget({
          host,
          port: input?.port ?? (sameHost ? last?.port ?? 22 : 22),
          user,
          keyPath: input?.keyPath ?? (sameHost ? last?.keyPath : undefined),
          remotePath: rootPath,
        });
      } catch (err) {
        console.error("Falha ao abrir a conexão em uma nova janela:", err);
        alert(`Não foi possível abrir a conexão em uma nova janela:\n${err}`);
      }
      return;
    }

    if (!(await guardDirtySession())) return;

    const previousRemote = getActiveRemote();
    const session: RemoteSession = {
      connId,
      host,
      user,
      rootPath,
      input: input ?? previousRemote?.input,
    };
    setActiveRemote(session);
    const opened = await openFolder(rootPath, { persist: false });
    if (!opened) {
      setActiveRemote(previousRemote);
      if (connId !== previousRemote?.connId) {
        void sshDisconnect(connId).catch(() => {});
      }
      return;
    }

    resetEditorLayout();
    if (previousRemote && previousRemote.connId !== connId) {
      clearRemoteTerminals();
      clearRemoteLspServers();
      void sshDisconnect(previousRemote.connId).catch(() => {});
    }
    setRemoteSession(session);
    setRemoteBrowser(null);

    // Persist only after the folder is known to be accessible.
    const last = loadLastRemoteTarget();
    const sameHost = last?.host === host;
    saveLastRemoteTarget({
      host,
      port: input?.port ?? (sameHost ? last?.port ?? 22 : 22),
      user,
      keyPath: input?.keyPath ?? (sameHost ? last?.keyPath : undefined),
      remotePath: rootPath,
    });
  }

  /**
   * Cancels the folder browser. For a brand-new connection this closes it; for a
   * reused session (opening another folder) the connection is kept.
   */
  const cancelRemoteBrowser = useCallback(() => {
    if (remoteBrowser?.input) void sshDisconnect(remoteBrowser.connId).catch(() => {});
    setRemoteBrowser(null);
  }, [remoteBrowser]);

  /**
   * Re-establishes a dropped connection using the in-memory credentials and
   * reopens the same folder. Falls back to the connect dialog when there are no
   * stored credentials (e.g. a session restored without them).
   */
  const reconnectRemote = useCallback(async () => {
    const session = getActiveRemote();
    if (!session?.input) {
      setSshDialogOpen(true);
      return;
    }
    void sshDisconnect(session.connId).catch(() => {});
    clearRemoteTerminals();
    clearRemoteLspServers();
    try {
      const connId = await sshConnect(session.input);
      const next: RemoteSession = { ...session, connId };
      setActiveRemote(next);
      setRemoteSession(next);
      await openFolder(session.rootPath, { persist: false });
    } catch (err) {
      setActiveRemote(null);
      setRemoteSession(null);
      alert(`Não foi possível reconectar:\n${err}`);
    }
  }, [openFolder]);

  const refreshExplorerRoot = useCallback(async () => {
    if (!rootPath) return;
    const entries = await readDir(rootPath);
    setRoots(entries);
    // git routes over SSH when remote, so decorations refresh either way.
    gitStatus(rootPath).then(setGitState).catch(() => setGitState(null));
    void refreshWorkspaceGitStatuses();
  }, [refreshWorkspaceGitStatuses, rootPath]);

  /**
   * Re-syncs everything that a branch switch changes (issue #16): the status-bar
   * branch, the git decorations, and the explorer tree (files differ between
   * branches). Shared by checkout and create-branch.
   */
  const refreshAfterCheckout = useCallback(async (target: WorkspaceGitTarget | null) => {
    if (!target) return;
    gitBranch(target.rootPath, target.connId)
      .then((nextBranch) => {
        if (
          activeGitTarget &&
          activeGitTarget.rootPath === target.rootPath &&
          activeGitTarget.connId === target.connId
        ) {
          setBranch(nextBranch);
        }
      })
      .catch(() => {
        if (
          activeGitTarget &&
          activeGitTarget.rootPath === target.rootPath &&
          activeGitTarget.connId === target.connId
        ) {
          setBranch(null);
        }
      });
    await refreshExplorerRoot();
    void refreshWorkspaceGitStatuses();
  }, [activeGitTarget, refreshExplorerRoot, refreshWorkspaceGitStatuses]);

  /** Checks out an existing branch, then re-syncs branch/status/tree. */
  const handleCheckoutBranch = useCallback(
    async (branchName: string) => {
      if (!branchPickerGitTarget) return;
      try {
        await gitCheckout(branchPickerGitTarget.rootPath, branchName, branchPickerGitTarget.connId);
        await refreshAfterCheckout(branchPickerGitTarget);
      } catch (err) {
        console.error(err);
        alert(`Não foi possível trocar de branch:\n${err}`);
      }
    },
    [branchPickerGitTarget, refreshAfterCheckout]
  );

  /** Prompts for a name, creates a branch from HEAD, then re-syncs. */
  const handleCreateBranch = useCallback(async () => {
    if (!branchPickerGitTarget) return;
    const name = window.prompt("Nome da nova branch:")?.trim();
    if (!name) return;
    try {
      await gitCreateBranch(branchPickerGitTarget.rootPath, name, branchPickerGitTarget.connId);
      await refreshAfterCheckout(branchPickerGitTarget);
    } catch (err) {
      console.error(err);
      alert(`Não foi possível criar a branch:\n${err}`);
    }
  }, [branchPickerGitTarget, refreshAfterCheckout]);

  async function openLocalFolderInPlace(folder: string) {
    if (!(await guardDirtySession())) return;
    const previousRemote = getActiveRemote();
    if (previousRemote) setActiveRemote(null);
    const opened = await openFolder(folder);
    if (!opened) {
      setActiveRemote(previousRemote);
      return;
    }
    resetEditorLayout();
    if (previousRemote) {
      setRemoteSession(null);
      clearRemoteTerminals();
      clearRemoteLspServers();
      void sshDisconnect(previousRemote.connId).catch(() => {});
    }
  }

  /** Native folder picker → reuse this window for the selected project. */
  async function handleOpenFolder() {
    const folder = await pickFolder();
    if (!folder) return;
    await openLocalFolderInPlace(folder);
  }

  /** Opens a folder chosen from the welcome screen's "Recentes" list. */
  async function handleOpenRecent(folder: string) {
    await openLocalFolderInPlace(folder);
  }

  /** Opens a new empty workbench in the already-warm app process. */
  const handleNewWindow = useCallback(() => {
    openNewWindow().catch((err) => {
      console.error(err);
      alert(`Não foi possível abrir uma nova janela:\n${err}`);
    });
  }, []);

  const handleOpenLocalFolderInNewWindow = useCallback((folder: string) => {
    openNewWindow(undefined, encodeLocalAttach({ rootPath: folder })).catch((err) => {
      console.error(err);
      alert(`Não foi possível abrir a pasta em uma nova janela:\n${err}`);
    });
  }, []);

  // Activity-bar drag-to-reposition. You must PRESS-AND-HOLD for DRAG_HOLD_MS
  // (1.5s) to pick it up: while holding, the cursor turns to grabbing and a ring
  // "charges up" (the arming state). Once armed, moving previews the new placement
  // live; releasing keeps it, dropping outside any zone snaps it back. A normal
  // click (release before the hold completes) still switches the view, and moving
  // far before the hold completes aborts it (it wasn't a deliberate hold).
  const [draggingActivity, setDraggingActivity] = useState(false);
  const [armingActivity, setArmingActivity] = useState(false);

  const startActivityDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return; // primary button (right-click = context menu)
      const startX = e.clientX;
      const startY = e.clientY;
      const origPos = activityBarPos;
      const origSide = sidebarSide;
      let armed = false;

      setArmingActivity(true);
      const arm = () => {
        armed = true;
        setArmingActivity(false);
        setDraggingActivity(true);
      };
      const holdTimer = window.setTimeout(arm, DRAG_HOLD_MS);
      const cancelHold = () => {
        window.clearTimeout(holdTimer);
        setArmingActivity(false);
      };

      const preview = (x: number, y: number) => {
        const dockRect = document.querySelector<HTMLElement>(".primary-dock")?.getBoundingClientRect();
        const zone = activityZoneAtPoint(x, y, dockRect);
        if (zone === "window-left") {
          setActivityBarPos("side");
          setSidebarSide("left");
        } else if (zone === "window-right") {
          setActivityBarPos("side");
          setSidebarSide("right");
        } else if (zone === "left") {
          setActivityBarPos("side");
        } else if (zone === "right") {
          setActivityBarPos("right");
        } else if (zone === "top") {
          setActivityBarPos("top");
        } else if (zone === "bottom") {
          setActivityBarPos("bottom");
        } else {
          setActivityBarPos(origPos);
          setSidebarSide(origSide);
        }
      };
      const onMove = (me: PointerEvent) => {
        if (!armed) {
          // Drifting too far before the hold finishes aborts it (not a hold).
          if (Math.hypot(me.clientX - startX, me.clientY - startY) > 24) cancelHold();
          return;
        }
        preview(me.clientX, me.clientY);
      };
      const onUp = () => {
        cancelHold();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (armed) {
          setDraggingActivity(false);
          const swallow = (ce: MouseEvent) => {
            ce.stopPropagation();
            ce.preventDefault();
          };
          window.addEventListener("click", swallow, { capture: true, once: true });
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [activityBarPos, sidebarSide]
  );

  // Counter for unique "Untitled-N" names within this window.
  const untitledCounter = useRef(0);

  /**
   * Opens a new empty in-memory buffer (File ▸ New File / New Text File). It has
   * no path on disk until the user saves it (Ctrl+S routes to Save As). Starts
   * clean so closing an untouched empty buffer doesn't prompt.
   */
  const handleNewTextFile = useCallback(() => {
    untitledCounter.current += 1;
    const name = `Untitled-${untitledCounter.current}`;
    const path = `${UNTITLED_PREFIX}${name}`;
    setOpenFiles((prev) => [
      ...prev,
      { path, name, content: "", dirty: false, mode: "text" },
    ]);
    setActivePath(path);
  }, []);

  // On launch, reopen the last project folder and the tabs that were open in it
  // (issue #7) — unless this is a fresh window (URL marker or legacy `--new`),
  // which starts empty. Restore is silent so a moved/deleted folder/file doesn't
  // greet the user with an error dialog. The `restoringSessionRef` guard keeps
  // the session-save effect from overwriting the good session with the partial
  // state produced while tabs are reopening.
  useEffect(() => {
    if (bootRestoredRef.current) return;
    bootRestoredRef.current = true;
    restoringSessionRef.current = true;
    (async () => {
      // Multi-window (issue #8): a window opened as a remote attach restores the
      // remote session (the connection is already open) instead of a local folder.
      const attach = readRemoteAttach();
      if (attach) {
        clearRemoteAttachParam();
        const session: RemoteSession = {
          connId: attach.connId,
          host: attach.host,
          user: attach.user,
          rootPath: attach.rootPath,
        };
        setActiveRemote(session);
        setRemoteSession(session);
        try {
          const opened = await openFolder(attach.rootPath, { persist: false });
          if (!opened) throw new Error("A pasta remota não pôde ser aberta.");
        } catch (err) {
          console.error("Falha ao anexar a janela remota:", err);
          setActiveRemote(null);
          setRemoteSession(null);
          void sshDisconnect(attach.connId).catch(() => {});
        }
        restoringSessionRef.current = false;
        return;
      }

      const localAttach = readLocalAttach();
      if (localAttach) {
        clearLocalAttachParam();
        try {
          const opened = await openFolder(localAttach.rootPath, { persist: false });
          if (!opened) throw new Error("A pasta local não pôde ser aberta.");
        } catch (err) {
          console.error("Falha ao anexar a janela local:", err);
        }
        restoringSessionRef.current = false;
        return;
      }

      // A fresh window (Arquivo ▸ Nova Janela) starts empty — nothing to restore.
      let fresh = new URLSearchParams(window.location.search).has("freshWindow");
      try {
        if (!fresh) fresh = await isFreshWindow();
      } catch (err) {
        console.error("Falha ao verificar se a janela é nova:", err);
      }
      if (fresh) {
        restoringSessionRef.current = false;
        return;
      }

      try {
        const launchWorkspaces = await openedWorkspaceFiles();
        if (launchWorkspaces.length > 0) {
          restoringSessionRef.current = false;
          return;
        }
      } catch (err) {
        console.error("Falha ao verificar workspaces de inicialização:", err);
      }

      let s: Awaited<ReturnType<typeof sessionLoad>>;
      try {
        s = await sessionLoad();
      } catch (err) {
        console.error("Falha ao restaurar sessão:", err);
        restoringSessionRef.current = false;
        return;
      }

      if (s.workspace?.data) {
        try {
          const normalized = normalizeWorkspaceFile(
            s.workspace.data,
            s.workspace.filePath
          );
          setActiveWorkspace({
            ...normalized,
            filePath: s.workspace.filePath ?? null,
            dirty: Boolean(!s.workspace.filePath),
          });
          setRootName(normalized.name.toUpperCase());
          const firstLocal = normalized.folders.find((folder) => folder.provider === "local");
          if (firstLocal) {
            await openFolder(firstLocal.path, {
              silent: true,
              persist: false,
              preserveWorkspace: true,
            });
          } else {
            setRootPath(null);
            setRoots([]);
            setExplorerWorkspaceRoot(null);
          }
        } catch (err) {
          console.error("Falha ao restaurar workspace da sessão:", err);
          sessionSetWorkspace(null).catch(() => {});
        }
      } else if (s.lastFolder) {
        // Open the folder first so the explorer/rootPath are ready before tabs
        // reopen (handleOpenFile resolves paths against the loaded project).
        await openFolder(s.lastFolder, { silent: true });
      }

      // Restore the FULL split grid when the session saved one (>1 group);
      // otherwise fall through to the simpler flat single-group reopen.
      if (s.layout) {
        try {
          const sl = JSON.parse(s.layout) as SerializedLayout;
          if (sl.groups && sl.groups.length > 1) {
            const groups: Record<string, EditorGroup> = {};
            for (const sg of sl.groups) {
              const files: OpenFile[] = [];
              for (const t of sg.tabs) {
                const mode: OpenMode = (t.mode ?? defaultModeFor(t.path)) as OpenMode;
                let content = "";
                let encoding: string | undefined;
                let bom: boolean | undefined;
                let eol: OpenFile["eol"];
                if (mode === "text") {
                  try {
                    const decoded = await readFile(t.path);
                    content = decoded.content;
                    encoding = decoded.encoding;
                    bom = decoded.bom;
                    eol = decoded.eol;
                  } catch {
                    continue; // file gone — skip this tab
                  }
                }
                files.push({
                  path: t.path,
                  name: baseName(t.path),
                  content,
                  dirty: false,
                  mode,
                  encoding,
                  bom,
                  eol,
                });
              }
              const activePath =
                sg.activePath && files.some((f) => f.path === sg.activePath)
                  ? sg.activePath
                  : files[files.length - 1]?.path ?? null;
              groups[sg.id] = { id: sg.id, files, activePath };
            }
            const built = buildLayout(sl.root, sl.activeGroup, groups);
            if (built) {
              // built already carries each group's tabs + activePath + the
              // active group, so one setLayout restores the whole grid.
              setLayout(built);
              groupSeq.current = maxGroupSeq(Object.keys(built.groups)) + 1;
              restoringSessionRef.current = false;
              return;
            }
          }
        } catch {
          // Corrupt/old layout blob — fall back to the flat reopen below.
        }
      }

      // Reopen tabs in their saved order, skipping any file that no longer
      // exists (handleOpenFile returns false silently). Re-read content from
      // disk — only the path + view mode were persisted. Drop duplicate paths
      // here too (a stale session may hold the same file twice, e.g. saved with
      // different drive-letter casing) so the restore never re-creates them and
      // the healed session below is deduplicated (issue #7).
      const restored: OpenTab[] = [];
      for (const tab of s.openTabs) {
        if (restored.some((t) => samePath(t.path, tab.path))) continue;
        const node: FileNode = {
          name: baseName(tab.path),
          path: tab.path,
          isDir: false,
        };
        const ok = await handleOpenFileRef.current(
          node,
          undefined,
          tab.mode,
          undefined,
          { silent: true }
        );
        if (ok) restored.push(tab);
      }

      // Focus the tab that was active, if it survived the restore. Match the
      // active path against the restored tab (case-insensitively on Windows) so
      // we focus the path actually stored, not a differently-cased saved one.
      const activeTab =
        s.activePath != null
          ? restored.find((t) => samePath(t.path, s.activePath!))
          : undefined;
      const activeRestored =
        activeTab?.path ??
        (restored.length > 0 ? restored[restored.length - 1].path : null);
      if (activeRestored) setActivePath(activeRestored);

      restoringSessionRef.current = false;

      // If any saved file was skipped (deleted/moved), the on-disk session is now
      // stale — rewrite it with exactly what was restored so those dead entries
      // are dropped. No-op when nothing was skipped.
      if (restored.length !== s.openTabs.length) {
        sessionSetOpenFiles(restored, activeRestored).catch((err) =>
          console.error("Falha ao limpar abas inexistentes da sessão:", err)
        );
      }
    })();
    // openFolder is stable (useCallback []); handleOpenFile is read via ref, so
    // this effect runs exactly once.
  }, [openFolder]);

  // Agent definitions and histories are isolated per active local workspace root.
  useEffect(() => {
    let cancelled = false;
    setAgentSelection(null);
    setAgentError(null);
    setAgentStatus(null);
    // An in-flight send from the previous workspace will see isStaleWorkspace()
    // and bail; clear its busy flag here so the new workspace starts unblocked.
    setAgentBusy(false);

    if (!agentWorkspaceRoot) {
      setAgentStore({ ...EMPTY_AGENT_STORE });
      return () => {
        cancelled = true;
      };
    }

    agentsLoad(agentWorkspaceRoot)
      .then((store) => {
        if (!cancelled) setAgentStore(normalizeAgentStore(store));
      })
      .catch((error) => {
        if (!cancelled) {
          setAgentStore({ ...EMPTY_AGENT_STORE });
          setAgentError({ conversationId: null, message: String(error) });
        }
      });

    return () => {
      cancelled = true;
      void acpStopWorkspace(agentWorkspaceRoot).catch(() => {});
    };
  }, [agentWorkspaceRoot]);

  const persistAgentStore = useCallback(
    async (next: AgentStore) => {
      setAgentStore(next);
      if (!agentWorkspaceRoot) return;
      try {
        await agentsSave(agentWorkspaceRoot, next);
        // Limpa apenas erros globais de persistência — não engole o erro de
        // turno de uma conversa por causa de um save de outra origem.
        setAgentError((prev) => (prev?.conversationId === null ? null : prev));
      } catch (error) {
        setAgentError({ conversationId: null, message: String(error) });
      }
    },
    [agentWorkspaceRoot],
  );

  function createAgentConversation(agentId: string): AgentConversation {
    const now = new Date().toISOString();
    return {
      id: createLocalId("conversation"),
      agentId,
      title: "Nova conversa",
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  const handleGitAssist = useCallback(
    async (request: GitAssistRequest): Promise<string | null> => {
      if (
        request.provider === "ssh" ||
        agentBusy ||
        !agentWorkspaceRoot ||
        !samePath(request.rootPath, agentWorkspaceRoot) ||
        getActiveRemote()
      ) {
        return null;
      }

      const agent = agentStore.agents[0];
      if (!agent) return null;

      const sendRoot = agentWorkspaceRoot;
      const prompt = buildGitAssistPrompt(request);
      let text = "";
      let eventError: string | null = null;

      await acpPrompt(
        agent.provider,
        sendRoot,
        createLocalId("git-assist"),
        buildAgentPrompt(agent, [], prompt),
        prompt,
        "ask",
        acpResolveModel(agent.provider, agent.model),
        null,
        (event) => {
          if (agentWorkspaceRootRef.current !== sendRoot) return;
          if (event.type === "text") text += event.content;
          if (event.type === "error") eventError = event.message;
        },
      );

      if (eventError) throw new Error(eventError);
      return text.trim() || null;
    },
    [agentBusy, agentStore.agents, agentWorkspaceRoot],
  );

  function handleCreateAgent() {
    if (!agentWorkspaceRoot) return;
    setAgentsSidebarOpen(true);
    setAgentSelection({ kind: "config", agentId: null });
    setAgentError(null);
  }

  function handleEditAgent(agentId: string) {
    setAgentsSidebarOpen(true);
    setAgentSelection({ kind: "config", agentId });
    setAgentError(null);
  }

  function handleSaveAgent(draft: AgentDraft) {
    if (!agentWorkspaceRoot) return;
    const now = new Date().toISOString();
    const existing = draft.id
      ? agentStore.agents.find((agent) => agent.id === draft.id)
      : undefined;
    const agentId = existing?.id ?? createLocalId("agent");
    const definition = {
      id: agentId,
      name: draft.name,
      color: draft.color,
      initialPrompt: draft.initialPrompt,
      provider: draft.provider,
      model: acpResolveModel(draft.provider, draft.model),
      workspacePath: agentWorkspaceRoot,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const agents = existing
      ? agentStore.agents.map((agent) =>
          agent.id === agentId ? definition : agent,
        )
      : [...agentStore.agents, definition];
    const latest = [...agentStore.conversations]
      .filter((conversation) => conversation.agentId === agentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const conversation = latest ?? createAgentConversation(agentId);
    const conversations = latest
      ? agentStore.conversations
      : [...agentStore.conversations, conversation];
    const next = { ...agentStore, agents, conversations };
    void persistAgentStore(next);
    setAgentSelection({
      kind: "chat",
      agentId,
      conversationId: conversation.id,
    });
  }

  /** Persiste o modelo escolhido no composer para o agente (fica lembrado). */
  function handleAgentModelChange(agentId: string, model: string) {
    const now = new Date().toISOString();
    const agents = agentStore.agents.map((agent) =>
      agent.id === agentId ? { ...agent, model, updatedAt: now } : agent,
    );
    void persistAgentStore({ ...agentStore, agents });
  }

  // Pré-aquece o provedor assim que um chat é selecionado: o boot do processo
  // (e o initialize do app-server, no Codex) sai do caminho do primeiro envio.
  // Idempotente no backend — reabrir o mesmo chat reutiliza o worker vivo.
  useEffect(() => {
    if (!agentWorkspaceRoot || agentSelection?.kind !== "chat") return;
    const agent = agentStore.agents.find(
      (candidate) => candidate.id === agentSelection.agentId,
    );
    if (agent) void acpWarm(agent.provider, agentWorkspaceRoot).catch(() => {});
  }, [agentWorkspaceRoot, agentSelection, agentStore.agents]);

  /**
   * Abre um arquivo citado pelo agente no chat. Agentes às vezes citam só o
   * nome (`Controller.cs`) ou um caminho relativo inexato; quando o caminho
   * resolvido não existe no workspace, procura pelo melhor candidato no mesmo
   * índice do Quick Open (sufixo do caminho > nome do arquivo; empate = o
   * menos aninhado) em vez de falhar com "arquivo não encontrado".
   */
  async function handleOpenAgentFile(path: string, line?: number) {
    type AgentFileCandidate = Awaited<ReturnType<typeof listProjectFiles>>[number] & {
      workspaceRemote?: OpenFile["workspaceRemote"];
    };

    const open = (target: string, workspaceRemote?: OpenFile["workspaceRemote"]) =>
      handleOpenFile(
        {
          name: baseName(target),
          path: target,
          isDir: false,
          workspaceRemote: workspaceRemote ?? workspaceRemoteForPath(target),
        },
        line,
      );
    if (!rootPath && !activeWorkspace) {
      open(path);
      return;
    }
    let files: AgentFileCandidate[];
    try {
      if (activeWorkspace) {
        const batches = await Promise.all(
          activeWorkspace.folders.map(async (folder) => {
            if (folder.provider === "ssh") {
              const conn = workspaceSshConnections[folder.id];
              if (conn?.status !== "connected" || !conn.connId) return [];
              const workspaceRemote =
                folder.remote
                  ? {
                      folderId: folder.id,
                      connId: conn.connId,
                      host: folder.remote.host,
                      user: folder.remote.user,
                      rootPath: folder.path,
                    }
                  : undefined;
              const list = await listProjectFiles(folder.path, conn.connId);
              return list.map((file) => ({ ...file, workspaceRemote }));
            }
            return listProjectFiles(folder.path);
          })
        );
        files = batches.flat();
      } else {
        files = await listProjectFiles(rootPath!, remoteSession?.connId);
      }
    } catch {
      open(path);
      return;
    }
    const norm = (value: string) => value.replace(/\\/g, "/").toLowerCase();
    const wanted = norm(path);
    // O caminho citado existe de fato — abre direto.
    const exact = files.find((file) => norm(file.path) === wanted);
    if (exact) {
      open(path, exact.workspaceRemote);
      return;
    }
    // Melhor candidato: caminho relativo citado como sufixo real; senão, só o
    // nome do arquivo. Empates ficam com o caminho menos aninhado.
    const root = rootPath ? norm(rootPath).replace(/\/+$/, "") : "";
    const rel = wanted.startsWith(`${root}/`)
      ? wanted.slice(root.length + 1)
      : wanted;
    const name = rel.split("/").pop() ?? rel;
    const byDepth = (a: { rel: string }, b: { rel: string }) =>
      a.rel.length - b.rel.length;
    const match =
      files
        .filter((file) => norm(file.rel) === rel || norm(file.rel).endsWith(`/${rel}`))
        .sort(byDepth)[0] ??
      files.filter((file) => norm(file.name) === name).sort(byDepth)[0];
    // Sem candidato, abre o caminho original — o diálogo de erro padrão avisa.
    open(match?.path ?? path, match?.workspaceRemote);
  }

  /**
   * Lê o arquivo ativo e a seleção atual do editor, para anexar ao envio do
   * chat (como o Claude Code faz). `null` quando não há arquivo aberto.
   */
  function readEditorContext(): AgentEditorContext | null {
    if (!activePath || isGraphTab(activePath)) return null;
    const selection = editorActionsRef.current?.getSelection() ?? null;
    return {
      path: activePath,
      name: baseName(activePath),
      ...(selection
        ? {
            selectionText: selection.text,
            startLine: selection.startLine,
            endLine: selection.endLine,
          }
        : {}),
    };
  }

  function handleSelectAgent(agentId: string) {
    const latest = [...agentStore.conversations]
      .filter((conversation) => conversation.agentId === agentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (latest) {
      setAgentSelection({
        kind: "chat",
        agentId,
        conversationId: latest.id,
      });
      return;
    }
    handleNewAgentConversation(agentId);
  }

  function handleNewAgentConversation(agentId: string) {
    const conversation = createAgentConversation(agentId);
    const next = {
      ...agentStore,
      conversations: [...agentStore.conversations, conversation],
    };
    void persistAgentStore(next);
    setAgentSelection({
      kind: "chat",
      agentId,
      conversationId: conversation.id,
    });
  }

  function handleDeleteAgent(agentId: string) {
    void persistAgentStore({
      ...agentStore,
      agents: agentStore.agents.filter((agent) => agent.id !== agentId),
      conversations: agentStore.conversations.filter(
        (conversation) => conversation.agentId !== agentId,
      ),
    });
    if (agentSelection?.agentId === agentId) setAgentSelection(null);
  }

  function handleOpenAgentConversation(conversation: AgentConversation) {
    setAgentSelection({
      kind: "chat",
      agentId: conversation.agentId,
      conversationId: conversation.id,
    });
  }

  function handleRenameConversation(conversationId: string, title: string) {
    const now = new Date().toISOString();
    void persistAgentStore({
      ...agentStore,
      conversations: agentStore.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, title, updatedAt: now }
          : conversation,
      ),
    });
  }

  function handleDeleteConversation(conversationId: string) {
    const removed = agentStore.conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (!removed) return;
    void persistAgentStore({
      ...agentStore,
      conversations: agentStore.conversations.filter(
        (conversation) => conversation.id !== conversationId,
      ),
    });
    // If the open conversation was deleted, fall back to the agent's next most
    // recent conversation; if none remain, drop back to the agent's empty state.
    if (
      agentSelection?.kind === "chat" &&
      agentSelection.conversationId === conversationId
    ) {
      const next = agentStore.conversations
        .filter(
          (conversation) =>
            conversation.agentId === removed.agentId &&
            conversation.id !== conversationId,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      setAgentSelection(
        next
          ? { kind: "chat", agentId: removed.agentId, conversationId: next.id }
          : null,
      );
    }
  }

  async function handleSendAgentMessage(
    message: string,
    mode: AgentMode,
    editorContext: AgentEditorContext | null,
  ) {
    if (!agentWorkspaceRoot || agentSelection?.kind !== "chat" || agentBusy) return;
    const agent = agentStore.agents.find(
      (candidate) => candidate.id === agentSelection.agentId,
    );
    const conversation = agentStore.conversations.find(
      (candidate) => candidate.id === agentSelection.conversationId,
    );
    if (!agent || !conversation) return;

    // Pin the workspace this send belongs to. If the user switches folders mid
    // stream, the per-workspace effect resets agentStore to the new workspace;
    // in-flight events that still reference this root must be dropped so they
    // can't inject a stale conversation into — or persist over — another store.
    const sendRoot = agentWorkspaceRoot;
    const isStaleWorkspace = () => agentWorkspaceRootRef.current !== sendRoot;

    // Status/erro deste envio pertencem a ESTA conversa: a UI só os exibe
    // quando ela está selecionada, então trocar de chat não vaza avisos.
    const sendConversationId = conversation.id;
    const setSendStatus = (message: string | null) =>
      setAgentStatus(
        message === null
          ? null
          : { conversationId: sendConversationId, message },
      );
    const setSendError = (message: string) =>
      setAgentError({ conversationId: sendConversationId, message });

    // In write-capable modes, snapshot the working tree first so this request is
    // individually revertible (no-op/null when the folder isn't a git repo).
    setAgentBusy(true);
    streamingConversationIdRef.current = sendConversationId;
    // Limpa apenas avisos desta conversa (ou globais) — erros de outras
    // conversas continuam guardados para quando o usuário voltar a elas.
    setAgentError((prev) =>
      prev &&
      prev.conversationId !== null &&
      prev.conversationId !== sendConversationId
        ? prev
        : null,
    );
    // Modos somente leitura (ask/plan) não alteram arquivos — sem snapshot.
    const readOnlyMode = READ_ONLY_MODES.has(mode);
    setSendStatus(
      readOnlyMode
        ? "Preparando a conversa…"
        : "Criando ponto de restauração…",
    );
    let revert: AgentMessage["revert"] | null;
    try {
      revert = readOnlyMode ? null : await gitSnapshotCreate(sendRoot);
    } catch (error) {
      setSendError(String(error));
      setSendStatus(null);
      setAgentBusy(false);
      streamingConversationIdRef.current = null;
      return;
    }

    const now = new Date().toISOString();
    const userMessage: AgentMessage = {
      id: createLocalId("message"),
      role: "user",
      content: message,
      createdAt: now,
      status: "done",
      mode,
      ...(revert ? { revert } : {}),
    };
    const assistantMessage: AgentMessage = {
      id: createLocalId("message"),
      role: "assistant",
      content: "",
      createdAt: now,
      status: "streaming",
    };
    // Referência do editor (arquivo/seleção) anexada ao prompt enviado ao
    // provedor — não à `content` exibida, que continua sendo só o que o usuário
    // digitou. Vai tanto no envio incremental (sessão retomada) quanto no
    // contexto completo (sessão nova).
    const reference = formatEditorContextReference(sendRoot, editorContext);
    const promptWithContext = reference
      ? `${reference}\n\nMENSAGEM DO USUÁRIO\n${message}`
      : message;
    const contextPrompt = buildAgentPrompt(
      agent,
      conversation.messages,
      promptWithContext,
    );

    // Apply an update by reconciling over the *current* store (functional
    // update), never a captured snapshot — so concurrent edits (rename/delete/
    // save in the sidebar) survive instead of being clobbered by streaming. The
    // reconciled result is captured so we can persist exactly what the UI shows.
    const applyToConversation = (
      update: (conversation: AgentConversation) => AgentConversation,
    ): AgentStore | null => {
      let reconciled: AgentStore | null = null;
      setAgentStore((prev) => {
        // The conversation may have been deleted while the stream was running.
        if (!prev.conversations.some((c) => c.id === conversation.id)) {
          return prev;
        }
        reconciled = replaceConversation(prev, conversation.id, update);
        return reconciled;
      });
      return reconciled;
    };

    // Serialize saves so the initial optimistic state can be persisted in the
    // background without delaying provider startup or racing the final save.
    let saveQueue = Promise.resolve();
    const persistForSend = (store: AgentStore | null): Promise<void> => {
      if (!store || isStaleWorkspace()) return saveQueue;
      saveQueue = saveQueue
        .then(() =>
          agentsSave(sendRoot, store).then(() =>
            setAgentError((prev) =>
              prev &&
              prev.conversationId !== null &&
              prev.conversationId !== sendConversationId
                ? prev
                : null,
            ),
          ),
        )
        .catch((error) => {
          setSendError(String(error));
        });
      return saveQueue;
    };

    setSendStatus("Conectando ao agente…");
    void persistForSend(
      applyToConversation((current) => ({
        ...current,
        title:
          current.messages.length === 0
            ? message.slice(0, 52) || "Nova conversa"
            : current.title,
        messages: [...current.messages, userMessage, assistantMessage],
        updatedAt: now,
      })),
    );

    // Codex can emit deltas menores que uma palavra. Coalescing them into one
    // React update per frame avoids re-rendering the full Markdown on every
    // token while preserving visibly smooth streaming.
    let pendingAssistantText = "";
    let textFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushAssistantText = () => {
      if (textFlushTimer !== null) {
        clearTimeout(textFlushTimer);
        textFlushTimer = null;
      }
      if (!pendingAssistantText || isStaleWorkspace()) return;
      const content = pendingAssistantText;
      pendingAssistantText = "";
      applyToConversation((current) => ({
        ...current,
        messages: current.messages.map((candidate) =>
          candidate.id === assistantMessage.id
            ? {
                ...candidate,
                content: candidate.content + content,
                status: "streaming",
              }
            : candidate,
        ),
        updatedAt: new Date().toISOString(),
      }));
    };
    const appendAssistantText = (content: string) => {
      pendingAssistantText += content;
      if (textFlushTimer === null) {
        textFlushTimer = setTimeout(flushAssistantText, 24);
      }
    };

    // O raciocínio chega no mesmo ritmo de tokens do texto; o mesmo coalescing
    // por frame evita um re-render por delta. O estado é efêmero (fora do
    // store) — some quando a resposta começa e nunca é persistido.
    let pendingThoughtText = "";
    let thoughtFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushThought = () => {
      if (thoughtFlushTimer !== null) {
        clearTimeout(thoughtFlushTimer);
        thoughtFlushTimer = null;
      }
      if (!pendingThoughtText || isStaleWorkspace()) return;
      const chunk = pendingThoughtText;
      pendingThoughtText = "";
      setAgentThought((prev) => ({
        conversationId: sendConversationId,
        text:
          prev && prev.conversationId === sendConversationId
            ? prev.text + chunk
            : chunk,
      }));
    };
    const appendThought = (content: string) => {
      pendingThoughtText += content;
      if (thoughtFlushTimer === null) {
        thoughtFlushTimer = setTimeout(flushThought, 24);
      }
    };
    const clearThought = () => {
      pendingThoughtText = "";
      if (thoughtFlushTimer !== null) {
        clearTimeout(thoughtFlushTimer);
        thoughtFlushTimer = null;
      }
      setAgentThought((prev) =>
        prev && prev.conversationId === sendConversationId ? null : prev,
      );
    };

    // Finalization is event-driven so Stop immediately preserves the partial
    // response. Text deltas remain batched in memory and are flushed once here,
    // avoiding one disk write and Markdown render per token.
    let finalizePromise: Promise<void> | null = null;
    let wasCancelled = false;
    const finalizeAssistant = (
      status: "done" | "error",
      fallback: string,
    ): Promise<void> => {
      if (isStaleWorkspace()) return Promise.resolve();
      if (finalizePromise) return finalizePromise;
      flushAssistantText();
      finalizePromise = persistForSend(
        applyToConversation((current) => ({
          ...current,
          messages: current.messages.map((candidate) =>
            candidate.id === assistantMessage.id
              ? {
                  ...candidate,
                  content: candidate.content || fallback,
                  status,
                }
              : candidate,
          ),
          updatedAt: new Date().toISOString(),
        })),
      );
      return finalizePromise;
    };

    try {
      await acpPrompt(
        agent.provider,
        sendRoot,
        conversation.id,
        contextPrompt,
        promptWithContext,
        mode,
        acpResolveModel(agent.provider, agent.model),
        conversation.nativeSessionId ?? null,
        (event) => {
          // Discard events that arrived after a workspace switch.
          if (isStaleWorkspace()) return;
          if (event.type === "status") {
            setSendStatus(event.message);
            return;
          }
          if (event.type === "session") {
            // Persist the provider's native session/thread id so the next
            // send (or app restart) resumes the conversation without
            // replaying the whole transcript.
            void persistForSend(
              applyToConversation((current) =>
                current.nativeSessionId === event.sessionId
                  ? current
                  : { ...current, nativeSessionId: event.sessionId },
              ),
            );
            return;
          }
          if (event.type === "thought") {
            appendThought(event.content);
            return;
          }
          if (event.type === "text") {
            setSendStatus("Recebendo resposta…");
            // A resposta substitui o raciocínio na tela (se o modelo voltar a
            // pensar depois de uma ferramenta, o bloco reaparece).
            clearThought();
            appendAssistantText(event.content);
            return;
          }
          if (event.type === "done") {
            wasCancelled = event.stopReason.toLowerCase() === "cancelled";
            void finalizeAssistant(
              "done",
              wasCancelled
                ? "Execução interrompida pelo usuário."
                : "O agente encerrou a resposta sem conteúdo textual.",
            );
            return;
          }
          if (event.type === "error") setSendError(event.message);
        },
      );

      if (isStaleWorkspace()) return;
      // Safety net: if no `done` event arrived (older adapter, abrupt close),
      // finalize now. No-op when `done` already finalized.
      await finalizeAssistant(
        "done",
        "O agente encerrou a resposta sem conteúdo textual.",
      );
      setSendStatus(
        wasCancelled ? "Execução interrompida." : "Resposta concluída.",
      );
    } catch (error) {
      if (isStaleWorkspace()) return;
      flushAssistantText();
      const messageText = String(error);
      await finalizeAssistant("error", messageText);
      setSendError(messageText);
      setSendStatus(null);
    } finally {
      // agentBusy is global UI state — always release it, even after a workspace
      // switch, or the new workspace would stay stuck "busy".
      if (textFlushTimer !== null) clearTimeout(textFlushTimer);
      clearThought();
      setAgentBusy(false);
      streamingConversationIdRef.current = null;
    }
  }

  /** Stops the current turn and preserves the response received so far. */
  function handleStopAgent() {
    if (!agentBusy) return;
    // O status pertence à conversa cujo turno está rodando (pode não ser a
    // que está visível — o processo em andamento é único e global).
    const conversationId = streamingConversationIdRef.current;
    setAgentStatus({ conversationId, message: "Parando o agente…" });
    void acpCancel().catch((error) =>
      setAgentError({ conversationId, message: String(error) }),
    );
  }

  /**
   * Rolls the working tree back to the snapshot taken before `userMessageId`'s
   * request, undoing everything the agent changed for it. Marks the point as
   * reverted and refreshes the explorer/git so the UI reflects the restore.
   */
  async function handleRevertMessage(
    conversationId: string,
    userMessageId: string,
  ) {
    if (!agentWorkspaceRoot) return;
    const conversation = agentStore.conversations.find(
      (candidate) => candidate.id === conversationId,
    );
    const target = conversation?.messages.find(
      (candidate) => candidate.id === userMessageId,
    );
    if (!target?.revert || target.revert.reverted) return;

    try {
      await gitSnapshotRestore(agentWorkspaceRoot, target.revert);
    } catch (error) {
      setAgentError({
        conversationId,
        message: `Não foi possível reverter: ${String(error)}`,
      });
      return;
    }

    const next = replaceConversation(agentStore, conversationId, (current) => ({
      ...current,
      messages: current.messages.map((candidate) =>
        candidate.id === userMessageId && candidate.revert
          ? { ...candidate, revert: { ...candidate.revert, reverted: true } }
          : candidate,
      ),
    }));
    void persistAgentStore(next);
    await refreshExplorerRoot();
    setAgentStatus({
      conversationId,
      message: "Alterações revertidas para antes deste pedido.",
    });
  }

  /**
   * Open a file in a tab (or focus it if already open), optionally at a line.
   *
   * `mode` (ISSUE-70) picks the view: omitted ⇒ the file type's default (images
   * preview, everything else text). Image-mode tabs don't read text content —
   * the {@link ImagePreview} loads the bytes itself — so we skip `readFile`.
   *
   * `opts.silent` swallows the read-error alert and returns `false` instead —
   * used by the launch-time tab restore so a since-deleted file is skipped
   * quietly rather than popping a dialog on startup (issue #7).
   */
  const handleOpenFile = useCallback(
    async (
      node: FileNode,
      line?: number,
      mode?: OpenMode,
      selection?: MatchSelection,
      opts?: { silent?: boolean }
    ): Promise<boolean> => {
      if (node.isDir) return false;

      const resolvedMode: OpenMode = mode ?? defaultModeFor(node.path);
      const workspaceRemote = node.workspaceRemote ?? workspaceRemoteForPath(node.path);

      // Compare case-insensitively on Windows: the same file can arrive with a
      // different drive-letter casing (explorer vs picker vs LSP URI), which
      // would otherwise open it as a second tab (issue #7). Reuse the existing
      // tab's stored path so focus/active matching stays consistent.
      const already = openFiles.find((f) => samePath(f.path, node.path));
      if (already) {
        // Re-opening with a different mode (e.g. via "Open With…") switches the
        // existing tab's view rather than duplicating it.
        if (mode && already.mode !== mode) {
          setOpenFiles((prev) =>
            prev.map((f) =>
              samePath(f.path, node.path) ? { ...f, mode: resolvedMode } : f
            )
          );
        }
        setActivePath(already.path);
        if (line != null && resolvedMode === "text") {
          revealRef.current?.(line, selection);
        }
        return true;
      }

      // Active-group routing (VS Code style): when a detached editor window is
      // the active group, a NEW file opens there as a tab instead of here. Files
      // already open in this window were focused-in-place above.
      try {
        const active = await getActiveEditor();
        if (active) {
          const decoded =
            resolvedMode === "text"
              ? workspaceRemote
                ? await readSshTextFile(workspaceRemote.connId, node.path)
                : await readFile(node.path)
              : null;
          await openInDetached(active.label, {
            path: node.path,
            name: node.name,
            content: decoded?.content ?? "",
            workspaceRemote,
            dirty: false,
            mode: resolvedMode,
            encoding: decoded?.encoding,
            bom: decoded?.bom,
            eol: decoded?.eol,
          });
          return true;
        }
      } catch (err) {
        // Detached window gone/unreachable — fall back to opening locally below.
        console.warn("Roteamento para a janela destacada falhou:", err);
      }

      try {
        // Preview modes (image/video/audio) load their own bytes via base64;
        // only the text editor needs the file contents up front.
        const decoded =
          resolvedMode === "text"
            ? workspaceRemote
              ? await readSshTextFile(workspaceRemote.connId, node.path)
              : await readFile(node.path)
            : null;
        // Dedupe INSIDE the functional update: the `already` check above reads a
        // snapshot, so two quick opens of the same file both pass it and would
        // each append a tab. Re-checking `prev` here makes "one tab per file"
        // race-safe (no duplicate tabs).
        let duplicate = false;
        setOpenFiles((prev) => {
          if (prev.some((f) => samePath(f.path, node.path))) {
            duplicate = true;
            return prev;
          }
          return [
            ...prev,
            {
              path: node.path,
              name: node.name,
              content: decoded?.content ?? "",
              workspaceRemote,
              dirty: false,
              mode: resolvedMode,
              encoding: decoded?.encoding,
              bom: decoded?.bom,
              eol: decoded?.eol,
            },
          ];
        });
        setActivePath(node.path);
        // The editor isn't mounted with this content yet; defer the reveal.
        if (line != null && resolvedMode === "text") {
          if (duplicate) revealRef.current?.(line, selection);
          else pendingReveal.current = { line, selection };
        }
        return true;
      } catch (err) {
        console.error(err);
        if (!opts?.silent) alert(`Não foi possível abrir o arquivo:\n${err}`);
        return false;
      }
    },
    [openFiles, workspaceRemoteForPath]
  );

  /**
   * Open a search result: opens/focuses the file, then reveals and selects the
   * matched term so it's highlighted in the editor, like VSCode. `startColumn`/
   * `endColumn` are 1-based Monaco columns of the first match on the line.
   */
  const handleOpenMatch = useCallback(
    (node: FileNode, line: number, startColumn: number, endColumn: number) => {
      handleOpenFile(node, line, undefined, { startColumn, endColumn });
    },
    [handleOpenFile]
  );

  const handleOpenGitRevision = useCallback(
    async (
      filePath: string,
      commitHash: string,
      shortHash: string,
      repoRootPath?: string,
      connId?: string
    ) => {
      const target = repoRootPath
        ? { rootPath: repoRootPath, connId }
        : gitTargetForPath(filePath);
      if (!target) return;
      try {
        const [content, commits] = await Promise.all([
          gitShowFileAtCommit(target.rootPath, filePath, commitHash, target.connId),
          gitLogFile(target.rootPath, filePath, 80, target.connId).catch(() => []),
        ]);
        const commitMeta = commits.find((commit) => commit.hash === commitHash);
        const name = `${baseName(filePath)} @ ${shortHash}`;
        const path = gitRevisionUri(filePath, shortHash);
        setLayout((l) =>
          openInGroup(l, l.activeGroup, {
            path,
            name,
            content,
            dirty: false,
            readOnly: true,
            sourcePath: filePath,
            sourceLabel: `Revisão Git ${shortHash} de ${baseName(filePath)}`,
            revisionHash: commitHash,
            revisionShort: shortHash,
            revisionRemoteUrl: commitMeta?.remoteUrl,
            mode: "text",
          })
        );
      } catch (err) {
        console.error(err);
        alert(`Não foi possível abrir a revisão Git:\n${err}`);
      }
    },
    [gitTargetForPath, rootPath]
  );

  const handleOpenGitRevisionDiff = useCallback(
    async (
      filePath: string,
      commitHash: string,
      shortHash: string,
      compareTo: GitRevisionDiffTarget,
      repoRootPath?: string,
      connId?: string
    ) => {
      const target = repoRootPath
        ? { rootPath: repoRootPath, connId }
        : gitTargetForPath(filePath);
      if (!target) return;
      try {
        const [diff, commits, originalContent, modifiedContent] = await Promise.all([
          gitDiffFileRevision(target.rootPath, filePath, commitHash, compareTo, target.connId),
          gitLogFile(target.rootPath, filePath, 80, target.connId).catch(() => []),
          compareTo === "previous"
            ? readGitFileAtCommitOrEmpty(target.rootPath, filePath, `${commitHash}^`, target.connId)
            : readGitFileAtCommitOrEmpty(target.rootPath, filePath, commitHash, target.connId),
          compareTo === "previous"
            ? readGitFileAtCommitOrEmpty(target.rootPath, filePath, commitHash, target.connId)
            : readWorkingFileOrEmpty(filePath, target.connId),
        ]);
        const commitMeta = commits.find((commit) => commit.hash === commitHash);
        const comparisonLabel =
          compareTo === "previous" ? "alterações anteriores" : "comparado ao working file";
        const content =
          diff.trim().length > 0
            ? diff
            : `# Sem diferenças para ${baseName(filePath)} em ${shortHash} (${comparisonLabel}).\n`;
        const name =
          compareTo === "previous"
            ? `${baseName(filePath)} ${shortHash} ↔ anterior`
            : `${baseName(filePath)} ${shortHash} ↔ atual`;
        const path = gitRevisionDiffUri(filePath, shortHash, compareTo);
        setLayout((l) =>
          openInGroup(l, l.activeGroup, {
            path,
            name,
            content,
            originalContent,
            modifiedContent,
            originalLabel:
              compareTo === "previous" ? `Anterior a ${shortHash}` : `Revisão ${shortHash}`,
            modifiedLabel:
              compareTo === "previous" ? `Revisão ${shortHash}` : "Arquivo atual",
            dirty: false,
            readOnly: true,
            sourcePath: filePath,
            sourceLabel:
              compareTo === "previous"
                ? `Diff Git ${shortHash} com revisão anterior`
                : `Diff Git ${shortHash} com arquivo atual`,
            revisionHash: commitHash,
            revisionShort: shortHash,
            revisionRemoteUrl: commitMeta?.remoteUrl,
            mode: "diff",
          })
        );
      } catch (err) {
        console.error(err);
        alert(`Não foi possível abrir o diff Git:\n${err}`);
      }
    },
    [gitTargetForPath, rootPath]
  );

  const handleOpenGitFileChanges = useCallback(
    async (
      filePath: string,
      repoRootPath?: string,
      connId?: string,
      view: GitChangeView = "working"
    ) => {
      const target = repoRootPath
        ? { rootPath: repoRootPath, connId }
        : gitTargetForPath(filePath);
      if (!target) return;
      try {
        const [diff, originalContent, modifiedContent] = await Promise.all([
          view === "staged"
            ? gitDiffFileStaged(target.rootPath, filePath, target.connId).catch(() => "")
            : gitDiffFile(target.rootPath, filePath, target.connId).catch(() => ""),
          readGitFileAtCommitOrEmpty(target.rootPath, filePath, "HEAD", target.connId),
          view === "staged"
            ? gitShowFileStaged(target.rootPath, filePath, target.connId).catch(() => "")
            : readWorkingFileOrEmpty(filePath, target.connId),
        ]);
        const staged = view === "staged";
        const content =
          diff.trim().length > 0
            ? diff
            : `# Sem diferenças ${staged ? "preparadas" : "rastreadas"} para ${baseName(filePath)} contra HEAD.\n`;
        setLayout((l) =>
          openInGroup(l, l.activeGroup, {
            path: staged ? gitStagedDiffUri(filePath) : gitWorkingDiffUri(filePath),
            name: staged ? `${baseName(filePath)} ↔ Index` : `${baseName(filePath)} ↔ HEAD`,
            content,
            originalContent,
            modifiedContent,
            originalLabel: "HEAD",
            modifiedLabel: staged ? "Index" : "Working tree",
            dirty: false,
            readOnly: true,
            sourceLabel: staged
              ? `Alterações preparadas de ${baseName(filePath)}`
              : `Alterações Git de ${baseName(filePath)} contra HEAD`,
            sourcePath: filePath,
            mode: "diff",
          })
        );
      } catch (err) {
        console.error(err);
        alert(`Não foi possível abrir as alterações Git:\n${err}`);
      }
    },
    [gitTargetForPath, rootPath]
  );

  // Record every file activation regardless of whether it came from Explorer,
  // tabs, Search, Quick Open or go-to-definition.
  useEffect(() => {
    if (!activePath) return;
    if (historyNavigationTargetRef.current === activePath) {
      historyNavigationTargetRef.current = null;
      return;
    }
    navigationHistoryRef.current = recordNavigation(
      navigationHistoryRef.current,
      activePath
    );
  }, [activePath]);

  // A workspace has its own navigation timeline.
  useEffect(() => {
    navigationHistoryRef.current = createNavigationHistory();
    historyNavigationTargetRef.current = null;
  }, [rootPath]);

  const navigateFileHistory = useCallback(
    async (direction: -1 | 1) => {
      if (historyNavigationPendingRef.current) return;
      historyNavigationPendingRef.current = true;

      try {
        const target = navigationTarget(navigationHistoryRef.current, direction);
        if (!target) return;

        historyNavigationTargetRef.current = target.path;
        const opened = await handleOpenFile({
          name: baseName(target.path),
          path: target.path,
          isDir: false,
        });
        if (!opened) {
          historyNavigationTargetRef.current = null;
          return;
        }

        navigationHistoryRef.current = {
          ...navigationHistoryRef.current,
          index: target.index,
        };
      } finally {
        historyNavigationPendingRef.current = false;
      }
    },
    [handleOpenFile]
  );

  useEffect(() => {
    let lastHandledButton = -1;
    let lastHandledAt = 0;

    const handleNavigationButton = (event: MouseEvent) => {
      const direction = mouseNavigationDirection(event.button);
      if (direction === null) return;

      // Prevent WebView2 from treating the side buttons as browser history.
      event.preventDefault();
      event.stopPropagation();

      // Chromium may emit both mouseup and auxclick for one physical press.
      const now = performance.now();
      if (
        event.button === lastHandledButton &&
        now - lastHandledAt < 100
      ) {
        return;
      }
      lastHandledButton = event.button;
      lastHandledAt = now;

      void navigateFileHistory(direction);
    };

    window.addEventListener("mouseup", handleNavigationButton, true);
    window.addEventListener("auxclick", handleNavigationButton, true);
    return () => {
      window.removeEventListener("mouseup", handleNavigationButton, true);
      window.removeEventListener("auxclick", handleNavigationButton, true);
    };
  }, [navigateFileHistory]);

  /** "Open With…" → open `path` in the chosen mode (ISSUE-70). */
  const handleOpenWith = useCallback(
    (path: string, mode: OpenMode) => {
      handleOpenFile(
        { name: baseName(path), path, isDir: false },
        undefined,
        mode
      );
    },
    [handleOpenFile]
  );

  /** Show a file's git history in the Source Control panel (ISSUE-71). */
  const handleFileHistory = useCallback((path: string, line?: number) => {
    const target = gitTargetForPath(path);
    setHistoryFile(path);
    setHistoryTarget(
      line
        ? {
            file: path,
            line,
            rootPath: target?.rootPath,
            connId: target?.connId,
          }
        : {
            file: path,
            rootPath: target?.rootPath,
            connId: target?.connId,
          }
    );
    setActiveView("git");
  }, [gitTargetForPath]);

  /**
   * Advanced explorer actions handed to the FileExplorer for épico A's file
   * context menu to consume (issues 69-71). Bundled so the menu can build its
   * items with `buildAdvancedFileMenuItems` without App reaching into the tree.
   */
  const explorerAdvancedActions = useMemo(
    () => ({
      onShowOpenWith: (path: string, x: number, y: number) =>
        setOpenWith({ path, x, y }),
      onOpenChanges: handleOpenGitFileChanges,
      onFileHistory: handleFileHistory,
      isGitRepo: (path: string) => {
        const target = gitTargetForPath(path);
        if (!target) return false;
        if (!activeWorkspace) return gitState?.isRepo ?? false;
        return Object.values(workspaceGitStates).some(
          (entry) =>
            entry.rootPath === target.rootPath &&
            entry.connId === target.connId &&
            (entry.status?.isRepo ?? false)
        );
      },
    }),
    [
      activeWorkspace,
      gitState,
      gitTargetForPath,
      handleFileHistory,
      handleOpenGitFileChanges,
      workspaceGitStates,
    ]
  );

  /** Editor edits update the active buffer and mark it dirty. */
  /**
   * Edits the active buffer of a group. Updates EVERY group holding that file —
   * the same document can be open in two split groups (Monaco shares the model
   * by path), so all copies must stay in sync.
   */
  const editInGroup = useCallback((groupId: string, value: string) => {
    setLayout((l) => {
      const g = l.groups[groupId];
      if (!g || !g.activePath) return l;
      return patchFileEverywhere(l, g.activePath, { content: value, dirty: true });
    });
  }, []);

  /**
   * Writes a single open file to disk and clears its dirty flag. The shared
   * persistence path: the active-buffer Save, the close-tab guard and the
   * close-window/switch-folder "save all" all funnel through here so there's one
   * place that calls `write_file`. Throws on failure so callers can keep the tab
   * open; reports via alert (kept from the existing flow).
   */
  const saveFile = useCallback(
    async (file: OpenFile) => {
      if (file.readOnly) {
        throw new Error("Esta aba é somente leitura.");
      }
      // Untitled buffers have no path yet — ask where to save (Save As). Throwing
      // on cancel keeps the close/save-all guards from removing the tab.
      let targetPath = file.path;
      if (isUntitled(file.path)) {
        const dest = await pickSavePath(file.name);
        if (!dest) throw new Error("Salvamento cancelado");
        targetPath = dest;
      }
      try {
        // Format on save (roadmap csharp-ide-parity A1): best-effort, never
        // blocks the save — null means "save as-is" (flag off, no editor
        // attached, unsupported language, or the formatter failed/timed out).
        // Untitled buffers are skipped (their model uri predates targetPath).
        let contentToWrite = file.content;
        if (!isUntitled(file.path)) {
          const formatted = await formatModelForSave(targetPath);
          if (formatted != null) contentToWrite = formatted;
        }
        if (file.workspaceRemote && !isUntitled(file.path)) {
          await writeSshTextFile(file.workspaceRemote.connId, targetPath, contentToWrite);
        } else {
          // Preserve the file's original encoding/BOM/line ending on save (VS Code
          // default). Untitled buffers have no detected encoding yet, so they fall
          // back to UTF-8 + LF inside writeFile.
          await writeFile(targetPath, contentToWrite, {
            encoding: file.encoding,
            eol: file.eol,
            bom: file.bom,
          });
        }
        // Notify disk-based language tooling that this file's on-disk content is
        // now current. The CSHTML projection broker (ADR 0002) regenerates from
        // disk (`dotnet build`), so it must reprepare on save — not on every
        // keystroke, which would rebuild from stale disk content.
        window.dispatchEvent(
          new CustomEvent("fluent:file-saved", { detail: { path: targetPath } })
        );
        // Clear dirty (and follow the rename, for untitled buffers) in EVERY
        // group holding this file — it may be open in more than one split.
        // `content` carries what actually hit the disk (formatted or not), so
        // state and disk can't diverge if the format-edit change event races.
        setLayout((l) =>
          patchFileEverywhere(l, file.path, {
            path: targetPath,
            name: baseName(targetPath),
            content: contentToWrite,
            dirty: false,
            workspaceRemote: isUntitled(file.path) ? undefined : file.workspaceRemote,
          })
        );
        // The file's links/imports may have changed — drop the cached graph +
        // knowledge index so the graph/backlinks re-scan on next open/switch.
        invalidateGraph();
        invalidateIndex();
      } catch (err) {
        console.error(err);
        alert(`Não foi possível salvar:\n${err}`);
        throw err;
      }
    },
    []
  );

  /** Remove a tab from `openFiles`, moving focus off it if it was active. */
  /** Removes a tab from a group, moving focus off it and collapsing an emptied
   *  group (except the last one). Orphaned models are disposed by the
   *  reconciliation effect below (see `keepCurrentModel`). */
  const removeTabFromGroup = useCallback((groupId: string, path: string) => {
    setLayout((l) => closeFile(l, groupId, path));
  }, []);

  // Dispose Monaco models for files that were open and are now closed in EVERY
  // group. `EditorPane` sets `keepCurrentModel`, so Monaco no longer disposes a
  // model on tab switch (which previously tore down the Razor projection / LSP
  // document and made C# diagnostics vanish after revisiting a tab). The flip
  // side: we must dispose models on REAL close ourselves, or they'd leak and keep
  // stale LSP documents (or, for untitled buffers, their unsaved contents) alive.
  // Reconciling against the set of open paths covers every close path (close,
  // close-all/others/left/right, detach) at once, and the split-group guard is
  // automatic — a path still open in another group stays in `openNow`. Disposing
  // fires onWillDisposeModel → the broker's forgetDoc and the client's didClose:
  // the correct teardown for a closed document. Untitled buffers are tracked too
  // (their model URI is the synthetic `untitled:` path, matching EditorPane).
  const openFilePathsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const openNow = new Set<string>();
    for (const group of Object.values(layout.groups)) {
      for (const f of group.files) openNow.add(f.path);
    }
    for (const path of openFilePathsRef.current) {
      if (openNow.has(path)) continue;
      // Mirror EditorPane's `modelPath`: untitled buffers keep their synthetic
      // `untitled:` URI; on-disk files go through the `file://` scheme.
      const uri = isUntitled(path) ? path : toFileUri(path);
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model && !model.isDisposed()) model.dispose();
    }
    openFilePathsRef.current = openNow;
  }, [layout]);

  /** Reorders tabs within a group: drops `fromPath` just before/after `toPath`. */
  const reorderTabsInGroup = useCallback(
    (groupId: string, fromPath: string, toPath: string, before: boolean) => {
      setLayout((l) => reorderInGroup(l, groupId, fromPath, toPath, before));
    },
    []
  );

  /**
   * Tears a tab off into its own window ("Mover para Nova Janela"). The whole
   * buffer (incl. unsaved changes + remote info) is handed off; on success the
   * tab is removed here since the file now lives in the detached window.
   */
  const detachFromGroup = useCallback(
    async (groupId: string, path: string, screenX = 0, screenY = 0) => {
      const file = layoutRef.current.groups[groupId]?.files.find(
        (f) => f.path === path
      );
      if (!file) return;

      // The HTML5 dragend coords freeze when the cursor is over another app, so
      // read the real OS cursor for the true drop position.
      try {
        const [cx, cy] = await cursorPosition();
        if (cx || cy) {
          screenX = cx;
          screenY = cy;
        }
      } catch {
        /* keep the passed coords */
      }

      // Gesture (drop with screen coords): decide by what's under the cursor.
      if (screenX || screenY) {
        let target: string | null = null;
        try {
          target = await windowAtPosition(screenX, screenY, "");
        } catch {
          target = null;
        }
        const myLabel = getCurrentWindow().label;
        // Dropped back inside THIS window's own dead space → not a tear-off.
        if (target === myLabel) return;
        // Dropped over ANOTHER app window → move the tab into it.
        if (target) {
          try {
            await adoptTabInWindow(target, file, { x: screenX, y: screenY });
            removeTabFromGroup(groupId, path);
          } catch (err) {
            console.warn("Não foi possível mover a aba para a janela:", err);
          }
          return;
        }
      }

      // Empty desktop (or menu action with no coords) → spawn a new window,
      // placed where it was dropped when we have coordinates.
      const remote = getActiveRemote();
      const state: DetachedState = {
        files: [file],
        activePath: file.path,
        remote: remote
          ? {
              connId: remote.connId,
              host: remote.host,
              user: remote.user,
              rootPath: remote.rootPath,
            }
          : undefined,
      };
      try {
        await openDetachedEditor(
          state,
          screenX || screenY ? { x: screenX, y: screenY } : undefined
        );
        removeTabFromGroup(groupId, path);
      } catch (err) {
        console.warn("Não foi possível destacar a aba:", err);
      }
    },
    [removeTabFromGroup]
  );

  /** Reopens a whole group handed back from a detached window (re-dock). */
  const reopenDetached = useCallback((state: DetachedState) => {
    setOpenFiles((prev) => {
      const merged = [...prev];
      for (const f of state.files) {
        const i = merged.findIndex((x) => x.path === f.path);
        if (i >= 0) merged[i] = { ...merged[i], content: f.content, dirty: f.dirty };
        else merged.push({ ...f, mode: f.mode ?? "text" });
      }
      return merged;
    });
    if (state.activePath) setActivePath(state.activePath);
  }, []);

  // Listen for groups handed back from detached editor windows (re-dock).
  useEffect(() => {
    const unlisten = listen<{ token: string }>("redock-editor", async (e) => {
      const state = await takeDetachedState(e.payload.token);
      if (state) reopenDetached(state);
      void editorRelease(e.payload.token);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [reopenDetached]);

  // Adopt a tab dragged in from ANOTHER window: insert it where the cursor was
  // (a specific group's strip at before/after a tab), else into the active
  // group; then bring this window to the front.
  useEffect(() => {
    const unlisten = listen<{ file: OpenFile; x?: number; y?: number }>(
      "adopt-tab",
      (e) => {
        const file = { ...e.payload.file, mode: e.payload.file.mode ?? "text" };
        const t =
          e.payload.x != null && e.payload.y != null
            ? dropTargetAt(e.payload.x, e.payload.y)
            : null;
        setLayout((l) =>
          t && t.groupId && l.groups[t.groupId]
            ? insertFileInGroup(l, t.groupId, file, t.targetPath ?? undefined, t.before)
            : openInGroup(l, l.activeGroup, file)
        );
        setDropHint(false);
        setDropBar(null);
        void getCurrentWindow().setFocus();
      }
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // The main window starts as the active editor group (the home group). It
  // RECLAIMS "active" when the user interacts with its editor area (see
  // onMouseDownCapture on <main>), NOT merely when the OS focuses it — opening a
  // file from the explorer focuses this window, yet must still route to a focused
  // detached group ("o próximo arquivo vai pra essa outra janela").
  useEffect(() => {
    void clearActiveEditor();
  }, []);

  /**
   * Close a tab, guarding unsaved work. A clean buffer closes immediately; a
   * dirty one asks "Salvar / Não salvar / Cancelar" first: Salvar writes then
   * closes (an error keeps the tab), Não salvar discards and closes, Cancelar/Esc
   * aborts. Async so the close waits for the user's decision.
   */
  const handleCloseTab = useCallback(
    async (path: string, groupId: string = layoutRef.current.activeGroup) => {
      const file = layoutRef.current.groups[groupId]?.files.find(
        (f) => f.path === path
      );
      if (!file) return;
      if (!file.dirty) {
        removeTabFromGroup(groupId, path);
        return;
      }
      // Don't stack a second dialog for a tab already mid-confirmation.
      const key = `${groupId}:${path}`;
      if (closingPaths.current.has(key)) return;
      closingPaths.current.add(key);
      try {
        const choice = await askConfirm(
          "Deseja salvar as alterações?",
          `Deseja salvar as alterações em ${baseName(path)}?`,
          [
            { label: "Salvar", variant: "primary", value: "save", default: true },
            { label: "Não salvar", variant: "danger", value: "discard" },
            { label: "Cancelar", variant: "secondary", value: "cancel" },
          ]
        );
        if (choice === "save") {
          // Save the current buffer; only close if the write succeeds.
          try {
            await saveFile(file);
          } catch {
            return; // error already reported; keep the tab open and dirty
          }
          removeTabFromGroup(groupId, path);
        } else if (choice === "discard") {
          removeTabFromGroup(groupId, path);
        }
        // "cancel" / null (Esc/overlay): do nothing.
      } finally {
        closingPaths.current.delete(key);
      }
    },
    [askConfirm, saveFile, removeTabFromGroup]
  );

  // Latest open files / active path, readable from non-reactive listeners
  // (window-close handler, Ctrl+W) without re-subscribing on every change.
  const openFilesRef = useRef<OpenFile[]>(openFiles);
  openFilesRef.current = openFiles;
  const activePathRef = useRef<string | null>(activePath);
  activePathRef.current = activePath;
  // Latest handleOpenFile, so the run-once boot restore can reopen tabs without
  // listing the (per-keystroke-changing) callback in its dependency array.
  const handleOpenFileRef = useRef(handleOpenFile);
  handleOpenFileRef.current = handleOpenFile;

  // Persist the open tabs + active tab whenever they change, debounced so we
  // don't hit the disk on every keystroke that touches `openFiles` (e.g. the
  // dirty flag). Skipped while the launch restore is still reopening tabs, so
  // the partial mid-restore state never clobbers the saved session (issue #7).
  // Only the path + view mode are sent; content is re-read from disk on reopen.
  useEffect(() => {
    if (restoringSessionRef.current) return;
    const timer = window.setTimeout(() => {
      // Flat fallback = the active group's tabs; `layout` carries the full grid.
      // Synthetic tabs (graph, Git revisions) have no file on disk, so they're
      // never persisted.
      const tabs: OpenTab[] = openFiles
        .filter((f) => !isVirtualTab(f.path))
        .map((f) => ({ path: f.path, mode: f.mode }));
      const sl = serializeLayout(layout);
      sl.groups = sl.groups.map((g) => ({
        ...g,
        tabs: g.tabs.filter((t) => !isVirtualTab(t.path)),
        activePath: isVirtualTab(g.activePath ?? "") ? null : g.activePath,
      }));
      const serialized = JSON.stringify(sl);
      sessionSetOpenFiles(
        tabs,
        activePath && !isVirtualTab(activePath) ? activePath : null,
        serialized
      ).catch((err) =>
        console.error("Falha ao salvar abas da sessão:", err)
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [layout, openFiles, activePath]);

  useEffect(() => {
    if (restoringSessionRef.current) return;
    const timer = window.setTimeout(() => {
      sessionSetWorkspace(
        activeWorkspace ? workspaceSessionSnapshot(activeWorkspace) : null
      ).catch((err) =>
        console.error("Falha ao salvar workspace da sessão:", err)
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeWorkspace]);

  // Remember the last real file the user focused (ignoring virtual tabs), so the
  // graph can highlight it even when the graph/revision tab itself is active.
  useEffect(() => {
    if (activePath && !isVirtualTab(activePath)) setLastRealFile(activePath);
  }, [activePath]);

  /**
   * Batch unsaved-changes guard for actions that drop the whole session at once
   * (close window, switch/close folder). With no dirty buffers it resolves
   * `true` straight away. Otherwise it asks "Salvar tudo / Descartar tudo /
   * Cancelar": Salvar tudo writes every dirty file and proceeds only if all
   * succeed; Descartar tudo proceeds without saving; Cancelar/Esc aborts.
   * Returns whether the caller may proceed to discard the session.
   */
  const guardDirtyFiles = useCallback(async (files: OpenFile[]): Promise<boolean> => {
    const dirty = [...new Map(files.filter((file) => file.dirty).map((file) => [file.path, file])).values()];
    if (dirty.length === 0) return true;
    const choice = await askConfirm(
      "Deseja salvar as alterações?",
      dirty.length === 1
        ? `Há alterações não salvas em ${dirty[0].name}.`
        : `Há alterações não salvas em ${dirty.length} arquivos.`,
      [
        { label: "Salvar tudo", variant: "primary", value: "save", default: true },
        { label: "Descartar tudo", variant: "danger", value: "discard" },
        { label: "Cancelar", variant: "secondary", value: "cancel" },
      ]
    );
    if (choice === "discard") return true;
    if (choice === "save") {
      // Save each dirty file sequentially; abort the action if any write fails.
      try {
        for (const file of dirty) await saveFile(file);
        return true;
      } catch {
        return false; // error already reported; keep the session open
      }
    }
    return false; // "cancel" / Esc
  }, [askConfirm, saveFile]);

  const guardDirtySession = useCallback(
    () => guardDirtyFiles(allOpenFiles()),
    [allOpenFiles, guardDirtyFiles]
  );

  // Once true, the next close request is the real one we triggered after the
  // dialog — let it through instead of reopening the guard (reentrancy guard).
  const confirmedClose = useRef(false);

  /**
   * Intercept the window's close request (X button, Alt+F4, File ▸ Exit). With
   * dirty buffers, cancel the close, run the batch guard and — if the user
   * confirms — close for real. The reentrancy flag lets that real close pass.
   */
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlistenPromise = appWindow.onCloseRequested(async (event) => {
      if (confirmedClose.current) return; // our own close — let it proceed
      const hasDirty = allOpenFiles().some((f) => f.dirty);
      if (!hasDirty) {
        // Nothing to guard. Don't preventDefault — let the close proceed. We also
        // destroy() explicitly as a fallback in case the default close is being
        // swallowed, so the window always goes away.
        confirmedClose.current = true;
        void appWindow.destroy();
        return;
      }
      event.preventDefault();
      const ok = await guardDirtySession();
      if (ok) {
        confirmedClose.current = true;
        void appWindow.destroy();
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [allOpenFiles, guardDirtySession]);

  /** "Close all" within a group → empties it; a non-final group is removed. */
  const handleCloseAll = useCallback(
    async (groupId = layoutRef.current.activeGroup) => {
      const group = layoutRef.current.groups[groupId];
      if (!group || !(await guardDirtyFiles(group.files))) return;
      setLayout((l) => {
        if (groupOrder(l.root).length > 1) return removeGroup(l, groupId);
        const g = l.groups[groupId];
        if (!g) return l;
        return {
          ...l,
          groups: { ...l.groups, [groupId]: { ...g, files: [], activePath: null } },
        };
      });
    },
    [guardDirtyFiles]
  );

  const handleCloseOthers = useCallback(
    async (path: string, groupId = layoutRef.current.activeGroup) => {
      const group = layoutRef.current.groups[groupId];
      if (!group || !(await guardDirtyFiles(group.files.filter((file) => file.path !== path)))) return;
      setLayout((l) => {
        const g = l.groups[groupId];
        if (!g) return l;
        return {
          ...l,
          groups: {
            ...l.groups,
            [groupId]: {
              ...g,
              files: g.files.filter((f) => f.path === path),
              activePath: path,
            },
          },
        };
      });
    },
    [guardDirtyFiles]
  );

  const handleCloseLeft = useCallback(
    async (path: string, groupId = layoutRef.current.activeGroup) => {
      const group = layoutRef.current.groups[groupId];
      const index = group?.files.findIndex((file) => file.path === path) ?? -1;
      if (!group || index <= 0 || !(await guardDirtyFiles(group.files.slice(0, index)))) return;
      setLayout((l) => {
        const g = l.groups[groupId];
        if (!g) return l;
        const idx = g.files.findIndex((f) => f.path === path);
        const files = idx > 0 ? g.files.slice(idx) : g.files;
        const activePath =
          g.activePath && !files.some((f) => f.path === g.activePath)
            ? files[0]?.path ?? null
            : g.activePath;
        return {
          ...l,
          groups: { ...l.groups, [groupId]: { ...g, files, activePath } },
        };
      });
    },
    [guardDirtyFiles]
  );

  const handleCloseRight = useCallback(
    async (path: string, groupId = layoutRef.current.activeGroup) => {
      const group = layoutRef.current.groups[groupId];
      const index = group?.files.findIndex((file) => file.path === path) ?? -1;
      if (!group || index < 0 || !(await guardDirtyFiles(group.files.slice(index + 1)))) return;
      setLayout((l) => {
        const g = l.groups[groupId];
        if (!g) return l;
        const idx = g.files.findIndex((f) => f.path === path);
        const files = idx >= 0 ? g.files.slice(0, idx + 1) : g.files;
        const activePath =
          g.activePath && !files.some((f) => f.path === g.activePath)
            ? files[files.length - 1]?.path ?? null
            : g.activePath;
        return {
          ...l,
          groups: { ...l.groups, [groupId]: { ...g, files, activePath } },
        };
      });
    },
    [guardDirtyFiles]
  );

  /** Focuses a tab within a group (and makes the group active). */
  const selectInGroup = useCallback((groupId: string, path: string) => {
    setLayout((l) => activateFile(l, groupId, path));
  }, []);

  /** Makes a group active (clicking in its editor body). */
  const focusGroup = useCallback((groupId: string) => {
    setLayout((l) =>
      l.activeGroup === groupId ? l : { ...l, activeGroup: groupId }
    );
  }, []);

  /** Wires this workspace's knowledge "brain" into Claude Code: offers to write a
   *  project-scoped `.mcp.json` (auto-detected by Claude Code) and copies the
   *  global `claude mcp add` command as an alternative. */
  const handleShowMcpConfig = useCallback(async () => {
    if (!rootPath) {
      window.alert("Abra uma pasta primeiro — o cérebro (MCP) é por workspace.");
      return;
    }
    try {
      const cfg = await mcpConfig(rootPath);
      try {
        await navigator.clipboard.writeText(cfg.claudeAdd);
      } catch {
        /* clipboard may be unavailable */
      }
      const write = window.confirm(
        "Conectar o cérebro (MCP) ao Claude Code\n\n" +
          "O servidor MCP já está embutido no editor (roda quando um cliente o " +
          "inicia). Posso criar/atualizar um .mcp.json neste projeto para o Claude " +
          "Code detectá-lo automaticamente ao abrir esta pasta.\n\n" +
          "Criar o .mcp.json agora?\n\n" +
          "(Alternativa global já copiada para a área de transferência:\n" +
          cfg.claudeAdd +
          ")"
      );
      if (write) {
        const path = await mcpWriteProjectConfig(rootPath);
        window.alert(
          `Pronto! Criei ${path}.\n\n` +
            "Abra este projeto no Claude Code (CLI) — ele detecta o servidor " +
            "'fluent-knowledge' e passa a consultar backlinks, arquivos " +
            "relacionados, busca e pacotes de contexto do seu projeto."
        );
      }
    } catch (e) {
      window.alert(`Não foi possível configurar o MCP:\n${e}`);
    }
  }, [rootPath]);

  /** Builds a context bundle (the active file + its graph neighbours) and copies
   *  it to the clipboard, ready to paste into an agent prompt. */
  const handleCopyContextBundle = useCallback(async () => {
    if (!activeContextTarget || !activePath || isVirtualTab(activePath)) {
      window.alert("Abra um arquivo do projeto para montar o pacote de contexto.");
      return;
    }
    try {
      const bundle = await buildContextBundle(
        activeContextTarget.rootPath,
        activePath,
        1,
        activeContextTarget.connId
      );
      await navigator.clipboard.writeText(bundle);
      window.alert(
        `Pacote de contexto copiado (${bundle.length} caracteres).\n\n` +
          "Cole no chat de um agente para dar a ele o arquivo atual + os arquivos relacionados."
      );
    } catch (e) {
      window.alert(`Não foi possível montar o pacote de contexto:\n${e}`);
    }
  }, [activeContextTarget, activePath]);

  /** Opens or focuses the context-graph tab. The graph view is paired with the
   *  backlinks sidebar: selecting Graph always brings Backlinks to the left so
   *  the user can inspect references while looking at the map. */
  const handleShowGraph = useCallback(() => {
    setActiveView("graph");
    setSidebarOpen(true);
    setLayout((l) => {
      for (const groupId of groupOrder(l.root)) {
        const group = l.groups[groupId];
        if (group?.files.some((file) => file.path === GRAPH_URI)) {
          return activateFile(l, groupId, GRAPH_URI);
        }
      }
      return openInGroup(l, l.activeGroup, {
        path: GRAPH_URI,
        name: "Grafo",
        content: "",
        dirty: false,
        mode: "graph",
      });
    });
  }, []);

  /** "Split Editor": copies a group's active file into a new group on `edge`. */
  const splitGroupOnEdge = useCallback(
    (groupId: string, edge: Edge) => {
      const newId = nextGroupId();
      setLayout((l) => {
        const g = l.groups[groupId];
        if (!g || !g.activePath) return l;
        const file = g.files.find((f) => f.path === g.activePath);
        if (!file) return l;
        return splitGroupWith(l, groupId, file, edge, newId);
      });
    },
    [nextGroupId]
  );

  /**
   * Handles a tab dropped onto a group's drop-zone: `center` moves it into that
   * group; an edge splits a new group off that side (moving the tab there).
   */
  const handleTabDrop = useCallback(
    (
      targetGroupId: string,
      edge: Edge,
      fromGroupId: string,
      path: string
    ) => {
      if (edge === "center") {
        setLayout((l) => moveFileToGroup(l, fromGroupId, targetGroupId, path));
        return;
      }
      const newId = nextGroupId();
      setLayout((l) =>
        splitWithFile(l, targetGroupId, fromGroupId, path, edge, newId)
      );
    },
    [nextGroupId]
  );

  /** A tab from another division was dropped on a group's tab strip — move it
   *  into that group at the chosen position (before/after a tab, or at the end). */
  const handleTabStripDrop = useCallback(
    (
      targetGroupId: string,
      payload: { groupId: string; path: string },
      targetPath: string | null,
      before: boolean
    ) => {
      setLayout((l) =>
        moveFileToGroup(
          l,
          payload.groupId,
          targetGroupId,
          payload.path,
          targetPath ?? undefined,
          before
        )
      );
    },
    []
  );

  /** Adjusts a split's two adjacent pane weights as the user drags a handle. */
  const resizeGroupBranch = useCallback(
    (branchPath: number[], index: number, left: number, right: number) => {
      setLayout((l) => ({
        ...l,
        root: resizeBranch(l.root, branchPath, index, left, right),
      }));
    },
    []
  );

  /** Open a file chosen via the native file picker (File ▸ Open File…). */
  const handleOpenFileDialog = useCallback(async () => {
    const p = await pickFile();
    if (!p) return;
    await handleOpenFile({ name: baseName(p), path: p, isDir: false });
  }, [handleOpenFile]);

  const loadWorkspaceFromFile = useCallback(async (path: string): Promise<ActiveWorkspace> => {
    const contents = await readLocalTextFile(path);
    const normalized = isFluentWorkspaceFile(path)
      ? parseWorkspaceFile(contents, path)
      : normalizeWorkspaceFile(
          fluentWorkspaceFromCodeWorkspace(JSON.parse(contents), baseName(path)),
          path
        );
    return { ...normalized, filePath: path, dirty: false };
  }, []);

  const resetLoadedWorkspaceShell = useCallback(() => {
    const previousRemote = getActiveRemote();
    if (previousRemote) {
      setActiveRemote(null);
      setRemoteSession(null);
      clearRemoteTerminals();
      clearRemoteLspServers();
      void sshDisconnect(previousRemote.connId).catch(() => {});
    }
    setRootPath(null);
    setRootName(null);
    setRoots([]);
    setExplorerWorkspaceRoot(null);
    resetEditorLayout();
    resetWorkspaceState();
    setSearchScope(null);
    setHistoryFile(null);
    setHistoryTarget(null);
  }, [resetEditorLayout, resetWorkspaceState]);

  const openWorkspaceFromFile = useCallback(
    async (path: string) => {
      if (!(await guardDirtySession())) return;
      try {
        const workspace = await loadWorkspaceFromFile(path);
        const first = workspace.folders[0];
        if (!first) {
          resetLoadedWorkspaceShell();
          setActiveWorkspace(workspace);
          return;
        }
        if (first.provider === "ssh") {
          resetLoadedWorkspaceShell();
          setActiveWorkspace(workspace);
          return;
        }

        const previousRemote = getActiveRemote();
        if (previousRemote) setActiveRemote(null);
        const opened = await openFolder(first.path, {
          persist: false,
          preserveWorkspace: true,
        });
        if (!opened) {
          if (previousRemote) setActiveRemote(previousRemote);
          return;
        }
        resetEditorLayout();
        if (previousRemote) {
          setRemoteSession(null);
          clearRemoteTerminals();
          clearRemoteLspServers();
          void sshDisconnect(previousRemote.connId).catch(() => {});
        }
        setActiveWorkspace(workspace);
      } catch (err) {
        console.error(err);
        alert(`Não foi possível abrir o workspace:\n${err}`);
      }
    },
    [
      guardDirtySession,
      loadWorkspaceFromFile,
      openFolder,
      resetLoadedWorkspaceShell,
      resetEditorLayout,
      resetWorkspaceState,
    ]
  );

  const handleOpenWorkspace = useCallback(async () => {
    const path = await pickWorkspaceFile();
    if (!path) return;
    await openWorkspaceFromFile(path);
  }, [openWorkspaceFromFile]);

  useEffect(() => {
    if (!handledLaunchWorkspaceRef.current) {
      handledLaunchWorkspaceRef.current = true;
      void openedWorkspaceFiles()
        .then((paths) => {
          const first = paths[0];
          if (first) void openWorkspaceFromFile(first);
        })
        .catch((err) => {
          console.error("Falha ao abrir workspace de inicialização:", err);
        });
    }
  }, [openWorkspaceFromFile]);

  const workspaceToSave = useCallback((): ActiveWorkspace | null => {
    if (activeWorkspace) return activeWorkspace;
    if (!rootPath) return null;
    return workspaceForSingleRoot(rootPath, getActiveRemote());
  }, [activeWorkspace, rootPath, workspaceForSingleRoot]);

  const ensureWorkspaceExtension = useCallback((path: string) => {
    return path.toLocaleLowerCase().endsWith(FLUENT_WORKSPACE_EXTENSION)
      ? path
      : `${path}${FLUENT_WORKSPACE_EXTENSION}`;
  }, []);

  const saveWorkspaceToPath = useCallback(
    async (workspace: ActiveWorkspace, path: string) => {
      const target = ensureWorkspaceExtension(path);
      const { filePath: _filePath, dirty: _dirty, ...workspaceFile } = workspace;
      await writeLocalTextFile(target, serializeWorkspaceFile(workspaceFile));
      setActiveWorkspace({ ...workspace, filePath: target, dirty: false });
      return target;
    },
    [ensureWorkspaceExtension]
  );

  const handleSaveWorkspaceAs = useCallback(async () => {
    const workspace = workspaceToSave();
    if (!workspace) {
      alert("Abra uma pasta ou workspace antes de salvar um workspace.");
      return;
    }
    const defaultName = `${workspace.name || rootName || "workspace"}${FLUENT_WORKSPACE_EXTENSION}`;
    const dest = await pickWorkspaceSavePath(defaultName);
    if (!dest) return;
    try {
      await saveWorkspaceToPath(workspace, dest);
    } catch (err) {
      console.error(err);
      alert(`Não foi possível salvar o workspace:\n${err}`);
    }
  }, [rootName, saveWorkspaceToPath, workspaceToSave]);

  const handleSaveWorkspace = useCallback(async () => {
    const workspace = workspaceToSave();
    if (!workspace) {
      alert("Abra uma pasta ou workspace antes de salvar um workspace.");
      return;
    }
    if (!workspace.filePath) {
      await handleSaveWorkspaceAs();
      return;
    }
    try {
      await saveWorkspaceToPath(workspace, workspace.filePath);
    } catch (err) {
      console.error(err);
      alert(`Não foi possível salvar o workspace:\n${err}`);
    }
  }, [handleSaveWorkspaceAs, saveWorkspaceToPath, workspaceToSave]);

  const guardDirtyWorkspace = useCallback(async (): Promise<boolean> => {
    const workspace = activeWorkspace;
    if (!workspace?.dirty) return true;
    const choice = await askConfirm(
      "Deseja salvar o workspace?",
      `Há alterações não salvas em ${workspace.name || "Workspace"}.`,
      [
        { label: "Salvar", variant: "primary", value: "save", default: true },
        { label: "Descartar", variant: "danger", value: "discard" },
        { label: "Cancelar", variant: "secondary", value: "cancel" },
      ]
    );
    if (choice === "discard") return true;
    if (choice !== "save") return false;

    try {
      if (workspace.filePath) {
        await saveWorkspaceToPath(workspace, workspace.filePath);
        return true;
      }
      const defaultName = `${workspace.name || rootName || "workspace"}${FLUENT_WORKSPACE_EXTENSION}`;
      const dest = await pickWorkspaceSavePath(defaultName);
      if (!dest) return false;
      await saveWorkspaceToPath(workspace, dest);
      return true;
    } catch (err) {
      console.error(err);
      alert(`Não foi possível salvar o workspace:\n${err}`);
      return false;
    }
  }, [activeWorkspace, askConfirm, rootName, saveWorkspaceToPath]);

  const clearWorkspaceShell = useCallback(() => {
    const remote = getActiveRemote();
    if (remote) {
      setActiveRemote(null);
      setRemoteSession(null);
      void sshDisconnect(remote.connId).catch(() => {});
    }
    for (const conn of Object.values(workspaceSshConnections)) {
      if (conn.connId && conn.connId !== remote?.connId) {
        void sshDisconnect(conn.connId).catch(() => {});
      }
    }
    setWorkspaceSshConnections({});
    clearRemoteTerminals();
    clearRemoteLspServers();
    setRootPath(null);
    setRootName(null);
    setRoots([]);
    resetEditorLayout();
    resetWorkspaceState();
    setSearchScope(null);
    setHistoryFile(null);
    setHistoryTarget(null);
    setActiveView("explorer");
    setExplorerWorkspaceRoot(null);
    sessionSetLastFolder(null).catch(() => {});
  }, [resetEditorLayout, resetWorkspaceState, workspaceSshConnections]);

  const handleNewWorkspace = useCallback(async () => {
    if (!(await guardDirtySession())) return;
    if (!(await guardDirtyWorkspace())) return;
    const workspace = normalizeWorkspaceFile({
      fluentWorkspace: 1,
      name: createUntitledWorkspaceName(),
      folders: [],
      settings: {},
    });
    clearWorkspaceShell();
    setActiveWorkspace({ ...workspace, filePath: null, dirty: true });
  }, [clearWorkspaceShell, guardDirtySession, guardDirtyWorkspace]);

  const handleAddFolderToWorkspace = useCallback(async () => {
    const folder = await pickFolder();
    if (!folder) return;
    if (!rootPath && !activeWorkspace) {
      await openLocalFolderInPlace(folder);
      return;
    }
    const current = workspaceToSave();
    if (!current) return;
    try {
      const added = normalizeWorkspaceFile({
        fluentWorkspace: 1,
        name: workspaceNameAfterAddingRoot(current),
        folders: [
          ...current.folders.map((item) => ({
            id: item.id,
            name: item.name,
            path: item.path,
            remote: item.remote,
          })),
          { name: baseName(folder), path: folder },
        ],
        settings: current.settings,
      });
      setActiveWorkspace({
        ...added,
        filePath: current.filePath,
        dirty: true,
      });
      if (!rootPath) {
        await openFolder(folder, {
          persist: false,
          preserveWorkspace: true,
        });
      }
    } catch (err) {
      console.error(err);
      alert(`Não foi possível adicionar a pasta ao workspace:\n${err}`);
    }
  }, [activeWorkspace, openFolder, rootPath, workspaceToSave]);

  const handleAddSshFolderToWorkspace = useCallback(() => {
    if (!rootPath && !activeWorkspace) {
      alert("Abra uma pasta ou workspace antes de adicionar uma pasta SSH ao workspace.");
      return;
    }
    void openSshFlow("addToWorkspace");
  }, [activeWorkspace, openSshFlow, rootPath]);

  const handleRenameWorkspaceRoot = useCallback((rootId: string, name: string) => {
    const nextName = name.trim();
    if (!nextName) return;
    setActiveWorkspace((current) => {
      if (!current) return current;
      if (!current.folders.some((folder) => folder.id === rootId)) return current;
      return {
        ...current,
        folders: current.folders.map((folder) =>
          folder.id === rootId ? { ...folder, name: nextName } : folder
        ),
        dirty: true,
      };
    });
  }, []);

  const handleConnectWorkspaceRoot = useCallback(
    (rootId: string) => {
      const folder = activeWorkspace?.folders.find((item) => item.id === rootId);
      if (!folder || folder.provider !== "ssh" || !folder.remote) return;
      const current = workspaceSshConnections[rootId];
      if (current?.status === "connecting" || current?.connId) return;

      const remote = folder.remote;
      setReconnectWorkspaceRootId(rootId);
      setSshHostsOpen(false);
      setSshPasswordFor(null);
      setSshFolderPickMode("addToWorkspace");
      setSshFormInitial({
        host: remote.host,
        port: remote.port ?? 22,
        user: remote.user,
        keyPath: remote.keyPath,
      });
      setSshDialogOpen(true);
    },
    [activeWorkspace, workspaceSshConnections]
  );

  const handleDisconnectWorkspaceRoot = useCallback(
    (rootId: string) => {
      const connId = workspaceSshConnections[rootId]?.connId;
      if (connId) void sshDisconnect(connId).catch(() => {});
      setWorkspaceSshConnections((connections) => ({
        ...connections,
        [rootId]: { status: "error", error: "Desconectado." },
      }));
    },
    [workspaceSshConnections]
  );

  const handleRemoveWorkspaceRoot = useCallback(
    (rootId: string) => {
      if (!activeWorkspace) return;
      const removed = activeWorkspace.folders.find((folder) => folder.id === rootId);
      if (!removed) return;

      const nextFolders = activeWorkspace.folders.filter((folder) => folder.id !== rootId);
      const nextWorkspace: ActiveWorkspace = {
        ...activeWorkspace,
        folders: nextFolders,
        dirty: true,
      };
      setActiveWorkspace(nextWorkspace);

      const removedConn = workspaceSshConnections[rootId]?.connId;
      if (removedConn) void sshDisconnect(removedConn).catch(() => {});
      setWorkspaceSshConnections((connections) => {
        const { [rootId]: _removed, ...rest } = connections;
        return rest;
      });

      if (!rootPath || !pathWithinRoot(rootPath, removed.path)) return;

      const nextLocal = nextFolders.find((folder) => folder.provider === "local");
      if (nextLocal) {
        void openFolder(nextLocal.path, {
          persist: false,
          preserveWorkspace: true,
        });
        return;
      }

      resetWorkspaceState();
      setExplorerWorkspaceRoot(null);
      setRoots([]);
      setRootPath(null);
      setRootName(nextWorkspace.name.toUpperCase());
    },
    [activeWorkspace, openFolder, resetWorkspaceState, rootPath, workspaceSshConnections]
  );

  /** Save the active buffer to a new path chosen via the save dialog (Save As…). */
  const handleSaveAs = useCallback(async () => {
    const file = openFiles.find((f) => f.path === activePath);
    if (!file) return;
    if (file.readOnly) {
      alert("Esta revisão Git é somente leitura. Copie o conteúdo para um novo arquivo se quiser salvar.");
      return;
    }
    const dest = await pickSavePath(file.name);
    if (!dest) return;
    try {
      await writeLocalTextFile(dest, file.content);
      // Same disk-tooling notification as `saveFile` (Save As also writes disk).
      window.dispatchEvent(
        new CustomEvent("fluent:file-saved", { detail: { path: dest } })
      );
      // Re-point the buffer at the new path + clear dirty in EVERY group.
      setLayout((current) =>
        patchFileEverywhere(current, file.path, {
          path: dest,
          name: baseName(dest),
          dirty: false,
          workspaceRemote: undefined,
        })
      );
    } catch (err) {
      console.error(err);
      alert(`Não foi possível salvar:\n${err}`);
    }
  }, [openFiles, activePath]);

  /**
   * Persist the active buffer to disk. Untitled buffers always go through
   * `saveFile` (which prompts for a path, Save As style); named buffers only
   * write when dirty.
   */
  const handleSave = useCallback(async () => {
    const file = openFiles.find((f) => f.path === activePath);
    if (!file) return;
    if (file.readOnly) return;
    if (!file.dirty && !isUntitled(file.path)) return;
    // saveFile already reports/throws on failure; swallow here (no close to gate).
    await saveFile(file).catch(() => {});
  }, [openFiles, activePath, saveFile]);

  /** Close the current workspace folder, returning to the empty state. */
  const handleCloseFolder = useCallback(async () => {
    // Closing the folder discards the session — guard unsaved buffers first.
    if (!(await guardDirtySession())) return;
    if (!(await guardDirtyWorkspace())) return;
    clearWorkspaceShell();
    setActiveWorkspace(null);
  }, [clearWorkspaceShell, guardDirtySession, guardDirtyWorkspace]);

  /** Re-point any open tab(s) when the explorer renames a file or folder. */
  const handlePathRenamed = useCallback(
    (oldPath: string, newPath: string, isDir: boolean) => {
      setOpenFiles((prev) =>
        prev.map((f) => {
          if (!isDir) {
            return f.path === oldPath
              ? { ...f, path: newPath, name: baseName(newPath) }
              : f;
          }
          // Folder rename: rewrite the prefix of any tab under it.
          if (f.path === oldPath || f.path.startsWith(oldPath + "\\") || f.path.startsWith(oldPath + "/")) {
            const suffix = f.path.slice(oldPath.length);
            const next = newPath + suffix;
            return { ...f, path: next, name: baseName(next) };
          }
          return f;
        })
      );
      setActivePath((prev) => {
        if (prev == null) return prev;
        if (!isDir) return prev === oldPath ? newPath : prev;
        if (prev === oldPath || prev.startsWith(oldPath + "\\") || prev.startsWith(oldPath + "/")) {
          return newPath + prev.slice(oldPath.length);
        }
        return prev;
      });
    },
    []
  );

  /** Close tabs that point at a path removed by the explorer (folder = prefix). */
  const handlePathDeleted = useCallback(
    (path: string, isDir: boolean) => {
      setOpenFiles((prev) => {
        const next = prev.filter((f) =>
          isDir
            ? !(f.path === path || f.path.startsWith(path + "\\") || f.path.startsWith(path + "/"))
            : f.path !== path
        );
        setActivePath((cur) =>
          cur && !next.find((f) => f.path === cur)
            ? next.length
              ? next[next.length - 1].path
              : null
            : cur
        );
        return next;
      });
    },
    []
  );

  // Bottom-panel drag-to-reposition — same press-and-hold model as the activity
  // bar: hold DRAG_HOLD_MS to arm (charging ring + grabbing cursor), then it docks
  // bottom/right/left in real time; dropping outside snaps back.
  const [draggingPanel, setDraggingPanel] = useState(false);
  const [armingPanel, setArmingPanel] = useState(false);
  const startPanelDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const origPos = panelPos;
      let armed = false;

      setArmingPanel(true);
      const arm = () => {
        armed = true;
        setArmingPanel(false);
        setDraggingPanel(true);
      };
      const holdTimer = window.setTimeout(arm, DRAG_HOLD_MS);
      const cancelHold = () => {
        window.clearTimeout(holdTimer);
        setArmingPanel(false);
      };

      const onMove = (me: PointerEvent) => {
        if (!armed) {
          if (Math.hypot(me.clientX - startX, me.clientY - startY) > 24) cancelHold();
          return;
        }
        setPanelPos(panelZoneAtPoint(me.clientX, me.clientY) ?? origPos);
      };
      const onUp = () => {
        cancelHold();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (armed) {
          setDraggingPanel(false);
          const swallow = (ce: MouseEvent) => {
            ce.stopPropagation();
            ce.preventDefault();
          };
          window.addEventListener("click", swallow, { capture: true, once: true });
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [panelPos]
  );

  /** Open/focus the integrated terminal at `cwd` (explorer "Abrir no Terminal"). */
  const handleOpenTerminalAt = useCallback((cwd: string, connId?: string) => {
    setTerminalOpenCwd(cwd);
    setTerminalOpenConnId(connId ?? null);
    setTerminalOpenNonce((n) => n + 1);
    setPanelOpen(true);
  }, []);

  /** Open/focus the search panel scoped to `folderPath` (explorer "Localizar na pasta"). */
  const handleFindInFolder = useCallback((folderPath: string, rootId?: string) => {
    setSearchScope({ path: folderPath, rootId });
    setActiveView("search");
  }, []);

  // True while we're waiting for the second key of the Ctrl+K chord (e.g. the
  // "O" in the VSCode-style "Ctrl+K Ctrl+O" Open Folder binding).
  const awaitingChordRef = useRef(false);
  const chordTimerRef = useRef<number | null>(null);

  // App-level keyboard shortcuts. These mirror the accelerators shown in the
  // menus (Save, Save As, Open File/Folder, toggles, Quick Open). We deliberately
  // do NOT intercept editor chords (Ctrl+F/H/Z/Y/A/C/V/X) — those belong to
  // Monaco when the editor is focused, so they're left to bubble through.
  useEffect(() => {
    function clearChord() {
      awaitingChordRef.current = false;
      if (chordTimerRef.current != null) {
        window.clearTimeout(chordTimerRef.current);
        chordTimerRef.current = null;
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;

      // --- Ctrl+K chord: arm, then resolve the second stroke. ---
      if (awaitingChordRef.current) {
        // Ctrl+K Ctrl+O → Open Folder. Any other key cancels the chord.
        if (mod && e.key.toLowerCase() === "o") {
          e.preventDefault();
          clearChord();
          handleOpenFolder();
          return;
        }
        clearChord();
        // fall through so a non-chord key still works as its own shortcut
      }
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        awaitingChordRef.current = true;
        if (chordTimerRef.current != null) window.clearTimeout(chordTimerRef.current);
        // Give up on the chord if the next key doesn't arrive promptly.
        chordTimerRef.current = window.setTimeout(() => {
          awaitingChordRef.current = false;
          chordTimerRef.current = null;
        }, 1500);
        return;
      }

      if (!mod) return;

      const key = e.key.toLowerCase();

      // Ctrl+Shift+S → Save As (check before plain Ctrl+S).
      if (e.shiftKey && key === "s") {
        e.preventDefault();
        handleSaveAs();
        return;
      }
      // Ctrl+S → Save.
      if (key === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
      // Ctrl+O → Open File…
      if (key === "o") {
        e.preventDefault();
        handleOpenFileDialog();
        return;
      }
      // Ctrl+N → New Text File (untitled buffer). Shift is left to the WebView.
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        handleNewTextFile();
        return;
      }
      // Ctrl+` → toggle terminal panel.
      if (e.key === "`") {
        e.preventDefault();
        setPanelOpen((v) => !v);
        return;
      }
      // Ctrl+B → toggle the sidebar.
      if (key === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }
      // Ctrl+Shift+P → Command Palette (must come before the plain Ctrl+P).
      if (key === "p" && e.shiftKey) {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      // Ctrl+Shift+F → Search across files (opens the Search view).
      if (key === "f" && e.shiftKey) {
        e.preventDefault();
        setActiveView("search");
        setSidebarOpen(true);
        return;
      }
      // Ctrl+P → Quick Open (file search by name).
      if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        setQuickOpenOpen(true);
        return;
      }
      // Ctrl+W → close the active tab (through the unsaved-changes guard).
      if (key === "w") {
        e.preventDefault();
        if (activePathRef.current) handleCloseTab(activePathRef.current);
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearChord();
    };
  }, [handleSave, handleSaveAs, handleOpenFileDialog, handleCloseTab, handleNewTextFile]);

  /** Run a configuration: open the terminal panel and (re)spawn a PTY for it. */
  function handleRun(command: string, cwd?: string, connId?: string) {
    setRunCommand(command);
    setRunCwd(cwd ?? rootPath);
    setRunConnId(connId ?? null);
    setRunNonce((n) => n + 1);
    setPanelOpen(true);
  }

  /** Jump to a problem's file/line, opening the file if needed. */
  function handleOpenProblem(problem: Problem) {
    handleOpenFile(
      {
        name: problem.name,
        path: problem.path,
        isDir: false,
        workspaceRemote: workspaceRemoteForPath(problem.path),
      },
      problem.line
    );
  }

  // Debugger navigation: the DAP session (dap/debugSession.ts) asks the app to
  // reveal where execution stopped / a clicked stack frame. Re-subscribed every
  // render so the handler never closes over a stale open-file flow.
  useEffect(() => {
    const onDebugStopped = (e: Event) => {
      const d = (e as CustomEvent<{ path?: string; line?: number }>).detail;
      if (!d?.path || !d.line) return;
      handleOpenFile(
        {
          name: baseName(d.path),
          path: d.path,
          isDir: false,
          workspaceRemote: workspaceRemoteForPath(d.path),
        },
        d.line
      );
    };
    window.addEventListener("fluent:debug-stopped", onDebugStopped);
    return () => window.removeEventListener("fluent:debug-stopped", onDebugStopped);
  });

  /** Opens the bottom panel focused on a specific tab (e.g. Problems). */
  const showPanelTab = useCallback((tab: PanelTab) => {
    setPanelTab(tab);
    setPanelTabNonce((n) => n + 1);
    setPanelOpen(true);
  }, []);

  /**
   * Lets the user pick which TypeScript version the TS/JS server uses — the
   * project's (recommended when present) or the editor-managed one — then
   * restarts the server so the choice takes effect (VSCode "Select TS Version").
   */
  const handleSelectTsVersion = useCallback(async () => {
    const current: "project" | "editor" =
      (() => {
        try {
          return localStorage.getItem(TS_PREFER_EDITOR_KEY) === "1" ? "editor" : "project";
        } catch {
          return "project";
        }
      })();
    // Fetch the real version numbers (like VS Code shows them in the picker).
    let versions = { project: null as string | null, editor: null as string | null };
    if (rootPath) {
      try {
        versions = await tsVersions(rootPath);
      } catch {
        /* leave nulls — the picker still works, just without numbers */
      }
    }
    const apply = (id: string) => {
      if (id !== "project" && id !== "editor") return;
      try {
        localStorage.setItem(TS_PREFER_EDITOR_KEY, id === "editor" ? "1" : "0");
      } catch {
        /* storage unavailable — ignore */
      }
      restartLsp("typescript");
    };
    setQuickPick({
      title: "Selecionar versão do TypeScript",
      placeholder: "Qual TypeScript usar nas linguagens TS/JS…",
      items: [
        {
          id: "project",
          label: `Versão do projeto${current === "project" ? " (atual)" : ""}`,
          detail: versions.project
            ? `TypeScript ${versions.project} · node_modules/typescript`
            : "Nenhuma no projeto — usa a do editor como fallback",
          icon: current === "project" ? "success" : "folder",
          pinned: true,
          keywords: "recomendado workspace projeto",
        },
        {
          id: "editor",
          label: `Versão do editor${current === "editor" ? " (atual)" : ""}`,
          detail: versions.editor
            ? `TypeScript ${versions.editor} · gerenciada pelo Fluent Coder`
            : "Gerenciada pelo Fluent Coder (mais recente)",
          icon: current === "editor" ? "success" : "settings",
          keywords: "global editor mais recente",
        },
      ],
      onPick: (it) => apply(it.id),
    });
  }, [rootPath, restartLsp]);

  // "Change Language Mode" (VS Code): click the language in the status bar to pick
  // the active file's language — e.g. TypeScript ↔ TypeScript JSX. The choice is
  // stored as a per-file override (so the status bar + LSP follow it) and applied
  // to the live Monaco model so highlighting/IntelliSense switch immediately.
  const handleSelectLanguageMode = useCallback(() => {
    if (!activeFile) return;
    const file = activeFile;
    const modelUri = file.path.startsWith("untitled:")
      ? file.path
      : toFileUri(file.path);
    const detected = languageForFile(file.name); // extension-based, ignores override
    const current = languageForFile(file.name, file.path); // honors override

    // Full list from Monaco's registry (includes our tsx/jsx/razor/csharp ids),
    // filterable like VS Code. `plaintext` is offered explicitly below.
    const langItems: QuickPickItem[] = monaco.languages
      .getLanguages()
      .filter((l) => l.id && l.id !== "plaintext")
      .map((l): QuickPickItem => {
        const ext = l.extensions?.[0];
        // A representative file name so the Material theme resolves the language's
        // file-type icon (".tsx" → React TS icon, "Dockerfile" → docker, …).
        const sample = ext ? `x${ext}` : l.filenames?.[0];
        const exts = l.extensions?.join(" ");
        const isCurrent = l.id === current;
        return {
          id: l.id,
          label: languageLabel(l.id, l.aliases) + (isCurrent ? "  (atual)" : ""),
          description: exts || undefined,
          iconFile: sample,
          icon: sample ? undefined : "file",
          keywords: `${l.aliases?.join(" ") ?? ""} ${exts ?? ""}`,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label, "pt"));

    const items: QuickPickItem[] = [
      {
        id: "__auto__",
        label: "Detecção Automática",
        description: `→ ${languageLabel(detected)}`,
        icon: "hint",
        pinned: true,
        keywords: "auto detect automatico extensao redefinir",
      },
      {
        id: "plaintext",
        label:
          languageLabel("plaintext") +
          (current === "plaintext" ? "  (atual)" : ""),
        icon: "file",
        keywords: "texto plano plaintext sem formatacao",
      },
      ...langItems,
    ];

    setQuickPick({
      title: "Selecionar Modo de Linguagem",
      placeholder: `Linguagem para ${file.name}…`,
      items,
      onPick: (it) => {
        const isAuto = it.id === "__auto__";
        const langId = isAuto ? detected : it.id;
        setLanguageOverride(file.path, isAuto ? null : langId);
        setLanguageOverrides((prev) => {
          const next = { ...prev };
          if (isAuto) delete next[file.path];
          else next[file.path] = langId;
          return next;
        });
        const model = monaco.editor.getModel(monaco.Uri.parse(modelUri));
        if (model && model.getLanguageId() !== langId) {
          monaco.editor.setModelLanguage(model, langId);
        }
      },
    });
  }, [activeFile]);

  /**
   * "Reopen with Encoding" (VS Code): re-decode the file on disk forcing the
   * chosen encoding and replace the buffer. Only for saved local files — a
   * dirty buffer would lose edits (we warn), and remote/untitled have no path
   * to re-read.
   */
  const handleSelectEncoding = useCallback(() => {
    if (!activeFile || isUntitled(activeFile.path)) return;
    const file = activeFile;
    const items: QuickPickItem[] = COMMON_ENCODINGS.map((enc) => ({
      id: enc.id,
      label: enc.label + (file.encoding === enc.id ? "  (atual)" : ""),
      icon: "file",
      keywords: enc.id,
    }));
    setQuickPick({
      title: "Reabrir com Codificação",
      placeholder: `Codificação para ${file.name}…`,
      items,
      onPick: async (it) => {
        if (file.dirty) {
          const ok = window.confirm(
            "Reabrir com outra codificação descarta as alterações não salvas deste arquivo. Continuar?"
          );
          if (!ok) return;
        }
        try {
          const decoded = await readFileWithEncoding(file.path, it.id);
          setLayout((l) =>
            patchFileEverywhere(l, file.path, {
              content: decoded.content,
              encoding: decoded.encoding,
              bom: decoded.bom,
              eol: decoded.eol,
              dirty: false,
            })
          );
        } catch (err) {
          alert(`Não foi possível reabrir com ${it.id}:\n${err}`);
        }
      },
    });
  }, [activeFile]);

  /**
   * Changes the active file's line ending (LF/CRLF). The buffer stays LF in
   * memory; we record the choice and mark the file dirty so the next save
   * re-applies it on disk.
   */
  const handleSelectEol = useCallback(() => {
    if (!activeFile) return;
    const file = activeFile;
    const items: QuickPickItem[] = (["Lf", "Crlf"] as const).map((id) => ({
      id,
      label: (id === "Lf" ? "LF" : "CRLF") + (file.eol === id ? "  (atual)" : ""),
      description: id === "Lf" ? "\\n (Unix/macOS)" : "\\r\\n (Windows)",
      icon: "textEditor",
      keywords: id,
    }));
    setQuickPick({
      title: "Selecionar Fim de Linha",
      placeholder: "Estilo de quebra de linha…",
      items,
      onPick: (it) => {
        const eol = it.id as OpenFile["eol"];
        if (file.eol === eol) return;
        setLayout((l) => patchFileEverywhere(l, file.path, { eol, dirty: true }));
      },
    });
  }, [activeFile]);

  // True when there's an active editor buffer; gates Edit/Selection/Go items.
  const hasEditor = activeFile != null;

  /** Fire a Monaco editor action by id on the focused editor (no-op if none). */
  const runEditorAction = useCallback((id: string) => {
    editorActionsRef.current?.run(id);
  }, []);

  // Data-driven menu bar definitions (File, Edit, …). Rebuilt only when the
  // inputs the items capture change (handlers are stable; flags are reactive).
  const menus: MenuDef[] = useMemo(() => {
    const fileMenu: MenuDef = {
      label: "Arquivo",
      items: [
        {
          id: "file.newTextFile",
          label: "Novo Arquivo de Texto",
          accelerator: "Ctrl+N",
          run: handleNewTextFile,
        },
        { id: "file.newFile", label: "Novo Arquivo", run: handleNewTextFile },
        {
          id: "file.newWindow",
          label: "Nova Janela",
          run: handleNewWindow,
        },
        {
          id: "file.newWorkspace",
          label: "Novo Workspace",
          run: handleNewWorkspace,
        },
        { id: "file.sep1", label: "", separator: true },
        {
          id: "file.open",
          label: "Abrir Arquivo…",
          accelerator: "Ctrl+O",
          run: handleOpenFileDialog,
        },
        {
          id: "file.openFolder",
          label: "Abrir Pasta…",
          accelerator: "Ctrl+K Ctrl+O",
          run: handleOpenFolder,
        },
        {
          id: "file.openWorkspace",
          label: "Abrir Workspace…",
          run: () => {
            void (async () => {
              if (await guardDirtyWorkspace()) await handleOpenWorkspace();
            })();
          },
        },
        {
          id: "file.addFolderToWorkspace",
          label: "Adicionar Pasta ao Workspace…",
          enabled: rootPath != null || activeWorkspace != null,
          run:
            rootPath != null || activeWorkspace != null
              ? handleAddFolderToWorkspace
              : undefined,
        },
        {
          id: "file.addSshFolderToWorkspace",
          label: "Adicionar Pasta SSH ao Workspace…",
          enabled: rootPath != null || activeWorkspace != null,
          run:
            rootPath != null || activeWorkspace != null
              ? handleAddSshFolderToWorkspace
              : undefined,
        },
        {
          id: "file.saveWorkspace",
          label: activeWorkspace?.dirty ? "Salvar Workspace*" : "Salvar Workspace",
          enabled: rootPath != null || activeWorkspace != null,
          run: rootPath != null || activeWorkspace != null ? handleSaveWorkspace : undefined,
        },
        {
          id: "file.saveWorkspaceAs",
          label: "Salvar Workspace Como…",
          enabled: rootPath != null || activeWorkspace != null,
          run: rootPath != null || activeWorkspace != null ? handleSaveWorkspaceAs : undefined,
        },
        { id: "file.sep2", label: "", separator: true },
        {
          id: "file.save",
          label: "Salvar",
          accelerator: "Ctrl+S",
          enabled: hasEditor,
          run: hasEditor ? handleSave : undefined,
        },
        {
          id: "file.saveAs",
          label: "Salvar Como…",
          accelerator: "Ctrl+Shift+S",
          enabled: hasEditor,
          run: hasEditor ? handleSaveAs : undefined,
        },
        { id: "file.sep3", label: "", separator: true },
        { id: "file.autoSave", label: "Salvamento Automático", enabled: false },
        { id: "file.revert", label: "Reverter Arquivo", enabled: false },
        { id: "file.sep4", label: "", separator: true },
        {
          id: "file.closeEditor",
          label: "Fechar Editor",
          enabled: hasEditor,
          run: hasEditor && activePath ? () => handleCloseTab(activePath) : undefined,
        },
        {
          id: "file.closeFolder",
          label: "Fechar Pasta",
          enabled: rootPath != null,
          run: rootPath != null ? handleCloseFolder : undefined,
        },
        {
          id: "file.closeWorkspace",
          label: "Fechar Workspace",
          enabled: rootPath != null || activeWorkspace != null,
          run: rootPath != null || activeWorkspace != null ? handleCloseFolder : undefined,
        },
        {
          id: "file.disconnectRemote",
          label: "Desconectar do Host Remoto",
          enabled: remoteSession != null,
          run: remoteSession != null ? handleCloseFolder : undefined,
        },
        {
          id: "file.closeWindow",
          label: "Fechar Janela",
          accelerator: "Alt+F4",
          run: () => getCurrentWindow().close(),
        },
        { id: "file.sep5", label: "", separator: true },
        { id: "file.exit", label: "Sair", run: () => getCurrentWindow().close() },
      ],
    };

    const editMenu: MenuDef = {
      label: "Editar",
      items: [
        {
          id: "edit.undo",
          label: "Desfazer",
          accelerator: "Ctrl+Z",
          enabled: hasEditor,
          run: hasEditor ? () => runEditorAction("undo") : undefined,
        },
        {
          id: "edit.redo",
          label: "Refazer",
          accelerator: "Ctrl+Y",
          enabled: hasEditor,
          run: hasEditor ? () => runEditorAction("redo") : undefined,
        },
        { id: "edit.sep1", label: "", separator: true },
        {
          id: "edit.cut",
          label: "Recortar",
          accelerator: "Ctrl+X",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.clipboardCutAction")
            : undefined,
        },
        {
          id: "edit.copy",
          label: "Copiar",
          accelerator: "Ctrl+C",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.clipboardCopyAction")
            : undefined,
        },
        {
          id: "edit.paste",
          label: "Colar",
          accelerator: "Ctrl+V",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.clipboardPasteAction")
            : undefined,
        },
        { id: "edit.sep2", label: "", separator: true },
        {
          id: "edit.find",
          label: "Localizar",
          accelerator: "Ctrl+F",
          enabled: hasEditor,
          run: hasEditor ? () => runEditorAction("actions.find") : undefined,
        },
        {
          id: "edit.replace",
          label: "Substituir",
          accelerator: "Ctrl+H",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.startFindReplaceAction")
            : undefined,
        },
        { id: "edit.sep3", label: "", separator: true },
        {
          id: "edit.findInFiles",
          label: "Localizar nos Arquivos",
          run: () => setActiveView("search"),
        },
      ],
    };

    const selectionMenu: MenuDef = {
      label: "Seleção",
      items: [
        {
          id: "selection.selectAll",
          label: "Selecionar Tudo",
          accelerator: "Ctrl+A",
          enabled: hasEditor,
          run: hasEditor ? () => runEditorAction("editor.action.selectAll") : undefined,
        },
        {
          id: "selection.expand",
          label: "Expandir Seleção",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.smartSelect.expand")
            : undefined,
        },
        {
          id: "selection.shrink",
          label: "Reduzir Seleção",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.smartSelect.shrink")
            : undefined,
        },
        { id: "selection.sep1", label: "", separator: true },
        {
          id: "selection.copyLineUp",
          label: "Copiar Linha Acima",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.copyLinesUpAction")
            : undefined,
        },
        {
          id: "selection.copyLineDown",
          label: "Copiar Linha Abaixo",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.copyLinesDownAction")
            : undefined,
        },
        {
          id: "selection.moveLineUp",
          label: "Mover Linha Acima",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.moveLinesUpAction")
            : undefined,
        },
        {
          id: "selection.moveLineDown",
          label: "Mover Linha Abaixo",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.moveLinesDownAction")
            : undefined,
        },
        { id: "selection.sep2", label: "", separator: true },
        {
          id: "selection.addCursorAbove",
          label: "Adicionar Cursor Acima",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.insertCursorAbove")
            : undefined,
        },
        {
          id: "selection.addCursorBelow",
          label: "Adicionar Cursor Abaixo",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.insertCursorBelow")
            : undefined,
        },
      ],
    };

    const viewMenu: MenuDef = {
      label: "Exibir",
      items: [
        { id: "view.explorer", label: "Explorador", run: () => setActiveView("explorer") },
        { id: "view.search", label: "Pesquisar", run: () => setActiveView("search") },
        {
          id: "view.scm",
          label: "Controle do Código-Fonte",
          run: () => setActiveView("git"),
        },
        { id: "view.run", label: "Executar", run: () => setActiveView("debug") },
        { id: "view.graph", label: "Grafo de Contextos", run: handleShowGraph },
        {
          id: "view.mcp",
          label: "Conectar cérebro ao Claude Code (MCP)…",
          run: () => void handleShowMcpConfig(),
        },
        {
          id: "view.contextBundle",
          label: "Copiar pacote de contexto (arquivo atual)",
          run: () => void handleCopyContextBundle(),
        },
        { id: "view.sep1", label: "", separator: true },
        {
          id: "view.toggleSidebar",
          label: "Alternar Barra Lateral",
          accelerator: "Ctrl+B",
          run: () => setSidebarOpen((v) => !v),
        },
        {
          id: "view.moveSidebar",
          label:
            sidebarSide === "left"
              ? "Mover barra lateral para a direita"
              : "Mover barra lateral para a esquerda",
          run: () => setSidebarSide((s) => (s === "left" ? "right" : "left")),
        },
        {
          id: "view.activityBarPos",
          label: `Barra de atividades: ${
            activityBarPos === "side"
              ? "à direita do Explorador"
              : activityBarPos === "right"
                ? "abaixo do Explorador"
                : activityBarPos === "bottom"
                  ? "no topo do Explorador"
                  : "à esquerda do Explorador"
          }`,
          run: () =>
            setActivityBarPos((p) =>
              p === "side" ? "right" : p === "right" ? "bottom" : p === "bottom" ? "top" : "side"
            ),
        },
        {
          id: "view.toggleTerminal",
          label: "Alternar Terminal",
          accelerator: "Ctrl+`",
          run: () => setPanelOpen((v) => !v),
        },
        { id: "view.sep2", label: "", separator: true },
        {
          id: "view.commandPalette",
          label: "Paleta de Comandos…",
          accelerator: "Ctrl+Shift+P",
          run: () => setCommandPaletteOpen(true),
        },
        {
          id: "view.quickOpen",
          label: "Abertura Rápida",
          accelerator: "Ctrl+P",
          run: () => setQuickOpenOpen(true),
        },
      ],
    };

    const goMenu: MenuDef = {
      label: "Ir",
      items: [
        {
          id: "go.goToFile",
          label: "Ir para o Arquivo…",
          accelerator: "Ctrl+P",
          run: () => setQuickOpenOpen(true),
        },
        {
          id: "go.goToLine",
          label: "Ir para a Linha…",
          accelerator: "Ctrl+G",
          enabled: hasEditor,
          run: hasEditor ? () => runEditorAction("editor.action.gotoLine") : undefined,
        },
        {
          id: "go.goToDefinition",
          label: "Ir para a Definição",
          accelerator: "F12",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.revealDefinition")
            : undefined,
        },
      ],
    };

    const runMenu: MenuDef = {
      label: "Executar",
      items: [
        { id: "run.start", label: "Iniciar Depuração", enabled: false },
        { id: "run.startNoDebug", label: "Executar Sem Depuração", enabled: false },
        { id: "run.sep1", label: "", separator: true },
        {
          id: "run.openRunView",
          label: "Abrir Executar e Depurar",
          run: () => setActiveView("debug"),
        },
      ],
    };

    const terminalMenu: MenuDef = {
      label: "Terminal",
      items: [
        {
          id: "terminal.new",
          label: "Novo Terminal",
          accelerator: "Ctrl+`",
          run: () => setPanelOpen(true),
        },
        { id: "terminal.split", label: "Dividir Terminal", enabled: false },
        { id: "terminal.kill", label: "Encerrar Terminal", enabled: false },
        { id: "terminal.sep1", label: "", separator: true },
        { id: "terminal.runTask", label: "Executar Tarefa…", enabled: false },
      ],
    };

    const helpMenu: MenuDef = {
      label: "Ajuda",
      items: [
        { id: "help.welcome", label: "Bem-vindo", enabled: false },
        { id: "help.docs", label: "Documentação", enabled: false },
        { id: "help.sep1", label: "", separator: true },
        {
          id: "help.keyboardShortcuts",
          label: "Atalhos de Teclado",
          accelerator: "Ctrl+K Ctrl+S",
          run: () => setHelpDialog("shortcuts"),
        },
        { id: "help.sep2", label: "", separator: true },
        { id: "help.about", label: "Sobre", run: () => setHelpDialog("about") },
      ],
    };

    return [
      fileMenu,
      editMenu,
      selectionMenu,
      viewMenu,
      goMenu,
      runMenu,
      terminalMenu,
      helpMenu,
    ];
  }, [
    hasEditor,
    rootPath,
    activeWorkspace,
    remoteSession,
    activePath,
    handleOpenFileDialog,
    handleOpenFolder,
    handleOpenWorkspace,
    handleNewWorkspace,
    handleAddFolderToWorkspace,
    handleAddSshFolderToWorkspace,
    handleSaveWorkspace,
    handleSaveWorkspaceAs,
    guardDirtyWorkspace,
    handleSave,
    handleSaveAs,
    handleCloseTab,
    handleCloseFolder,
    handleNewWindow,
    handleNewTextFile,
    runEditorAction,
    openSshFlow,
    sidebarSide,
    activityBarPos,
    handleShowGraph,
    handleShowMcpConfig,
    handleCopyContextBundle,
  ]);

  // Full command-palette list (issue #12 + #8): the curated commands + the
  // remote-SSH entry + every runnable menu action, in the palette's shape.
  const paletteCommands = useMemo<Command[]>(() => {
    const fromMenus: Command[] = menus.flatMap((menu) =>
      menu.items
        .filter((it) => it.run && !it.separator && it.enabled !== false)
        .map((it) => ({
          id: `menu.${it.id}`,
          title: it.label,
          detail: menu.label,
          run: it.run as () => void,
        }))
    );
    const ssh: Command[] = [
      {
        id: "ssh.connect",
        title: "Conectar a Host SSH…",
        detail: "Remoto",
        run: () => void openSshFlow(),
      },
    ];
    return [...commands, ...ssh, ...fromMenus];
  }, [commands, menus, openSshFlow]);

  const titleWorkspaceSegment = workspaceContextDisplay
    ? workspaceContextDisplay.name
    : rootPath
      ? baseName(rootPath)
      : null;
  const titleText = activeFile
    ? `${activeFile.dirty ? "● " : ""}${activeFile.name}${
        titleWorkspaceSegment ? ` — ${titleWorkspaceSegment}` : ""
      } — Fluent Coder`
    : `${titleWorkspaceSegment ? `${titleWorkspaceSegment} — ` : ""}Fluent Coder`;
  const activityBarHorizontal = activityBarPos === "top" || activityBarPos === "bottom";
  const activityIndicatorSide =
    activityBarPos === "right" ? "right" : sidebarSide;
  const effectiveSidebarWidth = activityBarHorizontal
    ? Math.max(sidebarWidth, SIDEBAR_MIN_HORIZONTAL_ACTIVITY)
    : sidebarWidth;
  const primaryDockStyle: CSSProperties | undefined = activityBarHorizontal
    ? {
        width: effectiveSidebarWidth,
        height: sidebarOpen ? "100%" : undefined,
        alignSelf: sidebarOpen ? "stretch" : undefined,
      }
    : undefined;

  /** Pick which sidebar view the activity bar selection maps to. */
  function renderSidebar() {
    switch (activeView) {
      case "search":
        return (
          <SearchPanel
            rootPath={rootPath}
            workspaceRoots={explorerWorkspaceRoots}
            scopePath={searchScope?.path ?? null}
            scopeRootId={searchScope?.rootId ?? null}
            onClearScope={() => setSearchScope(null)}
            onOpenMatch={handleOpenMatch}
          />
        );
      case "explorer":
        return (
          <FileExplorer
            rootName={activeWorkspace?.name?.toUpperCase() ?? rootName}
            rootPath={rootPath}
            roots={roots}
            workspaceRoots={explorerWorkspaceRoots}
            isWorkspace={explorerIsWorkspace}
            activePath={activePath}
            onOpenFile={handleOpenFile}
            onRefreshRoot={refreshExplorerRoot}
            decorationFor={decorationFor}
            onPathRenamed={handlePathRenamed}
            onPathDeleted={handlePathDeleted}
            onOpenTerminalAt={handleOpenTerminalAt}
            onFindInFolder={handleFindInFolder}
            onRenameWorkspaceRoot={handleRenameWorkspaceRoot}
            onRemoveWorkspaceRoot={handleRemoveWorkspaceRoot}
            onConnectWorkspaceRoot={handleConnectWorkspaceRoot}
            onDisconnectWorkspaceRoot={handleDisconnectWorkspaceRoot}
            onAddFolderToWorkspace={handleAddFolderToWorkspace}
            onAddSshFolderToWorkspace={handleAddSshFolderToWorkspace}
            advancedActions={explorerAdvancedActions}
            changedPaths={changedPaths}
          />
        );
      case "git":
        return (
          <GitPanel
            rootPath={rootPath}
            workspaceRoots={explorerWorkspaceRoots}
            onOpenFile={(path, name) =>
              handleOpenFile({ name, path, isDir: false })
            }
            onOpenChanges={handleOpenGitFileChanges}
            onOpenRevision={(filePath, commitHash, shortHash, repoRootPath, connId) =>
              void handleOpenGitRevision(filePath, commitHash, shortHash, repoRootPath, connId)
            }
            onOpenRevisionDiff={(filePath, commitHash, shortHash, compareTo, repoRootPath, connId) =>
              void handleOpenGitRevisionDiff(filePath, commitHash, shortHash, compareTo, repoRootPath, connId)
            }
            historyFile={historyFile}
            historyTarget={historyTarget}
            onClearHistoryFile={() => {
              setHistoryFile(null);
              setHistoryTarget(null);
            }}
            onOpenLocalFolderInCurrentWindow={(path) => void openLocalFolderInPlace(path)}
            onOpenLocalFolderInNewWindow={handleOpenLocalFolderInNewWindow}
            gitAssistant={handleGitAssist}
            gitAssistPreferences={DEFAULT_GIT_ASSIST_PREFERENCES}
          />
        );
      case "debug":
        return (
          <RunPanel
            rootPath={rootPath}
            workspaceRoots={explorerWorkspaceRoots}
            onRun={handleRun}
          />
        );
      case "packages":
        return <PackagesPanel rootPath={rootPath} workspaceRoots={explorerWorkspaceRoots} />;
      case "graph":
        return (
          <BacklinksPanel
            rootPath={activeContextTarget?.rootPath ?? null}
            connId={activeContextTarget?.connId ?? null}
            activePath={lastRealFile}
            deferLoadMs={220}
            onOpenFile={(p) =>
              handleOpenFile({
                name: baseName(p),
                path: p,
                isDir: false,
                workspaceRemote: activeContextTarget?.workspaceRemote,
              })
            }
          />
        );
      case "account":
        return <PlaceholderPanel title="Contas" />;
      case "settings":
        return <PlaceholderPanel title="Gerenciar" />;
      default:
        return (
          <FileExplorer
            rootName={activeWorkspace?.name?.toUpperCase() ?? rootName}
            rootPath={rootPath}
            roots={roots}
            workspaceRoots={explorerWorkspaceRoots}
            isWorkspace={explorerIsWorkspace}
            activePath={activePath}
            onOpenFile={handleOpenFile}
            onRefreshRoot={refreshExplorerRoot}
            decorationFor={decorationFor}
            onPathRenamed={handlePathRenamed}
            onPathDeleted={handlePathDeleted}
            onOpenTerminalAt={handleOpenTerminalAt}
            onFindInFolder={handleFindInFolder}
            onRenameWorkspaceRoot={handleRenameWorkspaceRoot}
            onRemoveWorkspaceRoot={handleRemoveWorkspaceRoot}
            onConnectWorkspaceRoot={handleConnectWorkspaceRoot}
            onDisconnectWorkspaceRoot={handleDisconnectWorkspaceRoot}
            onAddFolderToWorkspace={handleAddFolderToWorkspace}
            onAddSshFolderToWorkspace={handleAddSshFolderToWorkspace}
            advancedActions={explorerAdvancedActions}
            changedPaths={changedPaths}
          />
        );
    }
  }

  // The home / welcome screen shown by any empty editor group.
  const welcomeNode = (
    <WelcomeScreen
      hasFolder={rootPath != null || activeWorkspace != null}
      folderName={rootPath ? baseName(rootPath) : null}
      folderPath={rootPath}
      workspaceName={workspaceContextDisplay?.name ?? null}
      recents={recents}
      onNewFile={handleNewTextFile}
      onOpenFile={handleOpenFileDialog}
      onOpenFolder={handleOpenFolder}
      onConnectRemote={() => void openSshFlow()}
      onOpenRecent={handleOpenRecent}
    />
  );

  // Avisos são exibidos apenas na conversa dona (ou em todas, quando globais).
  const activeAgentConversationId =
    agentSelection?.kind === "chat" ? agentSelection.conversationId : null;
  const visibleAgentStatus =
    agentStatus &&
    (agentStatus.conversationId === null ||
      agentStatus.conversationId === activeAgentConversationId)
      ? agentStatus.message
      : null;
  const visibleAgentError =
    agentError &&
    (agentError.conversationId === null ||
      agentError.conversationId === activeAgentConversationId)
      ? agentError.message
      : null;
  const visibleAgentThought =
    agentThought && agentThought.conversationId === activeAgentConversationId
      ? agentThought.text
      : null;

  // The AI agents chat as a self-contained secondary side bar node.
  const agentsSidebarNode = (
    <AgentSidebar
      rootPath={agentWorkspaceRoot}
      store={agentStore}
      selection={agentSelection}
      busy={agentBusy}
      status={visibleAgentStatus}
      thought={visibleAgentThought}
      error={visibleAgentError}
      mode={agentMode}
      onModeChange={setAgentMode}
      onModelChange={handleAgentModelChange}
      readEditorContext={readEditorContext}
      onCreate={handleCreateAgent}
      onSaveAgent={handleSaveAgent}
      onCancelConfig={() => setAgentSelection(null)}
      onSelectAgent={handleSelectAgent}
      onEditAgent={handleEditAgent}
      onDeleteAgent={handleDeleteAgent}
      onNewConversation={handleNewAgentConversation}
      onOpenConversation={handleOpenAgentConversation}
      onRenameConversation={handleRenameConversation}
      onDeleteConversation={handleDeleteConversation}
      onSendMessage={handleSendAgentMessage}
      onStop={handleStopAgent}
      onRevert={handleRevertMessage}
      onOpenFile={(path, line) => void handleOpenAgentFile(path, line)}
    />
  );

  /** Renders one editor group (a leaf of the split grid) with all its handlers
   *  bound to that group's id. The active group also gets the imperative editor
   *  refs (reveal / actions) so go-to-line and the Edit/Selection menus work. */
  function renderGroup(groupId: string) {
    const g = layout.groups[groupId];
    if (!g) return null;
    const groupIsActive = groupId === activeGroupId;
    const activeGroupFile = g.activePath
      ? g.files.find((file) => samePath(file.path, g.activePath ?? ""))
      : undefined;
    return (
      <EditorGroupView
        key={groupId}
        group={g}
        isActive={groupIsActive}
        rootPath={rootPath}
        decorationFor={decorationFor}
        onFocusGroup={() => focusGroup(groupId)}
        onSelect={(p) => selectInGroup(groupId, p)}
        onClose={(p) => handleCloseTab(p, groupId)}
        onCloseAll={() => handleCloseAll(groupId)}
        onCloseOthers={(p) => handleCloseOthers(p, groupId)}
        onCloseLeft={(p) => handleCloseLeft(p, groupId)}
        onCloseRight={(p) => handleCloseRight(p, groupId)}
        onReorder={(from, to, before) =>
          reorderTabsInGroup(groupId, from, to, before)
        }
        externalDragActive={tabDragging}
        onTabStripDrop={(payload, targetPath, before) =>
          handleTabStripDrop(groupId, payload, targetPath, before)
        }
        onMoveToNewWindow={(p) => detachFromGroup(groupId, p)}
        onDetach={(p, x, y) => detachFromGroup(groupId, p, x, y)}
        onSplit={(edge) => splitGroupOnEdge(groupId, edge)}
        onChange={(v) => editInGroup(groupId, v)}
        onCursorChange={
          groupIsActive
            ? (l, c) => {
                setCursorLine(l);
                setCursorCol(c);
              }
            : () => {}
        }
        onProblemsChange={groupIsActive ? setProblems : () => {}}
        onOpenDefinition={(path, line) => {
          const activeRemote = activeGroupFile?.workspaceRemote;
          const workspaceRemote =
            activeRemote && pathWithinRoot(path, activeRemote.rootPath)
              ? activeRemote
              : workspaceRemoteForPath(path);
          handleOpenFile({ name: baseName(path), path, isDir: false, workspaceRemote }, line);
        }}
        onShowFileHistory={handleFileHistory}
        onOpenRevision={(filePath, commitHash, shortHash) =>
          void handleOpenGitRevision(filePath, commitHash, shortHash)
        }
        onOpenRevisionDiff={(filePath, commitHash, shortHash, compareTo) =>
          void handleOpenGitRevisionDiff(filePath, commitHash, shortHash, compareTo)
        }
        onCurrentBlameChange={
          groupIsActive
            ? (hunk, filePath) => {
                setCurrentLineBlame(hunk && filePath ? { hunk, filePath } : null);
              }
            : () => {}
        }
        revealRef={groupIsActive ? revealRef : undefined}
        pendingReveal={groupIsActive ? pendingReveal : undefined}
        actionsRef={groupIsActive ? editorActionsRef : undefined}
        onTabDrop={(edge, fromGroupId, path) =>
          handleTabDrop(groupId, edge, fromGroupId, path)
        }
        onOpenPath={(p, workspaceRemote) =>
          handleOpenFile({ name: baseName(p), path: p, isDir: false, workspaceRemote })
        }
        graphActivePath={lastRealFile}
        graphRootPath={activeContextTarget?.rootPath ?? rootPath}
        graphConnId={activeContextTarget?.connId ?? null}
        graphWorkspaceRemote={activeContextTarget?.workspaceRemote}
        tabDragging={tabDragging}
        dragSource={
          activeTabDrag
            ? {
                groupId: activeTabDrag.groupId,
                fileCount:
                  layout.groups[activeTabDrag.groupId]?.files.length ?? 0,
              }
            : null
        }
        onTabDragStart={(drag) => {
          setActiveTabDrag(drag);
          setTabDragging(true);
          startDragPoll();
        }}
        onTabDragEnd={() => {
          setActiveTabDrag(null);
          setTabDragging(false);
          stopDragPoll();
          clearDragHint();
        }}
        onDragMove={handleDragMove}
        welcome={welcomeNode}
      />
    );
  }

  return (
    <div className="app">
      <TitleBar
        title={titleText}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((v) => !v)}
        agentsOpen={agentsSidebarOpen}
        onToggleAgents={() => setAgentsSidebarOpen((v) => !v)}
        menus={menus}
      />

      <div
        className={`body${sidebarSide === "right" ? " sidebar-right" : ""}${
          draggingActivity ? " dragging-activity" : ""
        }${armingActivity ? " arming-activity" : ""}`}
      >
        {/* Activity bar + sidebar form one dock so the bar can orbit the
            Explorer: left/default, right, top or bottom. */}
        <div
          className={`primary-dock activity-${activityBarPos}`}
          style={primaryDockStyle}
        >
          <ActivityBar
            activeView={activeView}
            onViewChange={(v) => {
              // The graph is an editor tab paired with the Backlinks sidebar.
              if (v === "graph") handleShowGraph();
              else {
                setActiveView(v);
                // Picking a view always reveals the primary sidebar.
                setSidebarOpen(true);
              }
            }}
            side={activityIndicatorSide}
            orientation={activityBarHorizontal ? "horizontal" : "vertical"}
            horizontalEdge={activityBarPos === "bottom" ? "bottom" : "top"}
            onToggleSide={() =>
              setSidebarSide((s) => (s === "left" ? "right" : "left"))
            }
            onDragStart={startActivityDrag}
          />

          {sidebarOpen && (
            <aside
              className="sidebar"
              style={{
                width: effectiveSidebarWidth,
              }}
            >
              {renderSidebar()}
            </aside>
          )}
        </div>

        {sidebarOpen && (
          <div
            className="sidebar-resize-handle"
            title="Arraste para redimensionar a barra lateral"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              const startX = e.clientX;
              // Top/bottom activity bars need a wider floor so the explorer
              // can't shrink past the icon strip around it.
              const minW =
                activityBarHorizontal ? SIDEBAR_MIN_HORIZONTAL_ACTIVITY : SIDEBAR_MIN;
              const startW = Math.max(sidebarWidth, minW);
              const onMove = (me: PointerEvent) => {
                const delta = me.clientX - startX;
                // Docked right, dragging left widens the sidebar.
                const signed = sidebarSide === "right" ? -delta : delta;
                setSidebarWidth(
                  Math.max(minW, Math.min(startW + signed, window.innerWidth * 0.6))
                );
              };
              const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
            }}
          />
        )}

        <main
          className="app-main"
          // Interacting with the main editor area (tabs/breadcrumbs/editor)
          // makes THIS window the active group again, so subsequent opens land
          // here. Clicking the sidebar/explorer (outside <main>) does NOT, so a
          // detached group stays active while you pick its next file.
          onMouseDownCapture={() => void clearActiveEditor()}
        >
          {/* Editor + bottom panel. The panel can dock bottom (column) or to a
              side (row); the dock class flips the axis and the handle/orientation. */}
          <div
            className={`editor-area panel-${panelPos}${
              draggingPanel ? " dragging-panel" : ""
            }${armingPanel ? " arming-panel" : ""}`}
          >
            <div className="editor-host">
              <EditorGrid
                node={layout.root}
                renderGroup={renderGroup}
                onResize={resizeGroupBranch}
              />
            </div>
            {panelOpen && (
              <div
                className="panel-resize-handle"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const startX = e.clientX;
                  const startY = e.clientY;
                  const startH = panelHeight;
                  const startW = panelWidth;
                  const onMove = (me: PointerEvent) => {
                    if (panelPos === "bottom") {
                      const delta = startY - me.clientY;
                      setPanelHeight(
                        Math.max(80, Math.min(startH + delta, window.innerHeight * 0.7))
                      );
                    } else {
                      // Right: drag left widens; left: drag right widens.
                      const delta =
                        panelPos === "right" ? startX - me.clientX : me.clientX - startX;
                      setPanelWidth(
                        Math.max(180, Math.min(startW + delta, window.innerWidth * 0.7))
                      );
                    }
                  };
                  const onUp = () => {
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                  };
                  window.addEventListener("pointermove", onMove);
                  window.addEventListener("pointerup", onUp);
                }}
              />
            )}
            {/* Always mounted (hidden when closed) so terminals keep running when
                the panel is minimized — sessions die only on close or app exit. */}
            <TerminalPanel
              open={panelOpen}
              height={panelHeight}
              width={panelWidth}
              pos={panelPos}
              cwd={rootPath}
              onClose={() => setPanelOpen(false)}
              onDragStart={startPanelDrag}
              problems={allProblems}
              onOpenProblem={handleOpenProblem}
              runCommand={runCommand}
              runCwd={runCwd}
              runConnId={runConnId}
              runNonce={runNonce}
              openCwd={terminalOpenCwd}
              openConnId={terminalOpenConnId}
              openNonce={terminalOpenNonce}
              focusTab={panelTab}
              focusNonce={panelTabNonce}
            />
          </div>
        </main>

        {/* Secondary side bar (AI agents chat), docked on the edge OPPOSITE the
            primary sidebar. Flex `order` (see .agents-dock rules) puts it and
            its resize handle on the correct side. */}
        {agentsSidebarOpen && (
          <div
            className={`agents-resize-handle agents-resize-${agentsSide}`}
            title="Arraste para redimensionar o chat"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              const startX = e.clientX;
              const startW = Math.max(agentsSidebarWidth, AGENTS_SIDEBAR_MIN);
              const onMove = (me: PointerEvent) => {
                const delta = me.clientX - startX;
                // Docked left, dragging right widens; docked right, dragging
                // left widens.
                const signed = agentsSide === "left" ? delta : -delta;
                setAgentsSidebarWidth(
                  Math.max(
                    AGENTS_SIDEBAR_MIN,
                    Math.min(startW + signed, window.innerWidth * 0.7),
                  ),
                );
              };
              const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
            }}
          />
        )}
        {agentsSidebarOpen && (
          <aside
            className={`agents-dock agents-dock-${agentsSide}`}
            style={{ width: Math.max(agentsSidebarWidth, AGENTS_SIDEBAR_MIN) }}
          >
            {agentsSidebarNode}
          </aside>
        )}
      </div>

      {/* A tab from another window is hovering over this one. Over a tab strip →
          an insertion bar at the exact spot; elsewhere → a whole-window hint. */}
      {dropHint && <div className="window-drop-hint" aria-hidden="true" />}
      {dropBar && (
        <div
          className="x-insert-bar"
          aria-hidden="true"
          style={{
            left: dropBar.left,
            top: dropBar.top,
            height: dropBar.height,
          }}
        />
      )}

      <StatusBar
        language={
          activeFile ? languageForFile(activeFile.name, activeFile.path) : ""
        }
        line={cursorLine}
        column={cursorCol}
        fileName={activeFile?.name ?? null}
        branch={branch}
        gitStatus={gitState}
        gitBusy={gitBusy}
        autoFetch={autoFetch}
        lastFetch={lastFetch}
        onClickBranch={activeGitTarget ? openActiveBranchPicker : undefined}
        onGitSync={handleGitSync}
        onGitFetch={handleGitFetch}
        onGitPull={handleGitPull}
        onGitPush={handleGitPush}
        onGitPublish={handleGitPublish}
        onToggleAutoFetch={toggleAutoFetch}
        remoteHost={
          activeContextTarget?.workspaceRemote
            ? `${activeContextTarget.workspaceRemote.user}@${activeContextTarget.workspaceRemote.host}`
            : remoteSession
              ? `${remoteSession.user}@${remoteSession.host}`
              : null
        }
        workspaceContext={
          workspaceContextDisplay
            ? {
                name: workspaceContextDisplay.name,
                activeRoot: workspaceContextDisplay.activeRootName,
                activeRootPath: workspaceContextDisplay.activeRootPath,
                folderCount: workspaceContextDisplay.folderCount,
                remote: workspaceContextDisplay.remote,
                branches: workspaceContextDisplay.branches,
              }
            : null
        }
        onSelectWorkspaceBranch={(workspaceRoot) => {
          if (!workspaceRoot.isRepo || !workspaceRoot.path) return;
          setBranchPickerTarget({
            id: workspaceRoot.id,
            rootPath: workspaceRoot.path,
            connId: workspaceRoot.connId,
          });
          setBranchPickerOpen(true);
        }}
        onManageRemote={
          remoteSession && !activeContextTarget?.workspaceRemote
            ? () => setManageMenuOpen(true)
            : undefined
        }
        onOpenRemote={() => void openSshFlow()}
        tabSize={TAB_SIZE}
        errorCount={errorCount}
        warningCount={warningCount}
        lspServers={activeLspServers}
        onRestartLsp={restartLsp}
        onShowProblems={() => showPanelTab("problems")}
        onSelectTsVersion={handleSelectTsVersion}
        onSelectLanguage={activeFile ? handleSelectLanguageMode : undefined}
        currentLineBlame={currentLineBlame}
        onOpenCurrentLineHistory={handleFileHistory}
        onOpenCurrentLineRevision={(filePath, commitHash, shortHash) =>
          void handleOpenGitRevision(filePath, commitHash, shortHash)
        }
        onOpenCurrentLineRevisionDiff={(filePath, commitHash, shortHash, compareTo) =>
          void handleOpenGitRevisionDiff(filePath, commitHash, shortHash, compareTo)
        }
        encoding={activeFile?.encoding ?? null}
        eol={activeFile?.eol ? (activeFile.eol === "Lf" ? "LF" : "CRLF") : null}
        onSelectEncoding={
          // Reopen-with-encoding re-reads from the local FS, so it's offered
          // only for saved local files (not untitled, not remote SSH).
          activeFile &&
          !isUntitled(activeFile.path) &&
          !activeFile.workspaceRemote &&
          !remoteSession
            ? handleSelectEncoding
            : undefined
        }
        onSelectEol={activeFile ? handleSelectEol : undefined}
      />


      {quickOpenOpen && (
        <QuickOpen
          rootPath={rootPath}
          workspaceRoots={explorerWorkspaceRoots}
          onOpenFile={handleOpenFile}
          onClose={() => setQuickOpenOpen(false)}
        />
      )}

      {branchPickerOpen && (
        <BranchPicker
          rootPath={branchPickerGitTarget?.rootPath ?? null}
          connId={branchPickerGitTarget?.connId ?? null}
          onCheckout={handleCheckoutBranch}
          onCreateBranch={handleCreateBranch}
          onClose={() => {
            setBranchPickerOpen(false);
            setBranchPickerTarget(null);
          }}
        />
      )}

      {commandPaletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}

      {sshHostsOpen && (
        <QuickPick
          title="Conectar a um host SSH"
          placeholder="Escolha um host salvo ou adicione um novo…"
          items={[
            {
              id: "__add__",
              label: "Adicionar novo host SSH…",
              icon: "add",
              pinned: true,
            },
            ...sshSavedHosts.map((h, i) => ({
              id: `host-${i}`,
              label: h.label,
              detail: `${h.user ? `${h.user}@` : ""}${h.host}${h.port ? `:${h.port}` : ""}`,
              icon: "remote" as const,
              keywords: `${h.host} ${h.user ?? ""}`,
            })),
          ]}
          onPick={(it) => {
            if (it.id === "__add__") {
              setSshHostsOpen(false);
              setSshFormInitial(undefined);
              setSshDialogOpen(true);
              return;
            }
            const idx = Number.parseInt(it.id.replace("host-", ""), 10);
            const h = sshSavedHosts[idx];
            if (h) pickSavedHost(h);
          }}
          onClose={() => setSshHostsOpen(false)}
        />
      )}

      {quickPick && (
        <QuickPick
          title={quickPick.title}
          placeholder={quickPick.placeholder}
          items={quickPick.items}
          onPick={(it) => {
            quickPick.onPick(it);
            setQuickPick(null);
          }}
          onClose={() => setQuickPick(null)}
        />
      )}

      {sshPasswordFor && (
        <QuickInput
          title={`Senha de ${sshPasswordFor.user}@${sshPasswordFor.host}`}
          placeholder="Senha"
          password
          prompt="Enter para conectar · Esc para cancelar"
          onSubmit={async (password) => {
            const h = sshPasswordFor;
            await connectRemote({
              host: h.host,
              port: h.port ?? 22,
              user: h.user ?? "",
              password,
            });
          }}
          onClose={() => setSshPasswordFor(null)}
        />
      )}

      {sshDialogOpen && (
        <SshConnectDialog
          initial={sshFormInitial}
          onConnect={connectRemote}
          onBack={
            reconnectWorkspaceRootId
              ? undefined
              : () => {
                  // Cancel returns to the host quick-pick (keeps the flow), not closes.
                  setSshDialogOpen(false);
                  setSshFormInitial(undefined);
                  setSshHostsOpen(true);
                }
          }
          onClose={() => {
            setSshDialogOpen(false);
            setSshFormInitial(undefined);
            setReconnectWorkspaceRootId(null);
          }}
        />
      )}

      {remoteBrowser && (
        <RemoteFolderBrowser
          connId={remoteBrowser.connId}
          target={`${remoteBrowser.user}@${remoteBrowser.host}`}
          onPick={(path) => void finalizeRemoteFolder(remoteBrowser, path)}
          onCancel={cancelRemoteBrowser}
        />
      )}

      {manageMenuOpen && remoteSession && (
        <RemoteConnectionMenu
          target={`${remoteSession.user}@${remoteSession.host}`}
          onOpenFolder={() => {
            setManageMenuOpen(false);
            setRemoteBrowser({
              connId: remoteSession.connId,
              host: remoteSession.host,
              user: remoteSession.user,
              input: null,
              mode: "openRemote",
            });
          }}
          onNewTerminal={() => {
            setManageMenuOpen(false);
            handleOpenTerminalAt(remoteSession.rootPath, remoteSession.connId);
          }}
          onReconnect={() => {
            setManageMenuOpen(false);
            void reconnectRemote();
          }}
          onDisconnect={() => {
            setManageMenuOpen(false);
            void handleCloseFolder();
          }}
          onClose={() => setManageMenuOpen(false)}
        />
      )}

      {helpDialog && (
        <AboutDialog mode={helpDialog} onClose={() => setHelpDialog(null)} />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          buttons={confirm.buttons}
          onChoice={(value) => {
            const { resolve } = confirm;
            setConfirm(null);
            resolve(value);
          }}
        />
      )}

      {openWith && (
        <OpenWithPicker
          path={openWith.path}
          x={openWith.x}
          y={openWith.y}
          onPick={(mode) => handleOpenWith(openWith.path, mode)}
          onClose={() => setOpenWith(null)}
        />
      )}
    </div>
  );
}
