import { pathForWorkspaceDisplay } from "../paths";
import { FileIcon } from "../icon-theme/material/FileIcon";
import { Codicon } from "../icons/codicons/Codicon";

interface BreadcrumbsProps {
  filePath: string | null;
  rootPath: string | null;
}

/**
 * Path of the active file under the tab strip (VS Code-style): folder
 * segments, chevron separators and the file — with its icon — last.
 */
export function Breadcrumbs({ filePath, rootPath }: BreadcrumbsProps) {
  if (!filePath) return null;

  const displayPath = pathForWorkspaceDisplay(filePath, rootPath);
  const segments = displayPath.split(/[\\/]/).filter(Boolean);

  return (
    <nav className="breadcrumbs" aria-label="Caminho do arquivo">
      {segments.map((seg, i) => {
        const last = i === segments.length - 1;
        return (
          <span
            key={i}
            className={`crumb${last ? " last" : ""}`}
            aria-current={last ? "page" : undefined}
          >
            {last && <FileIcon path={filePath} className="crumb-icon" />}
            <span className="crumb-label">{seg}</span>
            {!last && (
              <Codicon name="chevronRight" size={12} className="crumb-sep" />
            )}
          </span>
        );
      })}
    </nav>
  );
}
