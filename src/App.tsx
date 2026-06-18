import { useCallback, useEffect, useState } from "react";
import { FileExplorer } from "./components/FileExplorer";
import { EditorPane } from "./components/EditorPane";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { pickFolder, readDir, readFile, writeFile } from "./api";
import type { FileNode, OpenFile } from "./types";

/** Returns the last path segment, handling both Windows and POSIX separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function App() {
  const [rootName, setRootName] = useState<string | null>(null);
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  const activeFile = openFiles.find((f) => f.path === activePath) ?? null;

  /** Native folder picker → load top-level entries into the explorer. */
  async function handleOpenFolder() {
    const folder = await pickFolder();
    if (!folder) return;
    try {
      const entries = await readDir(folder);
      setRoots(entries);
      setRootName(baseName(folder).toUpperCase());
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
        // Focus the neighbouring tab, if any.
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

  // Ctrl+S / Cmd+S to save the active file.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
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
          <TabBar
            files={openFiles}
            activePath={activePath}
            onSelect={setActivePath}
            onClose={handleCloseTab}
          />
          <div className="editor-host">
            <EditorPane file={activeFile} onChange={handleEditorChange} />
          </div>
        </main>
      </div>
    </div>
  );
}
