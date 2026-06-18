import { pathForWorkspaceDisplay } from "../paths";

interface BreadcrumbsProps {
  filePath: string | null;
  rootPath: string | null;
}

export function Breadcrumbs({ filePath, rootPath }: BreadcrumbsProps) {
  if (!filePath) return null;

  const displayPath = pathForWorkspaceDisplay(filePath, rootPath);
  const segments = displayPath.split(/[\\/]/).filter(Boolean);

  return (
    <div className="breadcrumbs">
      {segments.map((seg, i) => (
        <span key={i} className={`crumb${i === segments.length - 1 ? ' last' : ''}`}>
          {seg}
          {i < segments.length - 1 && <span className="crumb-sep">›</span>}
        </span>
      ))}
    </div>
  );
}
