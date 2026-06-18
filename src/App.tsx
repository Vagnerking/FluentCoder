import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileExplorer } from "./components/FileExplorer";
import { SearchPanel } from "./components/SearchPanel";
import { GitPanel } from "./components/GitPanel";
import { RunPanel } from "./components/RunPanel";
import { PlaceholderPanel } from "./components/PlaceholderPanel";
import { EditorPane } from "./components/EditorPane";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { ActivityBar } from "./components/ActivityBar";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { StatusBar } from "./components/StatusBar";
import { TerminalPanel } from "./components/TerminalPanel";
import { QuickOpen } from "./components/QuickOpen";
import {
  gitBranch,
  gitStatus,
  pickFolder,
  readDir,
  readFile,
  sessionLoad,
  sessionSetLastFolder,
  writeFile,
} from "./api";
import { languageForFile } from "./language";
import { buildDecorations, decoKey } from "./icon-theme/decorations";
import { useLspManager } from "./lsp/useLspManager";
import type { FileNode, GitStatus, OpenFile, Problem } from "./types";
import type { LspServerStatus } from "./components/StatusBar";

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

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelHeight, setPanelHeight] = useState(220);
  const [activeView, setActiveView] = useState("explorer");
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);

  // Current "Run": command line + a nonce that bumps on each ▶ to respawn the PTY.
  const [runCommand, setRunCommand] = useState<string | null>(null);
  const [runNonce, setRunNonce] = useState(0);

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

  // Lets Search/Problems jump to a line in the active editor.
  const revealRef = useRef<((line: number) => void) | null>(null);
  // A line to reveal once a freshly-opened file finishes mounting.
  const pendingRevealLine = useRef<number | null>(null);

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

  /** Native folder picker → load top-level entries into the explorer. */
  async function handleOpenFolder() {
    const folder = await pickFolder();
    if (!folder) return;
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

  /** Open a file in a tab (or focus it if already open), optionally at a line. */
  const handleOpenFile = useCallback(
    async (node: FileNode, line?: number) => {
      if (node.isDir) return;

      const already = openFiles.find((f) => f.path === node.path);
      if (already) {
        setActivePath(node.path);
        if (line != null) revealRef.current?.(line);
        return;
      }

      try {
        const content = await readFile(node.path);
        setOpenFiles((prev) => [
          ...prev,
          { path: node.path, name: node.name, content, dirty: false },
        ]);
        setActivePath(node.path);
        // The editor isn't mounted with this content yet; defer the reveal.
        if (line != null) pendingRevealLine.current = line;
      } catch (err) {
        console.error(err);
        alert(`Não foi possível abrir o arquivo:\n${err}`);
      }
    },
    [openFiles]
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

  function handleCloseTab(path: string) {
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.path !== path);
      if (path === activePath) {
        setActivePath(next.length ? next[next.length - 1].path : null);
      }
      return next;
    });
  }

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
    try {
      await writeFile(file.path, file.content);
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === file.path ? { ...f, dirty: false } : f))
      );
    } catch (err) {
      console.error(err);
      alert(`Não foi possível salvar:\n${err}`);
    }
  }, [openFiles, activePath]);

  // Ctrl+S / Cmd+S to save; Ctrl+` to toggle terminal; Ctrl+P for Quick Open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "`") {
        e.preventDefault();
        setPanelOpen((v) => !v);
      }
      // Ctrl+P / Cmd+P opens Quick Open (file search by name). preventDefault
      // also stops the browser/Monaco from hijacking the chord.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickOpenOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

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

  const titleText = activeFile
    ? `${activeFile.dirty ? "● " : ""}${activeFile.name} — Code Editor`
    : "Code Editor";

  /** Pick which sidebar view the activity bar selection maps to. */
  function renderSidebar() {
    switch (activeView) {
      case "search":
        return <SearchPanel rootPath={rootPath} onOpenMatch={handleOpenFile} />;
      case "explorer":
        return (
          <FileExplorer
            rootName={rootName}
            roots={roots}
            activePath={activePath}
            onOpenFolder={handleOpenFolder}
            onOpenFile={handleOpenFile}
            decorationFor={decorationFor}
          />
        );
      case "git":
        return (
          <GitPanel
            rootPath={rootPath}
            onOpenFile={(path, name) =>
              handleOpenFile({ name, path, isDir: false })
            }
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
            roots={roots}
            activePath={activePath}
            onOpenFolder={handleOpenFolder}
            onOpenFile={handleOpenFile}
            decorationFor={decorationFor}
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
      />

      <div className="body">
        <ActivityBar activeView={activeView} onViewChange={setActiveView} />

        {sidebarOpen && <aside className="sidebar">{renderSidebar()}</aside>}

        <main className="main">
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
              pendingRevealLine={pendingRevealLine}
              onOpenDefinition={(path, line) =>
                handleOpenFile(
                  { name: baseName(path), path, isDir: false },
                  line
                )
              }
            />
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
    </div>
  );
}
