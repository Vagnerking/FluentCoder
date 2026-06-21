import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
import { PlaceholderPanel } from "./components/PlaceholderPanel";
import { EditorPane } from "./components/EditorPane";
import { ImagePreview } from "./components/ImagePreview";
import { OpenWithPicker } from "./explorer/OpenWithPicker";
import { defaultModeFor } from "./explorer/openWith";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { ActivityBar } from "./components/ActivityBar";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { StatusBar } from "./components/StatusBar";
import { TerminalPanel, type PanelTab } from "./components/TerminalPanel";
import { QuickOpen } from "./components/QuickOpen";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { AboutDialog } from "./components/AboutDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { AgentsPanel } from "./components/AgentsPanel";
import { AgentWorkspace } from "./components/AgentWorkspace";
import { BranchPicker } from "./components/BranchPicker";
import { Codicon } from "./icons/codicons/Codicon";
import {
  acpPrompt,
  agentsLoad,
  agentsSave,
  buildSearchIndex,
  gitBranch,
  gitCheckout,
  gitCreateBranch,
  gitStatus,
  isFreshWindow,
  openNewWindow,
  pickFile,
  pickFolder,
  pickSavePath,
  readDir,
  readFile,
  sessionLoad,
  sessionSetLastFolder,
  sessionSetOpenFiles,
  writeFile,
} from "./api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { languageForFile } from "./language";
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
  normalizeAgentStore,
  replaceConversation,
} from "./agents/store";
import type {
  AgentConversation,
  AgentDraft,
  AgentMessage,
  AgentSelection,
  AgentStore,
} from "./agents/types";

/** Returns the last path segment, handling both Windows and POSIX separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Untitled buffers use a synthetic `untitled:<name>` path (never on disk). */
const UNTITLED_PREFIX = "untitled:";

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

function isUntitled(path: string): boolean {
  return path.startsWith(UNTITLED_PREFIX);
}

/** Editor tab size — kept in one place so the StatusBar and Monaco agree. */
const TAB_SIZE = 2;

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

