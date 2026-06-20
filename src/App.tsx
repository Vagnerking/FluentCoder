import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { TerminalPanel } from "./components/TerminalPanel";
import { QuickOpen } from "./components/QuickOpen";
import { AboutDialog } from "./components/AboutDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import {
  buildSearchIndex,
  gitBranch,
  gitStatus,
  pickFile,
  pickFolder,
  pickSavePath,
  readDir,
  readFile,
  sessionLoad,
  sessionSetLastFolder,
  writeFile,
} from "./api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { languageForFile } from "./language";
import { buildDecorations, decoKey } from "./icon-theme/decorations";
import { useLspManager } from "./lsp/useLspManager";
import type {
  ConfirmButton,
  EditorActionsApi,
  FileNode,
  GitStatus,
  MatchSelection,
  MenuDef,
  OpenFile,
  OpenMode,
  Problem,
} from "./types";
import type { LspServerStatus } from "./components/StatusBar";
import {
  createNavigationHistory,
  mouseNavigationDirection,
  navigationTarget,
  recordNavigation,
} from "./navigationHistory";

/** Returns the last path segment, handling both Windows and POSIX separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Editor tab size — kept in one place so the StatusBar and Monaco agree. */
const TAB_SIZE = 2;

export default function App() {
  const [rootName, setRootName] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [branch, setBranch] = useState<string | null>(null);

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const navigationHistoryRef = useRef(createNavigationHistory());
  const historyNavigationTargetRef = useRef<string | null>(null);
  const historyNavigationPendingRef = useRef(false);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelHeight, setPanelHeight] = useState(220);
  const [activeView, setActiveView] = useState("explorer");
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);

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

  // Git status of the open folder, used (with diagnostics) to decorate the
  // explorer/tabs. Refreshed when the folder changes; null when not a repo.
  const [gitState, setGitState] = useState<GitStatus | null>(null);

  // path → decoration (label color + git badge), rebuilt only when an input
  // changes. The lookup normalizes separators so callers can pass any path.
  const decorations = useMemo(
    () => buildDecorations(rootPath, gitState, problems),
    [rootPath, gitState, problems]
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

  const activeFile = openFiles.find((f) => f.path === activePath) ?? null;

  const errorCount = problems.filter((p) => p.severity === "error").length;
  const warningCount = problems.filter((p) => p.severity === "warning").length;

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

  /**
   * Loads a project folder into the explorer. Shared by the folder picker and
   * the launch-time restore. When `persist` is true (the normal case), the path
   * is recorded so the next launch reopens it. `silent` swallows the error alert
   * (used on restore: a since-deleted folder shouldn't pop a dialog on startup).
   */
  const openFolder = useCallback(
    async (folder: string, opts?: { persist?: boolean; silent?: boolean }) => {
      const persist = opts?.persist ?? true;
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
    []
  );

  const refreshExplorerRoot = useCallback(async () => {
    if (!rootPath) return;
    const entries = await readDir(rootPath);
    setRoots(entries);
    gitStatus(rootPath).then(setGitState).catch(() => setGitState(null));
  }, [rootPath]);

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

  // On launch, reopen the last project folder (if any). Restore is silent so a
  // folder that was moved/deleted doesn't greet the user with an error dialog.
  useEffect(() => {
    sessionLoad()
      .then((s) => {
        if (s.lastFolder) openFolder(s.lastFolder, { silent: true });
      })
      .catch((err) => console.error("Falha ao restaurar sessão:", err));
    // openFolder is stable (useCallback []), so this runs exactly once.
  }, [openFolder]);

  /**
   * Open a file in a tab (or focus it if already open), optionally at a line.
   *
   * `mode` (ISSUE-70) picks the view: omitted ⇒ the file type's default (images
   * preview, everything else text). Image-mode tabs don't read text content —
   * the {@link ImagePreview} loads the bytes itself — so we skip `readFile`.
   */
  const handleOpenFile = useCallback(
    async (
      node: FileNode,
      line?: number,
      mode?: OpenMode,
      selection?: MatchSelection
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
        alert(`Não foi possível abrir o arquivo:\n${err}`);
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
      try {
        await writeFile(file.path, file.content);
        setOpenFiles((prev) =>
          prev.map((f) => (f.path === file.path ? { ...f, dirty: false } : f))
        );
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

  /** Persist the active buffer to disk and clear its dirty flag. */
  const handleSave = useCallback(async () => {
    const file = openFiles.find((f) => f.path === activePath);
    if (!file || !file.dirty) return;
    // saveFile already reports/throws on failure; swallow here (no close to gate).
    await saveFile(file).catch(() => {});
  }, [openFiles, activePath, saveFile]);

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

  /** Close the current workspace folder, returning to the empty state. */
  const handleCloseFolder = useCallback(async () => {
    // Closing the folder discards the session — guard unsaved buffers first.
    if (!(await guardDirtySession())) return;
    setRootPath(null);
    setRootName(null);
    setRoots([]);
    setOpenFiles([]);
    setActivePath(null);
  }, [guardDirtySession]);

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
      // Ctrl+P → Quick Open (file search by name).
      if (key === "p") {
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
  }, [handleSave, handleSaveAs, handleOpenFileDialog, handleCloseTab]);

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
      label: "File",
      items: [
        // untitled buffers: recortado p/ v2 (ISSUE-51)
        { id: "file.newTextFile", label: "New Text File", enabled: false },
        { id: "file.newFile", label: "New File", enabled: false },
        { id: "file.sep1", label: "", separator: true },
        {
          id: "file.open",
          label: "Open File…",
          accelerator: "Ctrl+O",
          run: handleOpenFileDialog,
        },
        {
          id: "file.openFolder",
          label: "Open Folder…",
          accelerator: "Ctrl+K Ctrl+O",
          run: handleOpenFolder,
        },
        { id: "file.sep2", label: "", separator: true },
        {
          id: "file.save",
          label: "Save",
          accelerator: "Ctrl+S",
          enabled: hasEditor,
          run: hasEditor ? handleSave : undefined,
        },
        {
          id: "file.saveAs",
          label: "Save As…",
          accelerator: "Ctrl+Shift+S",
          enabled: hasEditor,
          run: hasEditor ? handleSaveAs : undefined,
        },
        { id: "file.sep3", label: "", separator: true },
        { id: "file.autoSave", label: "Auto Save", enabled: false },
        { id: "file.revert", label: "Revert File", enabled: false },
        { id: "file.sep4", label: "", separator: true },
        {
          id: "file.closeEditor",
          label: "Close Editor",
          enabled: hasEditor,
          run: hasEditor && activePath ? () => handleCloseTab(activePath) : undefined,
        },
        {
          id: "file.closeFolder",
          label: "Close Folder",
          enabled: rootPath != null,
          run: rootPath != null ? handleCloseFolder : undefined,
        },
        { id: "file.sep5", label: "", separator: true },
        { id: "file.exit", label: "Exit", run: () => getCurrentWindow().close() },
      ],
    };

    const editMenu: MenuDef = {
      label: "Edit",
      items: [
        {
          id: "edit.undo",
          label: "Undo",
          accelerator: "Ctrl+Z",
          enabled: hasEditor,
          run: hasEditor ? () => runEditorAction("undo") : undefined,
        },
        {
          id: "edit.redo",
          label: "Redo",
          accelerator: "Ctrl+Y",
          enabled: hasEditor,
          run: hasEditor ? () => runEditorAction("redo") : undefined,
        },
        { id: "edit.sep1", label: "", separator: true },
        {
          id: "edit.cut",
          label: "Cut",
          accelerator: "Ctrl+X",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.clipboardCutAction")
            : undefined,
        },
        {
          id: "edit.copy",
          label: "Copy",
          accelerator: "Ctrl+C",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.clipboardCopyAction")
            : undefined,
        },
        {
          id: "edit.paste",
          label: "Paste",
          accelerator: "Ctrl+V",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.clipboardPasteAction")
            : undefined,
        },
        { id: "edit.sep2", label: "", separator: true },
        {
          id: "edit.find",
          label: "Find",
          accelerator: "Ctrl+F",
          enabled: hasEditor,
          run: hasEditor ? () => runEditorAction("actions.find") : undefined,
        },
        {
          id: "edit.replace",
          label: "Replace",
          accelerator: "Ctrl+H",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.startFindReplaceAction")
            : undefined,
        },
        { id: "edit.sep3", label: "", separator: true },
        {
          id: "edit.findInFiles",
          label: "Find in Files",
          run: () => setActiveView("search"),
        },
      ],
    };

    const selectionMenu: MenuDef = {
      label: "Selection",
      items: [
        {
          id: "selection.selectAll",
          label: "Select All",
          accelerator: "Ctrl+A",
          enabled: hasEditor,
          run: hasEditor ? () => runEditorAction("editor.action.selectAll") : undefined,
        },
        {
          id: "selection.expand",
          label: "Expand Selection",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.smartSelect.expand")
            : undefined,
        },
        {
          id: "selection.shrink",
          label: "Shrink Selection",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.smartSelect.shrink")
            : undefined,
        },
        { id: "selection.sep1", label: "", separator: true },
        {
          id: "selection.copyLineUp",
          label: "Copy Line Up",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.copyLinesUpAction")
            : undefined,
        },
        {
          id: "selection.copyLineDown",
          label: "Copy Line Down",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.copyLinesDownAction")
            : undefined,
        },
        {
          id: "selection.moveLineUp",
          label: "Move Line Up",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.moveLinesUpAction")
            : undefined,
        },
        {
          id: "selection.moveLineDown",
          label: "Move Line Down",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.moveLinesDownAction")
            : undefined,
        },
        { id: "selection.sep2", label: "", separator: true },
        {
          id: "selection.addCursorAbove",
          label: "Add Cursor Above",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.insertCursorAbove")
            : undefined,
        },
        {
          id: "selection.addCursorBelow",
          label: "Add Cursor Below",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.insertCursorBelow")
            : undefined,
        },
      ],
    };

    const viewMenu: MenuDef = {
      label: "View",
      items: [
        { id: "view.explorer", label: "Explorer", run: () => setActiveView("explorer") },
        { id: "view.search", label: "Search", run: () => setActiveView("search") },
        {
          id: "view.scm",
          label: "Source Control",
          run: () => setActiveView("git"),
        },
        { id: "view.run", label: "Run", run: () => setActiveView("debug") },
        { id: "view.sep1", label: "", separator: true },
        {
          id: "view.toggleSidebar",
          label: "Toggle Sidebar",
          accelerator: "Ctrl+B",
          run: () => setSidebarOpen((v) => !v),
        },
        {
          id: "view.toggleTerminal",
          label: "Toggle Terminal",
          accelerator: "Ctrl+`",
          run: () => setPanelOpen((v) => !v),
        },
        { id: "view.sep2", label: "", separator: true },
        {
          id: "view.commandPalette",
          label: "Command Palette",
          accelerator: "Ctrl+P",
          run: () => setQuickOpenOpen(true),
        },
        {
          id: "view.quickOpen",
          label: "Quick Open",
          accelerator: "Ctrl+P",
          run: () => setQuickOpenOpen(true),
        },
      ],
    };

    const goMenu: MenuDef = {
      label: "Go",
      items: [
        {
          id: "go.goToFile",
          label: "Go to File…",
          accelerator: "Ctrl+P",
          run: () => setQuickOpenOpen(true),
        },
        {
          id: "go.goToLine",
          label: "Go to Line…",
          accelerator: "Ctrl+G",
          enabled: hasEditor,
          run: hasEditor ? () => runEditorAction("editor.action.gotoLine") : undefined,
        },
        {
          id: "go.goToDefinition",
          label: "Go to Definition",
          accelerator: "F12",
          enabled: hasEditor,
          run: hasEditor
            ? () => runEditorAction("editor.action.revealDefinition")
            : undefined,
        },
      ],
    };

    const runMenu: MenuDef = {
      label: "Run",
      items: [
        { id: "run.start", label: "Start Debugging", enabled: false },
        { id: "run.startNoDebug", label: "Run Without Debugging", enabled: false },
        { id: "run.sep1", label: "", separator: true },
        {
          id: "run.openRunView",
          label: "Abrir Run e Depurar",
          run: () => setActiveView("debug"),
        },
      ],
    };

    const terminalMenu: MenuDef = {
      label: "Terminal",
      items: [
        {
          id: "terminal.new",
          label: "New Terminal",
          accelerator: "Ctrl+`",
          run: () => setPanelOpen(true),
        },
        { id: "terminal.split", label: "Split Terminal", enabled: false },
        { id: "terminal.kill", label: "Kill Terminal", enabled: false },
        { id: "terminal.sep1", label: "", separator: true },
        { id: "terminal.runTask", label: "Run Task…", enabled: false },
      ],
    };

    const helpMenu: MenuDef = {
      label: "Help",
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
    runEditorAction,
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

      <div className="body">
        <ActivityBar activeView={activeView} onViewChange={setActiveView} />

        {sidebarOpen && <aside className="sidebar">{renderSidebar()}</aside>}

        <main className="app-main">
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
          <div className="editor-host">
            {activeFile && activeFile.mode === "image" ? (
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
            <>
              <div
                className="panel-resize-handle"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const startY = e.clientY;
                  const startH = panelHeight;
                  const onMove = (me: PointerEvent) => {
                    const delta = startY - me.clientY;
                    setPanelHeight(
                      Math.max(80, Math.min(startH + delta, window.innerHeight * 0.7))
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
              <TerminalPanel
                open={panelOpen}
                height={panelHeight}
                cwd={rootPath}
                onClose={() => setPanelOpen(false)}
                problems={problems}
                onOpenProblem={handleOpenProblem}
                runCommand={runCommand}
                runNonce={runNonce}
                openCwd={terminalOpenCwd}
                openNonce={terminalOpenNonce}
              />
            </>
          )}
        </main>
      </div>

      <StatusBar
        language={activeFile ? languageForFile(activeFile.name) : ""}
        line={cursorLine}
        column={cursorCol}
        fileName={activeFile?.name ?? null}
        branch={branch}
        tabSize={TAB_SIZE}
        errorCount={errorCount}
        warningCount={warningCount}
        lspServers={lspServers}
        onRestartLsp={restartLsp}
      />

      {quickOpenOpen && (
        <QuickOpen
          rootPath={rootPath}
          onOpenFile={handleOpenFile}
          onClose={() => setQuickOpenOpen(false)}
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
