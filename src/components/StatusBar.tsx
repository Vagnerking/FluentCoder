interface StatusBarProps {
  language: string;
  line: number;
  column: number;
  fileName: string | null;
}

export function StatusBar({ language, line, column }: StatusBarProps) {
  const langDisplay = language
    ? language.charAt(0).toUpperCase() + language.slice(1)
    : '';

  return (
    <div className="status-bar">
      <div className="status-left">
        <span className="status-item">⎇ main</span>
        <span className="status-item">✕ 0  ⚠ 0</span>
      </div>
      <div className="status-right">
        <span className="status-item">Ln {line}, Col {column}</span>
        {langDisplay && <span className="status-item">{langDisplay}</span>}
        <span className="status-item">UTF-8</span>
        <span className="status-item">Tab Size: 2</span>
      </div>
    </div>
  );
}