/** Activity bar placement: lateral (vertical), atop the sidebar (horizontal), or hidden. */
type ActivityBarPos = "side" | "top" | "hidden";
function readStoredActivityPos(key: string, fallback: ActivityBarPos): ActivityBarPos {
  try {
    const raw = localStorage.getItem(key);
    return raw === "side" || raw === "top" || raw === "hidden" ? raw : fallback;
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
  const [branch, setBranch] = useState<string | null>(null);

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const navigationHistoryRef = useRef(createNavigationHistory());
  const historyNavigationTargetRef = useRef<string | null>(null);
  const historyNavigationPendingRef = useRef(false);
  // True while the launch-time restore is reopening saved tabs. Guards the
  // session-save effect so the partial state mid-restore never overwrites the
  // good session on disk (e.g. saving an empty tab list before the first tab
  // reopens). Cleared once the restore finishes.
  const restoringSessionRef = useRef(false);

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
  const [agentStore, setAgentStore] = useState<AgentStore>(() => ({
    ...EMPTY_AGENT_STORE,
  }));
  const [agentSelection, setAgentSelection] = useState<AgentSelection>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

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
      const key = `${p.path}|${p.line}|${p.column}|${p.severity}|${p.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(p);
    }
    return merged;
  }, [problems, diagVersion]);

  // Git status of the open folder, used (with diagnostics) to decorate the
  // explorer/tabs. Refreshed when the folder changes; null when not a repo.
  const [gitState, setGitState] = useState<GitStatus | null>(null);

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
    for (const f of openFiles) set.add(languageForFile(f.name));
    return set;
  }, [openFiles]);

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
    ? serverIdForLanguage(languageForFile(activeFile.name))?.serverId
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
  // Tracks the workspace we already ran an initial compiler build for (#11).
  const builtForRootRef = useRef<string | null>(null);

  const resetWorkspaceState = useCallback(() => {
    setBranch(null);
    setGitState(null);
    setProblems([]);
    clearAllDiagnostics();
    clearBuildDiagnostics();
    builtForRootRef.current = null;
  }, []);

  // Run the real compiler (dotnet build) once when a C#/Razor file first opens in
  // a workspace, so its errors show on open — not only on save (issue #11).
  useEffect(() => {
    const isNet =
      openedLanguages.has("csharp") || openedLanguages.has("aspnetcorerazor");
    if (isNet && rootPath && builtForRootRef.current !== rootPath) {
      builtForRootRef.current = rootPath;
      void runBuildDiagnostics(rootPath);
    }
  }, [openedLanguages, rootPath]);

  /**
   * Loads a project folder into the explorer. Shared by the folder picker and
   * the launch-time restore. When `persist` is true (the normal case), the path
   * is recorded so the next launch reopens it. `silent` swallows the error alert
   * (used on restore: a since-deleted folder shouldn't pop a dialog on startup).
   */
  const openFolder = useCallback(
    async (folder: string, opts?: { persist?: boolean; silent?: boolean }) => {
      const persist = opts?.persist ?? true;
      // Drop the previous project's branch/git/diagnostics up front so they don't
      // linger while the new project's git/LSP load asynchronously (issue #17).
      resetWorkspaceState();
      try {
        const entries = await readDir(folder);
        setRoots(entries);
        setRootName(baseName(folder).toUpperCase());
        setRootPath(folder);
        // Resolve the git branch for the status bar (null if not a repo).
        gitBranch(folder).then(setBranch).catch(() => setBranch(null));
        // Pull status to decorate the explorer (modified/new/conflict badges).
        gitStatus(folder).then(setGitState).catch(() => setGitState(null));
        // Warm the search index so the first Ctrl+Shift+F is instant (the walk +
        // ignore parsing happen now, in the background, not on the first query).
        buildSearchIndex(folder).catch(() => {});
        if (persist) sessionSetLastFolder(folder).catch(() => {});
      } catch (err) {
        console.error(err);
        if (!opts?.silent) alert(`Não foi possível abrir a pasta:\n${err}`);
        // A folder that no longer opens shouldn't be reopened next launch.
        if (persist) sessionSetLastFolder(null).catch(() => {});
      }
    },
    [resetWorkspaceState]
  );

  const refreshExplorerRoot = useCallback(async () => {
    if (!rootPath) return;
    const entries = await readDir(rootPath);
    setRoots(entries);
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

  /** Native folder picker → load top-level entries into the explorer. */
  async function handleOpenFolder() {
    const folder = await pickFolder();
    if (!folder) return;
    // Switching folders drops the current session — guard unsaved buffers first.
    if (!(await guardDirtySession())) return;
    setOpenFiles([]);
    setActivePath(null);
    await openFolder(folder);
  }

  /** Opens a new isolated editor window (separate process), starting empty. */
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
  // (issue #7) — unless this is a fresh window (File ▸ New Window → `--new`),
  // which starts empty. Restore is silent so a moved/deleted folder/file doesn't
  // greet the user with an error dialog. The `restoringSessionRef` guard keeps
  // the session-save effect from overwriting the good session with the partial
  // state produced while tabs are reopening.
  useEffect(() => {
    restoringSessionRef.current = true;
    (async () => {
      let fresh = false;
      try {
        fresh = await isFreshWindow();
      } catch (err) {
        console.error("Falha ao verificar se a janela é nova:", err);
      }
      if (fresh) {
        // A fresh window starts empty — nothing to restore, and saves are allowed.
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

      // Reopen tabs in their saved order, skipping any file that no longer
      // exists (handleOpenFile returns false silently). Re-read content from
      // disk — only the path + view mode were persisted.
      const restored: OpenTab[] = [];
      for (const tab of s.openTabs) {
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

      // Focus the tab that was active, if it survived the restore.
      const activeRestored =
        s.activePath && restored.some((t) => t.path === s.activePath)
          ? s.activePath
          : restored.length > 0
            ? restored[restored.length - 1].path
            : null;
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
          setAgentError(String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const persistAgentStore = useCallback(
    async (next: AgentStore) => {
      setAgentStore(next);
      if (!rootPath) return;
      try {
        await agentsSave(rootPath, next);
      } catch (error) {
        setAgentError(String(error));
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
    setActiveView("agents");
    setAgentSelection({ kind: "config", agentId: null });
    setAgentError(null);
  }

  function handleEditAgent(agentId: string) {
    setActiveView("agents");
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

  function handleRenameAgent(agentId: string, name: string) {
    const now = new Date().toISOString();
    void persistAgentStore({
      ...agentStore,
      agents: agentStore.agents.map((agent) =>
        agent.id === agentId ? { ...agent, name, updatedAt: now } : agent,
      ),
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

  async function handleSendAgentMessage(message: string) {
    if (!rootPath || agentSelection?.kind !== "chat" || agentBusy) return;
    const agent = agentStore.agents.find(
      (candidate) => candidate.id === agentSelection.agentId,
    );
    const conversation = agentStore.conversations.find(
      (candidate) => candidate.id === agentSelection.conversationId,
    );
    if (!agent || !conversation) return;

    const now = new Date().toISOString();
    const userMessage: AgentMessage = {
      id: createLocalId("message"),
      role: "user",
      content: message,
      createdAt: now,
      status: "done",
    };
    const assistantMessage: AgentMessage = {
      id: createLocalId("message"),
      role: "assistant",
      content: "",
      createdAt: now,
      status: "streaming",
    };
    const prompt = buildAgentPrompt(agent, conversation.messages, message);
    let workingStore = replaceConversation(
      agentStore,
      conversation.id,
      (current) => ({
        ...current,
        title:
          current.messages.length === 0
            ? message.slice(0, 52) || "Nova conversa"
            : current.title,
        messages: [...current.messages, userMessage, assistantMessage],
        updatedAt: now,
      }),
    );

    setAgentBusy(true);
    setAgentError(null);
    setAgentStatus("Conectando ao provedor ACP…");
    await persistAgentStore(workingStore);

    try {
      await acpPrompt(agent.provider, rootPath, prompt, (event) => {
        if (event.type === "status") {
          setAgentStatus(event.message);
          return;
        }
        if (event.type === "text") {
          setAgentStatus("Recebendo resposta…");
          workingStore = replaceConversation(
            workingStore,
            conversation.id,
            (current) => ({
              ...current,
              messages: current.messages.map((candidate) =>
                candidate.id === assistantMessage.id
                  ? {
                      ...candidate,
                      content: candidate.content + event.content,
                      status: "streaming",
                    }
                  : candidate,
              ),
              updatedAt: new Date().toISOString(),
            }),
          );
          setAgentStore(workingStore);
          return;
        }
        if (event.type === "error") setAgentError(event.message);
      });

      workingStore = replaceConversation(
        workingStore,
        conversation.id,
        (current) => ({
          ...current,
          messages: current.messages.map((candidate) =>
            candidate.id === assistantMessage.id
              ? {
                  ...candidate,
                  content:
                    candidate.content ||
                    "O agente encerrou a resposta sem conteúdo textual.",
                  status: "done",
                }
              : candidate,
          ),
          updatedAt: new Date().toISOString(),
        }),
      );
      await persistAgentStore(workingStore);
      setAgentStatus("Resposta concluída.");
    } catch (error) {
      const messageText = String(error);
      workingStore = replaceConversation(
        workingStore,
        conversation.id,
        (current) => ({
          ...current,
          messages: current.messages.map((candidate) =>
            candidate.id === assistantMessage.id
              ? {
                  ...candidate,
                  content: candidate.content || messageText,
                  status: "error",
                }
              : candidate,
          ),
          updatedAt: new Date().toISOString(),
        }),
      );
      await persistAgentStore(workingStore);
      setAgentError(messageText);
      setAgentStatus(null);
    } finally {
      setAgentBusy(false);
    }
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

      const already = openFiles.find((f) => f.path === node.path);
      if (already) {
        // Re-opening with a different mode (e.g. via "Open With…") switches the
        // existing tab's view rather than duplicating it.
        if (mode && already.mode !== mode) {
          setOpenFiles((prev) =>
            prev.map((f) =>
              f.path === node.path ? { ...f, mode: resolvedMode } : f
            )
          );
        }
        setActivePath(node.path);
        if (line != null && resolvedMode === "text") {
          revealRef.current?.(line, selection);
        }
        return true;
      }

      try {
        const content =
          resolvedMode === "image" ? "" : await readFile(node.path);
        setOpenFiles((prev) => [
          ...prev,
          {
            path: node.path,
            name: node.name,
            content,
            dirty: false,
            mode: resolvedMode,
          },
        ]);
        setActivePath(node.path);
        // The editor isn't mounted with this content yet; defer the reveal.
        if (line != null && resolvedMode === "text") {
          pendingReveal.current = { line, selection };
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
  function handleEditorChange(value: string) {
    if (!activePath) return;
    setOpenFiles((prev) =>
      prev.map((f) =>
        f.path === activePath ? { ...f, content: value, dirty: true } : f
      )
    );
  }

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
        await writeFile(targetPath, file.content);
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === file.path
              ? { ...f, path: targetPath, name: baseName(targetPath), dirty: false }
              : f
          )
        );
        // If we just gave an untitled buffer a real path, follow it with focus.
        setActivePath((cur) => (cur === file.path ? targetPath : cur));
      } catch (err) {
        console.error(err);
        alert(`Não foi possível salvar:\n${err}`);
        throw err;
      }
    },
    []
  );

  /** Remove a tab from `openFiles`, moving focus off it if it was active. */
  const removeTab = useCallback(
    (path: string) => {
      setOpenFiles((prev) => {
        const next = prev.filter((f) => f.path !== path);
        if (path === activePath) {
          setActivePath(next.length ? next[next.length - 1].path : null);
        }
        return next;
      });
    },
    [activePath]
  );

  /**
   * Close a tab, guarding unsaved work. A clean buffer closes immediately; a
   * dirty one asks "Salvar / Não salvar / Cancelar" first: Salvar writes then
   * closes (an error keeps the tab), Não salvar discards and closes, Cancelar/Esc
   * aborts. Async so the close waits for the user's decision.
   */
  const handleCloseTab = useCallback(
    async (path: string) => {
      const file = openFiles.find((f) => f.path === path);
      if (!file) return;
      if (!file.dirty) {
        removeTab(path);
        return;
      }
      // Don't stack a second dialog for a tab already mid-confirmation.
      if (closingPaths.current.has(path)) return;
      closingPaths.current.add(path);
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
          removeTab(path);
        } else if (choice === "discard") {
          removeTab(path);
        }
        // "cancel" / null (Esc/overlay): do nothing.
      } finally {
        closingPaths.current.delete(path);
      }
    },
    [openFiles, askConfirm, saveFile, removeTab]
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
      const tabs: OpenTab[] = openFiles.map((f) => ({
        path: f.path,
        mode: f.mode,
      }));
      sessionSetOpenFiles(tabs, activePath).catch((err) =>
        console.error("Falha ao salvar abas da sessão:", err)
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [openFiles, activePath]);

  /**
   * Batch unsaved-changes guard for actions that drop the whole session at once
   * (close window, switch/close folder). With no dirty buffers it resolves
   * `true` straight away. Otherwise it asks "Salvar tudo / Descartar tudo /
   * Cancelar": Salvar tudo writes every dirty file and proceeds only if all
   * succeed; Descartar tudo proceeds without saving; Cancelar/Esc aborts.
   * Returns whether the caller may proceed to discard the session.
   */
  const guardDirtySession = useCallback(async (): Promise<boolean> => {
    const dirty = openFilesRef.current.filter((f) => f.dirty);
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
      const hasDirty = openFilesRef.current.some((f) => f.dirty);
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
  }, [guardDirtySession]);

  function handleCloseAll() {
    setOpenFiles([]);
    setActivePath(null);
  }

  function handleCloseOthers(path: string) {
    setOpenFiles((prev) => prev.filter((f) => f.path === path));
    setActivePath(path);
  }

  function handleCloseLeft(path: string) {
    setOpenFiles((prev) => {
      const idx = prev.findIndex((f) => f.path === path);
      const next = idx > 0 ? prev.slice(idx) : prev;
      if (activePath && !next.find((f) => f.path === activePath)) {
        setActivePath(next[0]?.path ?? null);
      }
      return next;
    });
  }

  function handleCloseRight(path: string) {
    setOpenFiles((prev) => {
      const idx = prev.findIndex((f) => f.path === path);
      const next = idx >= 0 ? prev.slice(0, idx + 1) : prev;
      if (activePath && !next.find((f) => f.path === activePath)) {
        setActivePath(next[next.length - 1]?.path ?? null);
      }
      return next;
    });
  }

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
      // Re-point the active tab at the new path and clear its dirty flag.
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === activePath
            ? { ...f, path: dest, name: baseName(dest), dirty: false }
            : f
        )
      );
      setActivePath(dest);
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
    // Refresh real compiler errors for C#/Razor on save (issue #11).
    if (rootPath && /\.(cs|cshtml|razor)$/i.test(file.name)) {
      void runBuildDiagnostics(rootPath);
    }
  }, [openFiles, activePath, saveFile, rootPath]);

  /** Close the current workspace folder, returning to the empty state. */
  const handleCloseFolder = useCallback(async () => {
    // Closing the folder discards the session — guard unsaved buffers first.
    if (!(await guardDirtySession())) return;
    setRootPath(null);
    setRootName(null);
    setRoots([]);
    setOpenFiles([]);
    setActivePath(null);
    // Clear every workspace-derived bit so no project remnants linger in this
    // same window (branch, git decorations, diagnostics, search scope, history).
    // The LSP servers and search index tear down when rootPath becomes null
    // (useLspManager watches it); forget the folder so it won't reopen on launch.
    resetWorkspaceState();
    setSearchScope(null);
    setHistoryFile(null);
    setActiveView("explorer");
    sessionSetLastFolder(null).catch(() => {});
  }, [guardDirtySession, resetWorkspaceState]);

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
    let current: "project" | "editor" = "project";
    try {
      current = localStorage.getItem(TS_PREFER_EDITOR_KEY) === "1" ? "editor" : "project";
    } catch {
      /* storage unavailable — assume project */
    }
    const choice = await askConfirm(
      "Versão do TypeScript",
      "Qual versão do TypeScript usar nas linguagens TS/JS? Recomendamos a do projeto quando houver.",
      [
        {
          label: "Versão do projeto (recomendado)",
          variant: "primary",
          value: "project",
          default: current === "project",
        },
        { label: "Versão do editor", variant: "secondary", value: "editor", default: current === "editor" },
        { label: "Cancelar", variant: "secondary", value: "cancel" },
      ]
    );
    if (choice === "project" || choice === "editor") {
      try {
        localStorage.setItem(TS_PREFER_EDITOR_KEY, choice === "editor" ? "1" : "0");
      } catch {
        /* storage unavailable — ignore */
      }
      restartLsp("typescript");
    }
  }, [askConfirm, restartLsp]);

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
          id: "file.closeWindow",
          label: "Close Window",
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
              : activityBarPos === "top"
              ? "Barra de atividades: ocultar"
              : "Barra de atividades: lateral",
          run: () =>
            setActivityBarPos((p) =>
              p === "side" ? "top" : p === "top" ? "hidden" : "side"
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
          label: "Paleta de Comandos",
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
    sidebarSide,
    activityBarPos,
  ]);

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
        return <RunPanel rootPath={rootPath} onRun={handleRun} />;
      case "agents":
        return (
          <AgentsPanel
            rootPath={rootPath}
            store={agentStore}
            selection={agentSelection}
            onCreate={handleCreateAgent}
            onSelectAgent={handleSelectAgent}
            onEdit={handleEditAgent}
            onRename={handleRenameAgent}
            onDelete={handleDeleteAgent}
            onNewConversation={handleNewAgentConversation}
            onOpenConversation={handleOpenAgentConversation}
          />
        );
      case "account":
        return <PlaceholderPanel title="CONTAS" />;
      case "settings":
        return <PlaceholderPanel title="GERENCIAR" />;
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
          />
        );
    }
  }

  return (
    <div className="app">
      <TitleBar
        title={titleText}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
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
          {activityBarPos !== "hidden" &&
            (activityBarPos === "side" || sidebarOpen) && (
              <ActivityBar
                activeView={activeView}
                onViewChange={setActiveView}
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

        <main className="app-main">
          {activeView === "agents" ? (
            <div className="agent-center-bar">
              <Codicon name="agents" size={15} />
              <span>Agentes</span>
              <span className="agent-center-workspace">
                {rootPath ?? "Nenhum workspace aberto"}
              </span>
            </div>
          ) : (
            <>
              <Breadcrumbs filePath={activePath} rootPath={rootPath} />
              <TabBar
                files={openFiles}
                activePath={activePath}
                onSelect={setActivePath}
                onClose={handleCloseTab}
                onCloseAll={handleCloseAll}
                onCloseOthers={handleCloseOthers}
                onCloseLeft={handleCloseLeft}
                onCloseRight={handleCloseRight}
                decorationFor={decorationFor}
              />
            </>
          )}
          {/* Editor + bottom panel. The panel can dock bottom (column) or to a
              side (row); the dock class flips the axis and the handle/orientation. */}
          <div
            className={`editor-area panel-${panelPos}${
              draggingPanel ? " dragging-panel" : ""
            }${armingPanel ? " arming-panel" : ""}`}
          >
            <div className="editor-host">
              {activeView === "agents" ? (
                <AgentWorkspace
                  rootPath={rootPath}
                  store={agentStore}
                  selection={agentSelection}
                  busy={agentBusy}
                  status={agentStatus}
                  error={agentError}
                  onCreate={handleCreateAgent}
                  onSaveAgent={handleSaveAgent}
                  onCancelConfig={() => setAgentSelection(null)}
                  onSendMessage={handleSendAgentMessage}
                />
              ) : activeFile && activeFile.mode === "image" ? (
                // Image-mode tab (ISSUE-70): read-only preview, no Monaco.
                <ImagePreview path={activeFile.path} name={activeFile.name} />
              ) : (
                <EditorPane
                  file={activeFile}
                  rootPath={rootPath}
                  onChange={handleEditorChange}
                  onCursorChange={(l, c) => {
                    setCursorLine(l);
                    setCursorCol(c);
                  }}
                  onProblemsChange={setProblems}
                  revealRef={revealRef}
                  pendingReveal={pendingReveal}
                  actionsRef={editorActionsRef}
                  onOpenDefinition={(path, line) =>
                    handleOpenFile(
                      { name: baseName(path), path, isDir: false },
                      line
                    )
                  }
                />
              )}
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
      </div>

      <StatusBar
        language={activeFile ? languageForFile(activeFile.name) : ""}
        line={cursorLine}
        column={cursorCol}
        fileName={activeFile?.name ?? null}
        branch={branch}
        onClickBranch={rootPath ? () => setBranchPickerOpen(true) : undefined}
        tabSize={TAB_SIZE}
        errorCount={errorCount}
        warningCount={warningCount}
        lspServers={activeLspServers}
        onRestartLsp={restartLsp}
        onShowProblems={() => showPanelTab("problems")}
        onSelectTsVersion={handleSelectTsVersion}
      />


      {quickOpenOpen && (
        <QuickOpen
          rootPath={rootPath}
          onOpenFile={handleOpenFile}
          onClose={() => setQuickOpenOpen(false)}
        />
      )}

      {commandPaletteOpen && (
        <CommandPalette
          commands={commands}
          onClose={() => setCommandPaletteOpen(false)}
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
