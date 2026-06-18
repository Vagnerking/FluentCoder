import type { OpenFile } from "../types";

interface TabBarProps {
  files: OpenFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

/** Row of open-file tabs above the editor. */
export function TabBar({ files, activePath, onSelect, onClose }: TabBarProps) {
  if (files.length === 0) return null;

  return (
    <div className="tab-bar">
      {files.map((f) => (
        <div
          key={f.path}
          className={`tab${f.path === activePath ? " active" : ""}`}
          onClick={() => onSelect(f.path)}
          title={f.path}
        >
          <span className="tab-name">{f.name}</span>
          <span
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(f.path);
            }}
          >
            {f.dirty ? "●" : "×"}
          </span>
        </div>
      ))}
    </div>
  );
}
