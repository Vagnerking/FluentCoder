import { useCallback, useEffect, useState } from "react";
import { FileExplorer } from "./components/FileExplorer";
import { EditorPane } from "./components/EditorPane";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { ActivityBar } from "./components/ActivityBar";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { StatusBar } from "./components/StatusBar";
import { TerminalPanel } from "./components/TerminalPanel";
import { pickFolder, readDir, readFile, writeFile } from "./api";
import { languageForFile } from "./language";
import type { FileNode, OpenFile } from "./types";

/** Returns the last path segment, handling both Windows and POSIX separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function App() {
  const [rootName, setRootName] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelHeight, setPanelHeight] = useState(220);
  const [activeView, setActiveView] = useState("explorer");

  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);

  const activeFile = openFiles.find((f) => f.path === activePath) ?? null;

  /** Native folder picker → load top-level entries into the explorer. */
  async function handleOpenFolder() {
    const folder = await pickFolder();
    if (!folder) return;
    try {
      const entries = await readDir(folder);
      setRoots(entries);
      setRootName(baseName(folder).toUpperCase());
      setRootPath(folder);
    } catch (err) {
      console.error(err);
      alert(`Não foi possível abrir a pasta:\n${err}`);
    }
  }

  /** Open a file in a tab (or focus it if already open). */
  async function handleOpenFile(node: FileNode) {
    if (node.isDir) return;

    const already = openFiles.find((f) => f.path === node.path);
    if (already) {
      setActivePath(node.path);
      return;
    }

    try {
      const content = await readFile(node.path);
      setOpenFiles((prev) => [
        ...prev,
        { path: node.path, name: node.name, content, dirty: false },
      ]);
      setActivePath(node.path);
    } catch (err) {
      console.error(err);
      alert(`Não foi possível abrir o arquivo:\n${err}`);
    }
  }

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

  // Ctrl+S / Cmd+S to save; Ctrl+` to toggle terminal.
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
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  const titleText = activeFile
    ? `${activeFile.dirty ? "● " : ""}${activeFile.name} — Code Editor`
    : "Code Editor";

  return (
    <div className="app">
      <TitleBar
        title={titleText}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />

      <div className="body">
        <ActivityBar activeView={activeView} onViewChange={setActiveView} />

        {sidebarOpen && (
          <aside className="sidebar">
            <FileExplorer
              rootName={rootName}
              roots={roots}
              activePath={activePath}
              onOpenFolder={handleOpenFolder}
              onOpenFile={handleOpenFile}
            />
          </aside>
        )}

        <main className="main">
          <Breadcrumbs filePath={activePath} rootPath={rootPath} />
          <TabBar
            files={openFiles}
            activePath={activePath}
            onSelect={setActivePath}
            onClose={handleCloseTab}
          />
          <div className="editor-host">
            <EditorPane
              file={activeFile}
              onChange={handleEditorChange}
              onCursorChange={(l, c) => {
                setCursorLine(l);
                setCursorCol(c);
              }}
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
      />
    </div>
  );
}
