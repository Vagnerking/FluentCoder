import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
import { RunPanel, type PendingTest } from "./components/RunPanel";
import { NugetManager } from "./components/NugetManager";
import {
  RUN_TEST_EVENT,
  DEBUG_TEST_EVENT,
  type RunTestEventDetail,
} from "./lsp/csharpTestCodeLensWiring";
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
import { SymbolSearch } from "./components/SymbolSearch";
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
import {
  isCsharpInlayHintsEnabled,
  toggleCsharpInlayHints,
} from "./lsp/csharpInlayHints";
import { getRunningClient, nudgeClientConfiguration } from "./lsp/client";
import { CSHARP_SERVER_ID } from "./lsp/servers/csharp";
import { findNearestEditorConfig } from "./lsp/editorConfig";
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
  gitFetch,
  gitPublish,
  gitPull,
  gitPush,
  gitSnapshotCreate,
  gitSnapshotRestore,
  gitStatus,
  isFreshWindow,
  listProjectFiles,
  dotnetNewList,
  dotnetNewCreate,
  buildContextBundle,
  mcpConfig,
  mcpWriteProjectConfig,
  openNewWindow,
  pickFile,
  pickFolder,
  pickSavePath,
  readDir,
  readFile,
  readFileWithEncoding,
  setExplorerWorkspaceRoot,
  sessionLoad,
  sessionSetLastFolder,
  sessionSetOpenFiles,
  sshConnect,
  sshDisconnect,
  sshListSavedHosts,
  tsVersions,
  clearRemoteTerminals,
  clearRemoteLspServers,
  writeFile,
} from "./api";
import type { SshConnectInput, SavedHost } from "./api";
import {
  getActiveRemote,
  isRemoteActive,
  setActiveRemote,
  type RemoteSession,
} from "./remote/host";
import { loadLastRemoteTarget, saveLastRemoteTarget } from "./remote/persist";
import {
  clearRemoteAttachParam,
  encodeRemoteAttach,
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
import { UI_SCALE_DEFAULT, clampUiScale, stepUiScale } from "./uiScale";
import { buildDecorations, decoKey } from "./icon-theme/decorations";
import { useLspManager } from "./lsp/useLspManager";
import { serverIdForLanguage } from "./lsp/servers";
import { TS_PREFER_EDITOR_KEY } from "./lsp/servers/typescript";
import type {
  ConfirmButton,
  EditorActionsApi,
  FileNode,
  GitStatus,
  MatchSelection,
  MenuDef,
  OpenFile,
  OpenMode,
  OpenTab,
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

/** Returns the last path segment, handling both Windows and POSIX separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Untitled buffers use a synthetic `untitled:<name>` path (never on disk). */
const UNTITLED_PREFIX = "untitled:";

/** Synthetic path of the (single) context-graph tab — never on disk, so it's
 *  excluded from saving and session restore. */
const GRAPH_URI = "fluentcoder://graph";
function isGraphTab(path: string): boolean {
  return path === GRAPH_URI;
}

/** How long the user must press-and-hold a draggable chrome element (activity bar,
 * panel) before the drag arms. A deliberate hold tells "I want to move this" apart
 * from a click; the cursor and a charging ring give feedback while it builds up. */
const DRAG_HOLD_MS = 600;

/** Sidebar width clamps. With the activity bar on TOP it's a horizontal strip of
 * ~6 icons, so the sidebar can't be narrower than that strip — otherwise the
 * explorer keeps shrinking past the icons and the bar is left stranded wider than
 * the explorer below it. Side/hidden modes use the smaller minimum. */
const SIDEBAR_MIN = 180;
const SIDEBAR_MIN_TOP = 280;
// Sidebar secundária (chat de agentes), no lado oposto à principal.
const AGENTS_SIDEBAR_MIN = 320;
const AGENTS_SIDEBAR_DEFAULT = 500;

function isUntitled(path: string): boolean {
  return path.startsWith(UNTITLED_PREFIX);
}

/** Editor tab size — kept in one place so the StatusBar and Monaco agree. */
const TAB_SIZE = 2;

/** Encodings offered in the encoding pickers (reopen / save-with).
 *
 *  `id` is the label passed to the Rust backend (encoding_rs `for_label`) and
 *  MUST equal that encoding's canonical `name()` — otherwise the "(atual)"
 *  marker (which compares against `file.encoding`, set from `name()` on decode)
 *  never matches. Every `id` here is asserted valid + canonical by the
 *  `encoding_labels_are_valid_and_canonical` test in text_io.rs.
 *
 *  Aliases that encoding_rs folds into another codepage are deliberately
 *  omitted (e.g. ISO-8859-1 → windows-1252, ISO-8859-9 → windows-1254,
 *  ISO-8859-11 → windows-874); only the canonical target is listed.
 *
 *  `bom` forces the file's BOM flag on reopen/save (used to split UTF-8 into
 *  "com BOM" / "sem BOM"); when omitted, the BOM is left as detected. */
const COMMON_ENCODINGS: { id: string; label: string; bom?: boolean }[] = [
  { id: "UTF-8", label: "UTF-8", bom: false },
  { id: "UTF-8", label: "UTF-8 com BOM", bom: true },
  // UTF-16 is always written WITH a BOM: a BOM-less UTF-16 file is not
  // recoverable by our detector (it decodes as UTF-8-with-nulls), so saving one
  // would corrupt the round-trip. Matches VS Code, which always BOMs UTF-16.
  { id: "UTF-16LE", label: "UTF-16 LE", bom: true },
  { id: "UTF-16BE", label: "UTF-16 BE", bom: true },
  // Europa Ocidental / Latin. `encoding_rs` folds ISO-8859-1/Latin-1 into
  // windows-1252 (per the WHATWG Encoding Standard), so both entries share the
  // canonical id "windows-1252" — same codepage, two familiar labels.
  { id: "windows-1252", label: "Windows 1252 (Europa Ocidental)" },
  { id: "windows-1252", label: "ISO 8859-1 (Latin-1)" },
  { id: "ISO-8859-15", label: "ISO 8859-15 (Latin-9)" },
  { id: "macintosh", label: "Macintosh (Roman)" },
  // Europa Central
  { id: "windows-1250", label: "Windows 1250 (Europa Central)" },
  { id: "ISO-8859-2", label: "ISO 8859-2 (Latin-2)" },
  // Cirílico
  { id: "windows-1251", label: "Windows 1251 (Cirílico)" },
  { id: "ISO-8859-5", label: "ISO 8859-5 (Cirílico)" },
  { id: "KOI8-R", label: "KOI8-R (Russo)" },
  { id: "KOI8-U", label: "KOI8-U (Ucraniano)" },
  { id: "IBM866", label: "IBM866 (Cirílico DOS)" },
  { id: "x-mac-cyrillic", label: "Macintosh (Cirílico)" },
  // Grego / Turco / Báltico
  { id: "windows-1253", label: "Windows 1253 (Grego)" },
  { id: "ISO-8859-7", label: "ISO 8859-7 (Grego)" },
  { id: "windows-1254", label: "Windows 1254 (Turco)" },
  { id: "windows-1257", label: "Windows 1257 (Báltico)" },
  { id: "ISO-8859-4", label: "ISO 8859-4 (Báltico)" },
  { id: "ISO-8859-13", label: "ISO 8859-13 (Báltico)" },
  // Hebraico / Árabe / Vietnamita / Tailandês
  { id: "windows-1255", label: "Windows 1255 (Hebraico)" },
  { id: "ISO-8859-8", label: "ISO 8859-8 (Hebraico)" },
  { id: "ISO-8859-8-I", label: "ISO 8859-8-I (Hebraico lógico)" },
  { id: "windows-1256", label: "Windows 1256 (Árabe)" },
  { id: "ISO-8859-6", label: "ISO 8859-6 (Árabe)" },
  { id: "windows-1258", label: "Windows 1258 (Vietnamita)" },
  { id: "windows-874", label: "Windows 874 (Tailandês)" },
  // Outras ISO 8859
  { id: "ISO-8859-3", label: "ISO 8859-3 (Latin-3)" },
  { id: "ISO-8859-10", label: "ISO 8859-10 (Latin-6/Nórdico)" },
  { id: "ISO-8859-14", label: "ISO 8859-14 (Latin-8/Céltico)" },
  { id: "ISO-8859-16", label: "ISO 8859-16 (Latin-10)" },
  // Ásia Oriental
  { id: "Shift_JIS", label: "Shift JIS (Japonês)" },
  { id: "EUC-JP", label: "EUC-JP (Japonês)" },
  { id: "ISO-2022-JP", label: "ISO-2022-JP (Japonês)" },
  { id: "GBK", label: "GBK (Chinês Simplificado)" },
  { id: "gb18030", label: "GB18030 (Chinês Simplificado)" },
  { id: "Big5", label: "Big5 (Chinês Tradicional)" },
  { id: "EUC-KR", label: "EUC-KR (Coreano)" },
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

/** Activity bar placement: lateral (vertical) or atop the sidebar (horizontal).
    The bar is always visible — it can't be fully hidden (it hosts the views). */
type ActivityBarPos = "side" | "top";
function readStoredActivityPos(key: string, fallback: ActivityBarPos): ActivityBarPos {
  try {
    const raw = localStorage.getItem(key);
    // A previously-stored "hidden" now falls back to the lateral bar.
    return raw === "side" || raw === "top" ? raw : fallback;
  } catch {
    return fallback;
  }
}

/** A drop target for the activity-bar drag (left/right edge, or top). */
type DropZone = "left" | "right" | "top";
/** Maps a pointer position to the activity-bar drop zone under it (or null). The
 * top band wins first, so dragging upward reliably docks the bar horizontally. */
function activityZoneAtPoint(x: number, y: number): DropZone | null {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (y < h * 0.22) return "top";
  if (x < w * 0.35) return "left";
  if (x > w * 0.65) return "right";
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
  // Mirrors rootPath for async callbacks (e.g. ACP streaming) that must detect a
  // workspace switch mid-flight without capturing a stale closure value.
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Resizable + side-swappable sidebar (VSCode-style), persisted across sessions.
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredNumber("ui.sidebarWidth", 260)
  );
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">(() =>
    readStoredSide("ui.sidebarSide", "left")
  );
  // Whole-UI zoom (VSCode-style), persisted so the workbench reopens at the same
  // scale. Ctrl+= zooms in, Ctrl+- zooms out, Ctrl+0 resets to 100%.
  const [uiScale, setUiScale] = useState(() =>
    clampUiScale(readStoredNumber("ui.scale", UI_SCALE_DEFAULT))
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
  const [symbolSearchOpen, setSymbolSearchOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Latest "▶ Executar Teste" CodeLens request, handed to the RunPanel. A fresh
  // object each time so re-clicking the same test re-runs it.
  const [pendingTest, setPendingTest] = useState<PendingTest | null>(null);
  // NuGet manager modal: null when closed, else the workspace's .csproj paths.
  const [nugetCsprojs, setNugetCsprojs] = useState<string[] | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
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
  // After a successful connect, holds the open connection while the user browses
  // for a folder. `input` is the credentials for a brand-new connection (cancel
  // disconnects); null when reusing an already-attached session (cancel keeps it).
  const [remoteBrowser, setRemoteBrowser] = useState<{
    connId: string;
    host: string;
    user: string;
    input: SshConnectInput | null;
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
  const [runNonce, setRunNonce] = useState(0);

  // "Abrir no Terminal" target: a cwd + nonce that spawns a fresh PTY there.
  const [terminalOpenCwd, setTerminalOpenCwd] = useState<string | null>(null);
  const [terminalOpenNonce, setTerminalOpenNonce] = useState(0);
  // "Localizar na pasta": sub-folder the search is scoped to (null = root).
  const [searchScope, setSearchScope] = useState<string | null>(null);

  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);

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
  const [recents, setRecents] = useState<string[]>(() => getRecentFolders());
  const [gitBusy, setGitBusy] = useState(false);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [autoFetch, setAutoFetch] = useState(
    () => localStorage.getItem("git.autofetch") !== "off"
  );

  // Keep git status live while a repo is open, so the status bar's ahead/behind,
  // conflicts and branch stay current (VS Code refreshes on focus + on a timer).
  const refreshGitStatus = useCallback(() => {
    if (!rootPath) {
      setGitState(null);
      return;
    }
    gitStatus(rootPath)
      .then((s) => {
        setGitState(s);
        setBranch(s.isRepo ? s.branch : null);
      })
      .catch(() => {});
  }, [rootPath]);

  useEffect(() => {
    if (!rootPath) return;
    refreshGitStatus();
    const id = window.setInterval(refreshGitStatus, 5000);
    const onFocus = () => refreshGitStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [rootPath, refreshGitStatus]);

  // Periodic background fetch (VS Code's git.autofetch), so behind-counts show up
  // without a manual fetch. Toggleable + persisted in localStorage.
  useEffect(() => {
    if (!rootPath || !autoFetch) return;
    const id = window.setInterval(() => {
      gitFetch(rootPath)
        .then(() => {
          setLastFetch(Date.now());
          refreshGitStatus();
        })
        .catch(() => {});
    }, 180_000);
    return () => clearInterval(id);
  }, [rootPath, autoFetch, refreshGitStatus]);

  const toggleAutoFetch = useCallback(() => {
    setAutoFetch((v) => {
      const next = !v;
      localStorage.setItem("git.autofetch", next ? "on" : "off");
      return next;
    });
  }, []);

  // Runs a git op with a spinner, surfaces errors, then refreshes status.
  const runGitOp = useCallback(
    async (fn: (root: string) => Promise<unknown>) => {
      if (!rootPath || gitBusy) return;
      setGitBusy(true);
      try {
        await fn(rootPath);
      } catch (err) {
        alert(`Git: ${err}`);
      } finally {
        setGitBusy(false);
        refreshGitStatus();
      }
    },
    [rootPath, gitBusy, refreshGitStatus]
  );

  const handleGitSync = useCallback(
    () =>
      runGitOp(async (root) => {
        await gitPull(root);
        await gitPush(root);
      }),
    [runGitOp]
  );
  const handleGitFetch = useCallback(
    () =>
      runGitOp(async (root) => {
        await gitFetch(root);
        setLastFetch(Date.now());
      }),
    [runGitOp]
  );
  const handleGitPull = useCallback(() => runGitOp((root) => gitPull(root)), [runGitOp]);
  const handleGitPush = useCallback(() => runGitOp((root) => gitPush(root)), [runGitOp]);
  const handleGitPublish = useCallback(
    () => runGitOp((root) => gitPublish(root)),
    [runGitOp]
  );

  // path → decoration (label color + git badge), rebuilt only when an input
  // changes. The lookup normalizes separators so callers can pass any path.
  const decorations = useMemo(
    () => buildDecorations(rootPath, gitState, allProblems),
    [rootPath, gitState, allProblems]
  );
  const decorationFor = useCallback(
    (path: string) => decorations.get(decoKey(path)),
    [decorations]
  );

  // Absolute paths of files changed in the working tree (issue #19) — feeds the
  // explorer's "only changed files" toggle. Relative git paths are joined to the
  // root with the same scheme GitPanel uses to open them.
  const changedPaths = useMemo(() => {
    if (!rootPath || !gitState?.isRepo) return [];
    return gitState.files.map((f) => `${rootPath}/${f.path}`);
  }, [rootPath, gitState]);

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
  // Apply the UI zoom to the whole document and persist it. The non-standard
  // `zoom` property (supported by the Chromium-based WebView) reflows the
  // px-based chrome, unlike `transform: scale`. Value 1 clears the override.
  useEffect(() => {
    document.documentElement.style.zoom = uiScale === 1 ? "" : String(uiScale);
    try {
      localStorage.setItem("ui.scale", String(uiScale));
    } catch {
      /* storage unavailable — ignore */
    }
  }, [uiScale]);
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
      {
        id: "csharp.toggleInlayHints",
        title: isCsharpInlayHintsEnabled()
          ? "C#: desligar Dicas em Linha (inlay hints)"
          : "C#: ligar Dicas em Linha (inlay hints)",
        detail: "C#",
        run: () => {
          // Flip the pull-config flag, then nudge Roslyn to re-pull so the change
          // applies live: Roslyn re-reads the inlay-hint options and its
          // `inlayHint/refresh` makes the native provider re-query. No reload.
          toggleCsharpInlayHints();
          const client = getRunningClient(CSHARP_SERVER_ID);
          if (client) nudgeClientConfiguration(client);
        },
      },
      {
        id: "editor.goToImplementation",
        title: "Ir para Implementação",
        detail: "Navegar",
        run: () => editorActionsRef.current?.run("editor.action.goToImplementation"),
      },
      {
        id: "editor.goToTypeDefinition",
        title: "Ir para Definição de Tipo",
        detail: "Navegar",
        run: () => editorActionsRef.current?.run("editor.action.goToTypeDefinition"),
      },
      {
        id: "editor.formatSelection",
        title: "Formatar Seleção",
        detail: "Editor",
        run: () => editorActionsRef.current?.run("editor.action.formatSelection"),
      },
      {
        id: "editor.goToSymbolInWorkspace",
        title: "Ir para Símbolo no Projeto…",
        detail: "Navegar",
        run: () => setSymbolSearchOpen(true),
      },
      {
        id: "csharp.openEditorConfig",
        title: "C#: Abrir .editorconfig (regras de estilo)",
        detail: "C#",
        run: () => {
          if (!rootPath) {
            alert("Abra uma pasta primeiro.");
            return;
          }
          void (async () => {
            try {
              const files = await listProjectFiles(rootPath);
              const cfg = findNearestEditorConfig(files, activePathRef.current);
              if (!cfg) {
                alert(
                  "Nenhum .editorconfig no projeto. O Roslyn usa os padrões; crie um .editorconfig na raiz para definir regras de estilo e análise."
                );
                return;
              }
              await handleOpenFileRef.current?.({ name: ".editorconfig", path: cfg, isDir: false });
            } catch (err) {
              alert(`Não foi possível localizar o .editorconfig:\n${err}`);
            }
          })();
        },
      },
      {
        id: "nuget.manage",
        title: "NuGet: Gerenciar Pacotes…",
        detail: ".NET",
        run: () => {
          if (!rootPath) {
            alert("Abra uma pasta primeiro.");
            return;
          }
          void listProjectFiles(rootPath).then((files) => {
            const csprojs = files
              .filter((f) => f.name.toLowerCase().endsWith(".csproj"))
              .map((f) => f.path);
            if (csprojs.length === 0) {
              alert("Nenhum projeto .csproj no workspace.");
              return;
            }
            setNugetCsprojs(csprojs);
          });
        },
      },
      {
        id: "dotnet.newProject",
        title: "Novo Projeto .NET…",
        detail: ".NET",
        run: () => {
          if (!rootPath) {
            alert("Abra uma pasta primeiro.");
            return;
          }
          void dotnetNewList().then((templates) => {
            if (templates.length === 0) {
              alert("Nenhum template .NET encontrado (o SDK está instalado?).");
              return;
            }
            setQuickPick({
              title: "Novo Projeto .NET",
              placeholder: "Escolha um template…",
              items: templates.map((t) => ({
                id: t.shortName,
                label: t.name,
                description: `${t.shortName}${t.tags ? " · " + t.tags : ""}`,
                keywords: `${t.shortName} ${t.tags}`,
                icon: "file" as const,
              })),
              onPick: (it) => {
                const name = window.prompt("Nome do projeto:")?.trim();
                if (!name) return;
                // Create under <root>/<name> so it lands in the workspace.
                const outDir = `${rootPath}/${name}`;
                void dotnetNewCreate(it.id, name, outDir).then((r) => {
                  if (!r.success) {
                    alert(`Falha ao criar o projeto:\n${r.output}`);
                    return;
                  }
                  void refreshExplorerRoot();
                });
              },
            });
          });
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

  /**
   * Loads a project folder into the explorer. Shared by the folder picker and
   * the launch-time restore. When `persist` is true (the normal case), the path
   * is recorded so the next launch reopens it. `silent` swallows the error alert
   * (used on restore: a since-deleted folder shouldn't pop a dialog on startup).
   */
  const openFolder = useCallback(
    async (folder: string, opts?: { persist?: boolean; silent?: boolean }) => {
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
    [resetWorkspaceState]
  );

  /**
   * Step 1 of opening a remote workspace (issue #8): connect to the host. On
   * success the connection is held in `remoteBrowser` so the user can navigate
   * the host's filesystem and pick a folder. Throws on auth/connect failure so
   * the dialog can surface the message.
   */
  const connectRemote = useCallback(async (input: SshConnectInput) => {
    const connId = await sshConnect(input);
    setRemoteBrowser({ connId, host: input.host, user: input.user, input });
    setSshDialogOpen(false);
    setSshHostsOpen(false);
    setSshPasswordFor(null);
  }, []);

  /**
   * Opens the VS Code-style SSH host quick-pick: the saved `~/.ssh/config` hosts
   * plus an "add new host" action. This is the entry point for connecting.
   */
  const openSshFlow = useCallback(async () => {
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
  };

  /**
   * Step 2: attach the chosen remote folder and open it. Sets the ambient remote
   * session first so `openFolder`'s `readDir`/git/search route over SSH, then
   * persists the (secret-free) target for next-launch reconnect.
   */
  async function finalizeRemoteFolder(browser: RemoteBrowserCtx, rootPath: string) {
    const { connId, host, user, input } = browser;

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
  }, [rootPath]);

  /**
   * Re-syncs everything that a branch switch changes (issue #16): the status-bar
   * branch, the git decorations, and the explorer tree (files differ between
   * branches). Shared by checkout and create-branch.
   */
  const refreshAfterCheckout = useCallback(async () => {
    if (!rootPath) return;
    gitBranch(rootPath).then(setBranch).catch(() => setBranch(null));
    await refreshExplorerRoot();
  }, [rootPath, refreshExplorerRoot]);

  /** Checks out an existing branch, then re-syncs branch/status/tree. */
  const handleCheckoutBranch = useCallback(
    async (branchName: string) => {
      if (!rootPath) return;
      try {
        await gitCheckout(rootPath, branchName);
        await refreshAfterCheckout();
      } catch (err) {
        console.error(err);
        alert(`Não foi possível trocar de branch:\n${err}`);
      }
    },
    [rootPath, refreshAfterCheckout]
  );

  /** Prompts for a name, creates a branch from HEAD, then re-syncs. */
  const handleCreateBranch = useCallback(async () => {
    if (!rootPath) return;
    const name = window.prompt("Nome da nova branch:")?.trim();
    if (!name) return;
    try {
      await gitCreateBranch(rootPath, name);
      await refreshAfterCheckout();
    } catch (err) {
      console.error(err);
      alert(`Não foi possível criar a branch:\n${err}`);
    }
  }, [rootPath, refreshAfterCheckout]);

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
        const zone = activityZoneAtPoint(x, y);
        if (zone === "left") {
          setActivityBarPos("side");
          setSidebarSide("left");
        } else if (zone === "right") {
          setActivityBarPos("side");
          setSidebarSide("right");
        } else if (zone === "top") {
          setActivityBarPos("top");
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

      let s: Awaited<ReturnType<typeof sessionLoad>>;
      try {
        s = await sessionLoad();
      } catch (err) {
        console.error("Falha ao restaurar sessão:", err);
        restoringSessionRef.current = false;
        return;
      }

      // Open the folder first so the explorer/rootPath are ready before tabs
      // reopen (handleOpenFile resolves paths against the loaded project).
      if (s.lastFolder) await openFolder(s.lastFolder, { silent: true });

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

  // Agent definitions and histories are isolated per workspace.
  useEffect(() => {
    let cancelled = false;
    setAgentSelection(null);
    setAgentError(null);
    setAgentStatus(null);
    // An in-flight send from the previous workspace will see isStaleWorkspace()
    // and bail; clear its busy flag here so the new workspace starts unblocked.
    setAgentBusy(false);

    if (!rootPath) {
      setAgentStore({ ...EMPTY_AGENT_STORE });
      return () => {
        cancelled = true;
      };
    }

    agentsLoad(rootPath)
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
      void acpStopWorkspace(rootPath).catch(() => {});
    };
  }, [rootPath]);

  const persistAgentStore = useCallback(
    async (next: AgentStore) => {
      setAgentStore(next);
      if (!rootPath) return;
      try {
        await agentsSave(rootPath, next);
        // Limpa apenas erros globais de persistência — não engole o erro de
        // turno de uma conversa por causa de um save de outra origem.
        setAgentError((prev) => (prev?.conversationId === null ? null : prev));
      } catch (error) {
        setAgentError({ conversationId: null, message: String(error) });
      }
    },
    [rootPath],
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

  function handleCreateAgent() {
    if (!rootPath) return;
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
    if (!rootPath) return;
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
      workspacePath: rootPath,
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
    if (!rootPath || agentSelection?.kind !== "chat") return;
    const agent = agentStore.agents.find(
      (candidate) => candidate.id === agentSelection.agentId,
    );
    if (agent) void acpWarm(agent.provider, rootPath).catch(() => {});
  }, [rootPath, agentSelection, agentStore.agents]);

  /**
   * Abre um arquivo citado pelo agente no chat. Agentes às vezes citam só o
   * nome (`Controller.cs`) ou um caminho relativo inexato; quando o caminho
   * resolvido não existe no workspace, procura pelo melhor candidato no mesmo
   * índice do Quick Open (sufixo do caminho > nome do arquivo; empate = o
   * menos aninhado) em vez de falhar com "arquivo não encontrado".
   */
  async function handleOpenAgentFile(path: string, line?: number) {
    const open = (target: string) =>
      handleOpenFile(
        { name: baseName(target), path: target, isDir: false },
        line,
      );
    if (!rootPath) {
      open(path);
      return;
    }
    let files: Awaited<ReturnType<typeof listProjectFiles>>;
    try {
      files = await listProjectFiles(rootPath);
    } catch {
      open(path);
      return;
    }
    const norm = (value: string) => value.replace(/\\/g, "/").toLowerCase();
    const wanted = norm(path);
    // O caminho citado existe de fato — abre direto.
    if (files.some((file) => norm(file.path) === wanted)) {
      open(path);
      return;
    }
    // Melhor candidato: caminho relativo citado como sufixo real; senão, só o
    // nome do arquivo. Empates ficam com o caminho menos aninhado.
    const root = norm(rootPath).replace(/\/+$/, "");
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
    open(match?.path ?? path);
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
    if (!rootPath || agentSelection?.kind !== "chat" || agentBusy) return;
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
    const sendRoot = rootPath;
    const isStaleWorkspace = () => rootPathRef.current !== sendRoot;

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
    const reference = formatEditorContextReference(rootPath, editorContext);
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
    if (!rootPath) return;
    const conversation = agentStore.conversations.find(
      (candidate) => candidate.id === conversationId,
    );
    const target = conversation?.messages.find(
      (candidate) => candidate.id === userMessageId,
    );
    if (!target?.revert || target.revert.reverted) return;

    try {
      await gitSnapshotRestore(rootPath, target.revert);
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
            resolvedMode === "text" ? await readFile(node.path) : null;
          await openInDetached(active.label, {
            path: node.path,
            name: node.name,
            content: decoded?.content ?? "",
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
          resolvedMode === "text" ? await readFile(node.path) : null;
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
    [openFiles]
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
  const handleFileHistory = useCallback((path: string) => {
    setHistoryFile(path);
    setActiveView("git");
  }, []);

  /**
   * Advanced explorer actions handed to the FileExplorer for épico A's file
   * context menu to consume (issues 69-71). Bundled so the menu can build its
   * items with `buildAdvancedFileMenuItems` without App reaching into the tree.
   */
  const explorerAdvancedActions = useMemo(
    () => ({
      onShowOpenWith: (path: string, x: number, y: number) =>
        setOpenWith({ path, x, y }),
      onFileHistory: handleFileHistory,
      isGitRepo: gitState?.isRepo ?? false,
    }),
    [handleFileHistory, gitState]
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
        // Preserve the file's original encoding/BOM/line ending on save (VS Code
        // default). Untitled buffers have no detected encoding yet, so they fall
        // back to UTF-8 + LF inside writeFile.
        await writeFile(targetPath, contentToWrite, {
          encoding: file.encoding,
          eol: file.eol,
          bom: file.bom,
        });
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
      // The synthetic graph tab has no file on disk, so it's never persisted.
      const tabs: OpenTab[] = openFiles
        .filter((f) => !isGraphTab(f.path))
        .map((f) => ({ path: f.path, mode: f.mode }));
      const sl = serializeLayout(layout);
      sl.groups = sl.groups.map((g) => ({
        ...g,
        tabs: g.tabs.filter((t) => !isGraphTab(t.path)),
        activePath: isGraphTab(g.activePath ?? "") ? null : g.activePath,
      }));
      const serialized = JSON.stringify(sl);
      sessionSetOpenFiles(tabs, activePath, serialized).catch((err) =>
        console.error("Falha ao salvar abas da sessão:", err)
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [layout, openFiles, activePath]);

  // Remember the last real file the user focused (ignoring the graph tab), so the
  // graph can highlight it even when the graph tab itself is active.
  useEffect(() => {
    if (activePath && !isGraphTab(activePath)) setLastRealFile(activePath);
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
    if (!rootPath || !activePath || isGraphTab(activePath)) {
      window.alert("Abra um arquivo do projeto para montar o pacote de contexto.");
      return;
    }
    try {
      const bundle = await buildContextBundle(rootPath, activePath, 1);
      await navigator.clipboard.writeText(bundle);
      window.alert(
        `Pacote de contexto copiado (${bundle.length} caracteres).\n\n` +
          "Cole no chat de um agente para dar a ele o arquivo atual + os arquivos relacionados."
      );
    } catch (e) {
      window.alert(`Não foi possível montar o pacote de contexto:\n${e}`);
    }
  }, [rootPath, activePath]);

  /** Opens (or focuses, since openInGroup dedupes by path) the context-graph tab
   *  in the active group. Triggered by the activity-bar graph icon. */
  const handleShowGraph = useCallback(() => {
    setLayout((l) =>
      openInGroup(l, l.activeGroup, {
        path: GRAPH_URI,
        name: "Grafo",
        content: "",
        dirty: false,
        mode: "graph",
      })
    );
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

  /** Save the active buffer to a new path chosen via the save dialog (Save As…). */
  const handleSaveAs = useCallback(async () => {
    const file = openFiles.find((f) => f.path === activePath);
    if (!file) return;
    const dest = await pickSavePath(file.name);
    if (!dest) return;
    try {
      await writeFile(dest, file.content);
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
    if (!file.dirty && !isUntitled(file.path)) return;
    // saveFile already reports/throws on failure; swallow here (no close to gate).
    await saveFile(file).catch(() => {});
  }, [openFiles, activePath, saveFile]);

  /** Close the current workspace folder, returning to the empty state. */
  const handleCloseFolder = useCallback(async () => {
    // Closing the folder discards the session — guard unsaved buffers first.
    if (!(await guardDirtySession())) return;
    // Detach + close the SSH connection if this was a remote workspace. This is
    // also the "disconnect / reset window" path: it returns the workbench to the
    // empty local state.
    const remote = getActiveRemote();
    if (remote) {
      setActiveRemote(null);
      setRemoteSession(null);
      clearRemoteTerminals();
      clearRemoteLspServers();
      void sshDisconnect(remote.connId).catch(() => {});
    }
    setRootPath(null);
    setRootName(null);
    setRoots([]);
    resetEditorLayout();
    // Clear every workspace-derived bit so no project remnants linger in this
    // same window (branch, git decorations, diagnostics, search scope, history).
    // The LSP servers and search index tear down when rootPath becomes null
    // (useLspManager watches it); forget the folder so it won't reopen on launch.
    resetWorkspaceState();
    setSearchScope(null);
    setHistoryFile(null);
    setActiveView("explorer");
    sessionSetLastFolder(null).catch(() => {});
  }, [guardDirtySession, resetEditorLayout, resetWorkspaceState]);

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
  const handleOpenTerminalAt = useCallback((cwd: string) => {
    setTerminalOpenCwd(cwd);
    setTerminalOpenNonce((n) => n + 1);
    setPanelOpen(true);
  }, []);

  /** Open/focus the search panel scoped to `folderPath` (explorer "Localizar na pasta"). */
  const handleFindInFolder = useCallback((folderPath: string) => {
    setSearchScope(folderPath);
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

      // Ctrl+= or Ctrl++ → zoom the interface in (VSCode-style whole-UI scale).
      // "=" is the unshifted key, "+" is what it reports with Shift or on the
      // numpad — accept both so any layout can zoom in.
      if (key === "=" || key === "+") {
        e.preventDefault();
        setUiScale((s) => stepUiScale(s, 1));
        return;
      }
      // Ctrl+- → zoom the interface out.
      if (key === "-") {
        e.preventDefault();
        setUiScale((s) => stepUiScale(s, -1));
        return;
      }
      // Ctrl+0 → reset the interface zoom to the default (100%).
      if (key === "0") {
        e.preventDefault();
        setUiScale(UI_SCALE_DEFAULT);
        return;
      }

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
      // Ctrl+T → Go to Symbol in Workspace (whole-solution symbols, via Roslyn).
      if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        setSymbolSearchOpen(true);
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
  function handleRun(command: string) {
    setRunCommand(command);
    setRunNonce((n) => n + 1);
    setPanelOpen(true);
  }

  /** Jump to a problem's file/line, opening the file if needed. */
  function handleOpenProblem(problem: Problem) {
    handleOpenFile(
      { name: problem.name, path: problem.path, isDir: false },
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
      handleOpenFile({ name: baseName(d.path), path: d.path, isDir: false }, d.line);
    };
    window.addEventListener("fluent:debug-stopped", onDebugStopped);
    return () => window.removeEventListener("fluent:debug-stopped", onDebugStopped);
  });

  // "▶ Executar Teste" / "🐞 Depurar Teste" CodeLens → switch to the "Executar e
  // Depurar" view (so the RunPanel is mounted) and hand it the test to run/debug.
  // Listening here (app-wide, always mounted) avoids losing the event before the
  // panel mounts.
  useEffect(() => {
    const handle = (mode: "run" | "debug") => (e: Event) => {
      const d = (e as CustomEvent<RunTestEventDetail>).detail;
      if (!d?.csprojPath || !d.fullyQualifiedName) return;
      setActiveView("debug");
      setSidebarOpen(true);
      setPendingTest({
        csprojPath: d.csprojPath,
        fullyQualifiedName: d.fullyQualifiedName,
        mode,
      });
    };
    const onRun = handle("run");
    const onDebug = handle("debug");
    window.addEventListener(RUN_TEST_EVENT, onRun);
    window.addEventListener(DEBUG_TEST_EVENT, onDebug);
    return () => {
      window.removeEventListener(RUN_TEST_EVENT, onRun);
      window.removeEventListener(DEBUG_TEST_EVENT, onDebug);
    };
  }, []);

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
   * Builds the encoding quick-pick items. The picked item's id is the list
   * index (not the encoding id) because several entries share a canonical id —
   * UTF-8 com/sem BOM, and windows-1252 exposed also as "ISO 8859-1" — so the
   * index keeps them distinct and carries the BOM variant.
   *
   * The "(atual)" marker matches on encoding id AND — for the UTF-8 split — the
   * BOM flag, and is applied to only the FIRST matching entry so an aliased
   * codepage (windows-1252 / ISO 8859-1) isn't flagged current twice.
   */
  const buildEncodingItems = useCallback((file: OpenFile): QuickPickItem[] => {
    let flagged = false;
    return COMMON_ENCODINGS.map((enc, i) => {
      const matches =
        file.encoding === enc.id &&
        (enc.bom === undefined || enc.bom === file.bom);
      const current = matches && !flagged;
      if (current) flagged = true;
      return {
        id: String(i),
        label: enc.label + (current ? "  (atual)" : ""),
        icon: "file",
        keywords: `${enc.id} ${enc.label}`,
      };
    });
  }, []);

  /**
   * "Reopen with Encoding" (VS Code): re-decode the file on disk forcing the
   * chosen encoding and replace the buffer. Only for saved local files — a
   * dirty buffer would lose edits (we warn), and remote/untitled have no path
   * to re-read.
   */
  const handleReopenWithEncoding = useCallback(() => {
    if (!activeFile || isUntitled(activeFile.path)) return;
    const file = activeFile;
    setQuickPick({
      title: "Reabrir com Codificação",
      placeholder: `Codificação para ${file.name}…`,
      items: buildEncodingItems(file),
      onPick: async (it) => {
        const enc = COMMON_ENCODINGS[Number(it.id)];
        if (!enc) return;
        if (file.dirty) {
          const ok = window.confirm(
            "Reabrir com outra codificação descarta as alterações não salvas deste arquivo. Continuar?"
          );
          if (!ok) return;
        }
        try {
          const decoded = await readFileWithEncoding(file.path, enc.id);
          setLayout((l) =>
            patchFileEverywhere(l, file.path, {
              content: decoded.content,
              encoding: decoded.encoding,
              // Reopen only re-decodes; it never writes. BOM presence is a
              // save-time concern, so reflect what's actually on disk rather
              // than the entry's BOM variant (which takes effect via Save With).
              bom: decoded.bom,
              eol: decoded.eol,
              dirty: false,
            })
          );
        } catch (err) {
          alert(`Não foi possível reabrir com ${enc.label}:\n${err}`);
        }
      },
    });
  }, [activeFile, buildEncodingItems]);

  /**
   * "Save with Encoding" (VS Code): re-encode the current buffer to the chosen
   * encoding on disk. Unlike reopen, this keeps the in-memory (LF) text; it
   * only changes how bytes are written. Local saved files only — the remote
   * SFTP write path ignores encoding (writes UTF-8/LF as-is).
   *
   * We save with an explicit file snapshot (not via `handleSave`, whose
   * `openFiles` closure is stale right after `setLayout`) and persist the new
   * encoding/bom so the status bar and later saves reflect the choice. On an
   * unmappable-char failure `saveFile` alerts and throws, so the persisted
   * encoding is rolled back to what was actually on disk.
   */
  const handleSaveWithEncoding = useCallback(() => {
    if (!activeFile || isUntitled(activeFile.path)) return;
    const file = activeFile;
    setQuickPick({
      title: "Salvar com Codificação",
      placeholder: `Salvar ${file.name} como…`,
      items: buildEncodingItems(file),
      onPick: async (it) => {
        const enc = COMMON_ENCODINGS[Number(it.id)];
        if (!enc) return;
        const bom = enc.bom ?? file.bom;
        const prevDirty = file.dirty;
        // Persist the choice first so the status bar updates immediately, then
        // write with an explicit snapshot so we don't depend on stale closures.
        setLayout((l) =>
          patchFileEverywhere(l, file.path, { encoding: enc.id, bom, dirty: true })
        );
        try {
          await saveFile({ ...file, encoding: enc.id, bom, dirty: true });
        } catch {
          // saveFile already alerted. Roll the displayed encoding/BOM back to
          // what's really on disk — and restore the prior dirty flag, so a file
          // that was clean before doesn't linger as unsaved though it matches disk.
          setLayout((l) =>
            patchFileEverywhere(l, file.path, {
              encoding: file.encoding,
              bom: file.bom,
              dirty: prevDirty,
            })
          );
        }
      },
    });
  }, [activeFile, buildEncodingItems, saveFile]);

  /**
   * Status-bar encoding click (VS Code): offer "Reopen with" vs "Save with"
   * before the encoding list. Reopen re-reads disk; save re-writes the buffer.
   */
  const handleSelectEncoding = useCallback(() => {
    if (!activeFile || isUntitled(activeFile.path)) return;
    setQuickPick({
      title: "Selecionar Ação de Codificação",
      placeholder: "Reabrir ou salvar com codificação…",
      items: [
        {
          id: "reopen",
          label: "Reabrir com Codificação",
          description: "Relê o arquivo do disco na codificação escolhida",
          icon: "file",
          keywords: "reopen reabrir",
        },
        {
          id: "save",
          label: "Salvar com Codificação",
          description: "Grava o conteúdo atual na codificação escolhida",
          icon: "save",
          keywords: "save salvar",
        },
      ],
      onPick: (it) => {
        // Defer so this quick-pick fully closes before the next one opens.
        if (it.id === "reopen") setTimeout(handleReopenWithEncoding, 0);
        else if (it.id === "save") setTimeout(handleSaveWithEncoding, 0);
      },
    });
  }, [activeFile, handleReopenWithEncoding, handleSaveWithEncoding]);

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
          label:
            activityBarPos === "side"
              ? "Barra de atividades: no topo"
              : "Barra de atividades: lateral",
          run: () => setActivityBarPos((p) => (p === "side" ? "top" : "side")),
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
    remoteSession,
    activePath,
    handleOpenFileDialog,
    handleOpenFolder,
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

  const titleText = activeFile
    ? `${activeFile.dirty ? "● " : ""}${activeFile.name} — Fluent Coder`
    : "Fluent Coder";

  /** Pick which sidebar view the activity bar selection maps to. */
  function renderSidebar() {
    switch (activeView) {
      case "search":
        return (
          <SearchPanel
            rootPath={rootPath}
            scopePath={searchScope}
            onClearScope={() => setSearchScope(null)}
            onOpenMatch={handleOpenMatch}
          />
        );
      case "explorer":
        return (
          <FileExplorer
            rootName={rootName}
            rootPath={rootPath}
            roots={roots}
            activePath={activePath}
            onOpenFile={handleOpenFile}
            onRefreshRoot={refreshExplorerRoot}
            decorationFor={decorationFor}
            onPathRenamed={handlePathRenamed}
            onPathDeleted={handlePathDeleted}
            onOpenTerminalAt={handleOpenTerminalAt}
            onFindInFolder={handleFindInFolder}
            advancedActions={explorerAdvancedActions}
            changedPaths={changedPaths}
          />
        );
      case "git":
        return (
          <GitPanel
            rootPath={rootPath}
            onOpenFile={(path, name) =>
              handleOpenFile({ name, path, isDir: false })
            }
            historyFile={historyFile}
            onClearHistoryFile={() => setHistoryFile(null)}
          />
        );
      case "debug":
        return (
          <RunPanel
            rootPath={rootPath}
            onRun={handleRun}
            pendingTest={pendingTest}
          />
        );
      case "backlinks":
        return (
          <BacklinksPanel
            rootPath={rootPath}
            activePath={activePath && !isGraphTab(activePath) ? activePath : null}
            onOpenFile={(p) =>
              handleOpenFile({ name: baseName(p), path: p, isDir: false })
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
            rootName={rootName}
            rootPath={rootPath}
            roots={roots}
            activePath={activePath}
            onOpenFile={handleOpenFile}
            onRefreshRoot={refreshExplorerRoot}
            decorationFor={decorationFor}
            onPathRenamed={handlePathRenamed}
            onPathDeleted={handlePathDeleted}
            onOpenTerminalAt={handleOpenTerminalAt}
            onFindInFolder={handleFindInFolder}
            advancedActions={explorerAdvancedActions}
            changedPaths={changedPaths}
          />
        );
    }
  }

  // The home / welcome screen shown by any empty editor group.
  const welcomeNode = (
    <WelcomeScreen
      hasFolder={rootPath != null}
      folderName={rootPath ? baseName(rootPath) : null}
      folderPath={rootPath}
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
      rootPath={rootPath}
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
        onOpenDefinition={(path, line) =>
          handleOpenFile({ name: baseName(path), path, isDir: false }, line)
        }
        revealRef={groupIsActive ? revealRef : undefined}
        pendingReveal={groupIsActive ? pendingReveal : undefined}
        actionsRef={groupIsActive ? editorActionsRef : undefined}
        onTabDrop={(edge, fromGroupId, path) =>
          handleTabDrop(groupId, edge, fromGroupId, path)
        }
        onOpenPath={(p) =>
          handleOpenFile({ name: baseName(p), path: p, isDir: false })
        }
        graphActivePath={lastRealFile}
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
        {/* Activity bar + sidebar form one dock so they can be placed together
            (activity bar lateral or as a compact horizontal strip atop the
            sidebar) and slide to either side as a unit. */}
        <div className={`primary-dock activity-${activityBarPos}`}>
          {/* Lateral bar is always shown; the horizontal (top) strip only when the
              sidebar is open (it sits atop the explorer). */}
          {(activityBarPos === "side" || sidebarOpen) && (
              <ActivityBar
                activeView={activeView}
                onViewChange={(v) => {
                  // The graph is an editor tab, not a sidebar panel: its icon
                  // opens (or focuses) the graph tab and leaves the sidebar as is.
                  if (v === "graph") handleShowGraph();
                  else {
                    setActiveView(v);
                    // Picking a view always reveals the primary sidebar.
                    setSidebarOpen(true);
                  }
                }}
                side={sidebarSide}
                orientation={activityBarPos === "top" ? "horizontal" : "vertical"}
                onToggleSide={() =>
                  setSidebarSide((s) => (s === "left" ? "right" : "left"))
                }
                onDragStart={startActivityDrag}
              />
            )}

          {sidebarOpen && (
            <aside
              className="sidebar"
              style={{
                width:
                  activityBarPos === "top"
                    ? Math.max(sidebarWidth, SIDEBAR_MIN_TOP)
                    : sidebarWidth,
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
              // The top activity bar needs a wider floor so the explorer can't
              // shrink past the icon strip above it.
              const minW =
                activityBarPos === "top" ? SIDEBAR_MIN_TOP : SIDEBAR_MIN;
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
              runNonce={runNonce}
              openCwd={terminalOpenCwd}
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
        onClickBranch={rootPath ? () => setBranchPickerOpen(true) : undefined}
        onGitSync={handleGitSync}
        onGitFetch={handleGitFetch}
        onGitPull={handleGitPull}
        onGitPush={handleGitPush}
        onGitPublish={handleGitPublish}
        onToggleAutoFetch={toggleAutoFetch}
        remoteHost={
          remoteSession ? `${remoteSession.user}@${remoteSession.host}` : null
        }
        onManageRemote={remoteSession ? () => setManageMenuOpen(true) : undefined}
        onOpenRemote={() => void openSshFlow()}
        tabSize={TAB_SIZE}
        errorCount={errorCount}
        warningCount={warningCount}
        lspServers={activeLspServers}
        onRestartLsp={restartLsp}
        onShowProblems={() => showPanelTab("problems")}
        onSelectTsVersion={handleSelectTsVersion}
        onSelectLanguage={activeFile ? handleSelectLanguageMode : undefined}
        encoding={activeFile?.encoding ?? null}
        eol={activeFile?.eol ? (activeFile.eol === "Lf" ? "LF" : "CRLF") : null}
        onSelectEncoding={
          // Reopen re-reads the local FS and save-with re-writes it with a real
          // encoder; both are offered only for saved local files (not untitled,
          // not remote SSH, whose SFTP write path ignores encoding).
          activeFile && !isUntitled(activeFile.path) && !remoteSession
            ? handleSelectEncoding
            : undefined
        }
        onSelectEol={activeFile ? handleSelectEol : undefined}
      />


      {quickOpenOpen && (
        <QuickOpen
          rootPath={rootPath}
          onOpenFile={handleOpenFile}
          onClose={() => setQuickOpenOpen(false)}
        />
      )}

      {symbolSearchOpen && (
        <SymbolSearch
          onOpenSymbol={(path, line) =>
            handleOpenFile({ name: baseName(path), path, isDir: false }, line)
          }
          onClose={() => setSymbolSearchOpen(false)}
        />
      )}

      {nugetCsprojs && (
        <NugetManager
          csprojs={nugetCsprojs}
          onClose={() => setNugetCsprojs(null)}
        />
      )}

      {branchPickerOpen && (
        <BranchPicker
          rootPath={rootPath}
          onCheckout={handleCheckoutBranch}
          onCreateBranch={handleCreateBranch}
          onClose={() => setBranchPickerOpen(false)}
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
          onBack={() => {
            // Cancel returns to the host quick-pick (keeps the flow), not closes.
            setSshDialogOpen(false);
            setSshFormInitial(undefined);
            setSshHostsOpen(true);
          }}
          onClose={() => {
            setSshDialogOpen(false);
            setSshFormInitial(undefined);
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
            });
          }}
          onNewTerminal={() => {
            setManageMenuOpen(false);
            handleOpenTerminalAt(remoteSession.rootPath);
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
