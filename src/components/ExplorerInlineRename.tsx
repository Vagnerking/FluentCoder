import { useEffect, useRef, useState } from "react";
import { FileIcon } from "../icon-theme/material/FileIcon";

interface ExplorerInlineRenameProps {
  path: string;
  initialName: string;
  isDir: boolean;
  depth: number;
  busy: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

/**
 * Inline editor used to rename a tree node, reusing the same row chrome as the
 * creation input. Files preselect the base name (without extension), mirroring
 * VS Code; folders select the whole name.
 */
export function ExplorerInlineRename({
  path,
  initialName,
  isDir,
  depth,
  busy,
  error,
  onSubmit,
  onCancel,
}: ExplorerInlineRenameProps) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select the base name (before the last dot) for files; whole name otherwise.
    const dot = initialName.lastIndexOf(".");
    if (!isDir && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
    // Run once per rename target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="explorer-inline-wrap">
      <div className="tree-row explorer-inline-row" style={{ paddingLeft: depth * 12 + 6 }}>
        <span className="tree-chevron" />
        <FileIcon path={path} isDir={isDir} className="tree-icon" />
        <input
          ref={inputRef}
          className="explorer-inline-input"
          aria-label="Novo nome"
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit(name);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => {
            if (!busy) onCancel();
          }}
        />
      </div>
      {error && (
        <div className="explorer-inline-error" role="alert" style={{ paddingLeft: depth * 12 + 34 }}>
          {error}
        </div>
      )}
    </div>
  );
}
