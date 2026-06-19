import { useState } from "react";
import { TerminalView } from "./TerminalView";
import { ProblemsPanel } from "./ProblemsPanel";
import { Codicon } from "../icons/codicons/Codicon";
import type { Problem } from "../types";

interface TerminalPanelProps {
  open: boolean;
  height: number;
  cwd: string | null;
  onClose: () => void;
  problems: Problem[];
  onOpenProblem: (problem: Problem) => void;
  /** Command line a "Run" requested, or null for a plain interactive shell. */
  runCommand?: string | null;
  /** Identifies the current run; changing it spawns a fresh PTY session. */
  runNonce?: number;
}

type PanelTab = "terminal" | "problems" | "output";

export function TerminalPanel({
  open,
  height,
  cwd,
  onClose,
  problems,
  onOpenProblem,
  runCommand,
  runNonce = 0,
}: TerminalPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>("terminal");
  // Base id for the plain interactive shell; a run uses a nonce-derived id so
  // each ▶ starts a new PTY instead of reusing the previous one.
  const [baseId] = useState(() => crypto.randomUUID());
  const termId = runCommand ? `${baseId}-run-${runNonce}` : baseId;

  if (!open) return null;

  return (
    <div className="terminal-panel" style={{ height }}>
      <div className="terminal-header">
        <div className="terminal-tabs">
          {(["problems", "output", "terminal"] as PanelTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={`terminal-tab${activeTab === tab ? " active" : ""}`}
              onClick={() => setActiveTab(tab)}
              aria-pressed={activeTab === tab}
            >
              {tab === "problems"
                ? `Problemas${problems.length ? ` (${problems.length})` : ""}`
                : tab === "output"
                ? "Saída"
                : "Terminal"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="terminal-close"
          onClick={onClose}
          title="Fechar painel"
          aria-label="Fechar painel"
        >
          <Codicon name="close" size={16} />
        </button>
      </div>
      <div className="terminal-body">
        {activeTab === "terminal" ? (
          cwd ? (
            <TerminalView id={termId} cwd={cwd} command={runCommand ?? null} />
          ) : (
            <div className="panel-empty">Abra uma pasta para usar o terminal.</div>
          )
        ) : activeTab === "problems" ? (
          <ProblemsPanel problems={problems} onOpenProblem={onOpenProblem} />
        ) : (
          <div className="panel-empty">Sem saída.</div>
        )}
      </div>
    </div>
  );
}
