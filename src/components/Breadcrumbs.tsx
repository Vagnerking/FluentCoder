interface BreadcrumbsProps {
  filePath: string | null;
  rootPath: string | null;
}

export function Breadcrumbs({ filePath, rootPath }: BreadcrumbsProps) {
  if (!filePath) return null;

  let relative = filePath;
  if (rootPath && filePath.startsWith(rootPath)) {
    relative = filePath.slice(rootPath.length);
  }
  const segments = relative.split(/[\\/]/).filter(Boolean);

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
