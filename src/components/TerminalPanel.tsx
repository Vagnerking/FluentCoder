import { useState } from "react";
import { TerminalView } from "./TerminalView";

interface TerminalPanelProps {
  open: boolean;
  height: number;
  cwd: string | null;
  onClose: () => void;
}

type PanelTab = "terminal" | "problems" | "output";

export function TerminalPanel({ open, height, cwd, onClose }: TerminalPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>("terminal");
  const [termId] = useState(() => crypto.randomUUID());

  if (!open) return null;

  return (
    <div className="terminal-panel" style={{ height }}>
      <div className="terminal-header">
        <div className="terminal-tabs">
          {(["problems", "output", "terminal"] as PanelTab[]).map((tab) => (
            <button
              key={tab}
              className={`terminal-tab${activeTab === tab ? " active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "problems" ? "Problemas" : tab === "output" ? "Saída" : "Terminal"}
            </button>
          ))}
        </div>
        <button className="terminal-close" onClick={onClose} title="Fechar painel">✕</button>
      </div>
      <div className="terminal-body">
        {activeTab === "terminal" && cwd ? (
          <TerminalView id={termId} cwd={cwd} />
        ) : (
          <div style={{ padding: "8px", color: "rgba(255,255,255,0.4)", fontSize: "12px" }}>
            {activeTab === "terminal" ? "Abra uma pasta para usar o terminal." : "Sem itens."}
          </div>
        )}
      </div>
    </div>
  );
}
