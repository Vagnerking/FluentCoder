interface PlaceholderPanelProps {
  /** Section title shown in uppercase (e.g. "CONTROLE DE CÓDIGO"). */
  title: string;
}

/**
 * Honest stand-in for sidebar views that aren't implemented yet (Git, Debug,
 * Extensions, …). It states plainly that the feature is coming, instead of
 * pretending to be functional.
 */
export function PlaceholderPanel({ title }: PlaceholderPanelProps) {
  return (
    <div className="placeholder-panel">
      <div className="explorer-header">
        <span className="explorer-title">{title}</span>
      </div>
      <div className="placeholder-body">Em breve.</div>
    </div>
  );
}
