import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "../quickOpen/fuzzy";

/**
 * One entry in the Command Palette. The registry lives in App.tsx (so commands
 * can capture app state/actions); adding a command is one object here.
 */
export interface Command {
  /** Stable id, also the React key. */
  id: string;
  /** Title shown in the list and fuzzy-matched against the query. */
  title: string;
  /** Optional dimmed secondary text (e.g. a category). */
  detail?: string;
  /** Runs the command. The palette closes right before this fires. */
  run: () => void;
}

interface CommandPaletteProps {
  commands: Command[];
  onClose: () => void;
}

/**
 * Splits a label into highlighted/plain runs from matched indices, so the
 * matched letters can be bolded VSCode-style (mirrors QuickOpen).
 */
function highlight(label: string, positions: number[]) {
  if (positions.length === 0) return label;
  const set = new Set(positions);
  const out: React.ReactNode[] = [];
  let run = "";
  let matchRun = "";
  for (let i = 0; i < label.length; i++) {
    if (set.has(i)) {
      if (run) {
        out.push(run);
        run = "";
      }
      matchRun += label[i];
    } else {
      if (matchRun) {
        out.push(
          <span key={i} className="quick-open-match">
            {matchRun}
          </span>
        );
        matchRun = "";
      }
      run += label[i];
    }
  }
  if (matchRun) out.push(<span className="quick-open-match">{matchRun}</span>);
  if (run) out.push(run);
  return out;
}

interface RankedCommand {
  command: Command;
  positions: number[];
  score: number;
}

/**
 * Command Palette (Ctrl+Shift+P). A floating, centered overlay that fuzzy-filters
 * a registry of commands by title and runs the selected one on Enter — the
 * command counterpart of {@link QuickOpen} (files). Reuses the `quick-open-*`
 * styles. The starter command is "Resetar Servidores de Código" (issue #12).
 */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const ranked = useMemo<RankedCommand[]>(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      return commands.map((command) => ({ command, positions: [], score: 0 }));
    }
    const out: RankedCommand[] = [];
    for (const command of commands) {
      const m = fuzzyMatch(trimmed, command.title);
      if (m) out.push({ command, positions: m.positions, score: m.score });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }, [query, commands]);

  // Keep the selection in range whenever the result set changes.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, ranked.length - 1)));
  }, [ranked.length]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function runAt(index: number) {
    const hit = ranked[index];
    if (!hit) return;
    onClose();
    hit.command.run();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (ranked.length ? (s + 1) % ranked.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) =>
        ranked.length ? (s - 1 + ranked.length) % ranked.length : 0
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="quick-open-backdrop" onMouseDown={onClose}>
      <div className="quick-open" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-open-input"
          type="text"
          placeholder="Digite o nome de um comando…"
          value={query}
          aria-label="Paleta de Comandos: pesquisar comandos"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />

        <div className="quick-open-list" role="listbox" ref={listRef}>
          {ranked.length === 0 ? (
            <div className="quick-open-empty">Nenhum comando encontrado.</div>
          ) : (
            ranked.map((hit, i) => (
              <div
                key={hit.command.id}
                role="option"
                aria-selected={i === selected}
                className={"quick-open-item" + (i === selected ? " selected" : "")}
                title={hit.command.title}
                onMouseMove={() => setSelected(i)}
                onClick={() => runAt(i)}
              >
                <span className="quick-open-name">
                  {highlight(hit.command.title, hit.positions)}
                </span>
                {hit.command.detail && (
                  <span className="quick-open-path">{hit.command.detail}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
