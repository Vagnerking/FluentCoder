import type { Problem } from "../types";
import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";

interface ProblemsPanelProps {
  problems: Problem[];
  /** Jump to the file/line of a problem when its row is clicked. */
  onOpenProblem: (problem: Problem) => void;
}

const SEVERITY_ICON: Record<Problem["severity"], IconAction> = {
  error: "error",
  warning: "warning",
  info: "info",
};

/**
 * Lists diagnostics surfaced by Monaco's language services (the same markers
 * that power the squiggles in the editor), grouped flat with a severity glyph.
 */
export function ProblemsPanel({ problems, onOpenProblem }: ProblemsPanelProps) {
  if (problems.length === 0) {
    return <div className="panel-empty">Nenhum problema detectado.</div>;
  }

  return (
    <div className="problems-list">
      {problems.map((p, i) => (
        <div
          key={i}
          className={`problem-row problem-${p.severity}`}
          title={`${p.path}:${p.line}:${p.column}`}
          onClick={() => onOpenProblem(p)}
        >
          <span className="problem-icon">
            <Codicon name={SEVERITY_ICON[p.severity]} />
          </span>
          <span className="problem-message">{p.message}</span>
          <span className="problem-location">
            {p.name} [{p.line}, {p.column}]
          </span>
        </div>
      ))}
    </div>
  );
}
