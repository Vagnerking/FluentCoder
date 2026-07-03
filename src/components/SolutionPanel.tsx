/**
 * Solution Explorer (roadmap csharp-ide-parity, Fase D — V1).
 *
 * Parses the workspace's `.sln` (Rust `sln_parse`) and lists its projects;
 * expanding a project lists its source files (via the capped project-file
 * walk, filtered to code/content types). Per-project actions: build in the
 * integrated terminal and start debugging (Fase B's session). Solution
 * MANAGEMENT (add/remove projects, references) stays out of V1.
 */
import { useCallback, useEffect, useState } from "react";
import { listProjectFiles, slnParse, type SlnProject } from "../api";
import { debugSession } from "../dap/debugSession";
import { Codicon } from "../icons/codicons/Codicon";

interface SolutionPanelProps {
  rootPath: string | null;
  onOpenFile: (path: string, name: string) => void;
  /** Runs a shell command in the integrated terminal (same hook as RunPanel). */
  onRun: (command: string) => void;
}

/** File extensions worth showing under a project node (source + content). */
const SHOWN_EXTENSIONS = /\.(cs|cshtml|razor|csproj|json|xml|config|css|js|ts|sql|md)$/i;

interface ProjectNode {
  project: SlnProject;
  expanded: boolean;
  files: { path: string; name: string }[] | null; // null = not loaded yet
}

export function SolutionPanel({ rootPath, onOpenFile, onRun }: SolutionPanelProps) {
  const [slns, setSlns] = useState<string[]>([]);
  const [selectedSln, setSelectedSln] = useState<string>("");
  const [nodes, setNodes] = useState<ProjectNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Discover .sln files in the workspace.
  useEffect(() => {
    if (!rootPath) {
      setSlns([]);
      setSelectedSln("");
      return;
    }
    let cancelled = false;
    void listProjectFiles(rootPath)
      .then((files) => {
        if (cancelled) return;
        const found = files
          .filter((f) => f.name.toLowerCase().endsWith(".sln"))
          .map((f) => f.path);
        setSlns(found);
        setSelectedSln((cur) => (found.includes(cur) ? cur : found[0] ?? ""));
      })
      .catch(() => setSlns([]));
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  // Parse the selected solution.
  useEffect(() => {
    if (!selectedSln) {
      setNodes([]);
      return;
    }
    let cancelled = false;
    void slnParse(selectedSln)
      .then((projects) => {
        if (cancelled) return;
        setNodes(projects.map((project) => ({ project, expanded: false, files: null })));
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSln]);

  const toggle = useCallback(async (index: number) => {
    setNodes((prev) =>
      prev.map((n, i) => (i === index ? { ...n, expanded: !n.expanded } : n))
    );
    const node = nodes[index];
    if (!node || node.files !== null || node.expanded) return; // load once, on first expand
    const projectDir = node.project.csprojPath.replace(/[\\/][^\\/]+$/, "");
    try {
      const files = await listProjectFiles(projectDir);
      const shown = files
        .filter((f) => SHOWN_EXTENSIONS.test(f.name))
        .slice(0, 300)
        .map((f) => ({ path: f.path, name: f.name }));
      setNodes((prev) =>
        prev.map((n, i) => (i === index ? { ...n, files: shown } : n))
      );
    } catch {
      setNodes((prev) =>
        prev.map((n, i) => (i === index ? { ...n, files: [] } : n))
      );
    }
  }, [nodes]);

  if (!rootPath) {
    return (
      <div className="run-panel">
        <div className="explorer-header">
          <span className="explorer-title">SOLUTION EXPLORER</span>
        </div>
        <div className="panel-empty">Abra uma pasta para ver a solution.</div>
      </div>
    );
  }

  return (
    <div className="run-panel">
      <div className="explorer-header">
        <span className="explorer-title">SOLUTION EXPLORER</span>
      </div>

      {slns.length === 0 && (
        <div className="panel-empty">Nenhuma .sln encontrada no workspace.</div>
      )}

      {slns.length > 1 && (
        <div className="debug-launcher">
          <select
            className="search-input"
            value={selectedSln}
            onChange={(e) => setSelectedSln(e.target.value)}
          >
            {slns.map((p) => (
              <option key={p} value={p}>
                {p.split(/[\\/]/).pop()}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && <div className="git-error">{error}</div>}

      <div className="run-lists">
        {nodes.map((n, i) => (
          <div key={n.project.csprojPath} className="sln-project">
            <div className="sln-project-row">
              <button className="sln-expander" onClick={() => void toggle(i)}>
                <Codicon name={n.expanded ? "chevronDown" : "chevronRight"} size={14} />
                <span className="sln-project-name" title={n.project.csprojPath}>
                  {n.project.name}
                </span>
              </button>
              <button
                className="git-icon-btn"
                title={`dotnet build ${n.project.name}`}
                onClick={() => onRun(`dotnet build '${n.project.csprojPath}'`)}
              >
                <Codicon name="run" size={13} />
              </button>
              <button
                className="git-icon-btn"
                title={`Depurar ${n.project.name}`}
                onClick={() => {
                  const cwd = n.project.csprojPath.replace(/[\\/][^\\/]+$/, "");
                  void debugSession.launchProject(n.project.csprojPath, cwd);
                }}
              >
                <Codicon name="debug" size={13} />
              </button>
            </div>
            {n.expanded && n.files === null && (
              <div className="panel-empty">Carregando…</div>
            )}
            {n.expanded &&
              n.files?.map((f) => (
                <button
                  key={f.path}
                  className="sln-file-row"
                  title={f.path}
                  onClick={() => onOpenFile(f.path, f.name)}
                >
                  {f.name}
                </button>
              ))}
            {n.expanded && n.files?.length === 0 && (
              <div className="panel-empty">Sem arquivos exibíveis.</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
