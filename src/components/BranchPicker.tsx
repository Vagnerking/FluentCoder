import { useEffect, useMemo, useRef, useState } from "react";
import { gitBranches } from "../api";
import { Codicon } from "../icons/codicons/Codicon";
import { useModalDismiss } from "./useModalDismiss";
import type { GitBranchInfo } from "../types";

interface BranchPickerProps {
  /** Repo root (workspace folder). Null when no folder is open. */
  rootPath: string | null;
  /** Checks out an existing branch by name. */
  onCheckout: (branch: string) => void;
  /** Creates a new branch from HEAD (prompts for the name itself). */
  onCreateBranch: () => void;
  /** Closes the picker without changing anything. */
  onClose: () => void;
}

/** The fixed actions pinned above the branch list, VSCode-style. */
type ActionId = "create" | "createFrom" | "detached";

interface PickerAction {
  id: ActionId;
  label: string;
  /** Disabled actions render dimmed with a "em breve" hint and never fire. */
  enabled: boolean;
  title?: string;
}

const ACTIONS: PickerAction[] = [
  { id: "create", label: "Criar nova branch...", enabled: true },
  {
    id: "createFrom",
    label: "Criar nova branch a partir de...",
    enabled: false,
    title: "Em breve",
  },
  {
    id: "detached",
    label: "Fazer checkout destacado...",
    enabled: false,
    title: "Em breve",
  },
];

/** A flat, navigable picker row — either a fixed action or a branch. */
type Row =
  | { kind: "action"; action: PickerAction }
  | { kind: "branch"; branch: GitBranchInfo };

/**
 * Branch picker (issue #16) — a VSCode-style Quick Pick that opens from the
 * status bar. Lists local branches most-recently-committed first, with a filter
 * box, fixed "create branch" actions, and keyboard navigation (↑/↓ + Enter, Esc
 * to close). Selecting a branch checks it out via the App's `onCheckout`.
 */
export function BranchPicker({
  rootPath,
  onCheckout,
  onCreateBranch,
  onClose,
}: BranchPickerProps) {
  const [query, setQuery] = useState("");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load the branch list once when the picker opens; focus the filter input.
  useEffect(() => {
    inputRef.current?.focus();
    if (!rootPath) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    gitBranches(rootPath)
      .then((list) => {
        if (!cancelled) setBranches(list);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  // Case-insensitive substring filter over actions (by label) and branches (by
  // name). The actions stay pinned above the matching branches.
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const actionRows: Row[] = ACTIONS.filter(
      (a) => !q || a.label.toLowerCase().includes(q)
    ).map((action) => ({ kind: "action", action }));
    const branchRows: Row[] = branches
      .filter((b) => !q || b.name.toLowerCase().includes(q))
      .map((branch) => ({ kind: "branch", branch }));
    return [...actionRows, ...branchRows];
  }, [query, branches]);

  // Keep the selection within range whenever the filtered set changes.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function activate(index: number) {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "action") {
      if (!row.action.enabled) return;
      if (row.action.id === "create") {
        onCreateBranch();
        onClose();
      }
      return;
    }
    // Selecting the current branch is a no-op — just close.
    if (row.branch.current) {
      onClose();
      return;
    }
    onCheckout(row.branch.name);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (rows.length ? (s + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) =>
        rows.length ? (s - 1 + rows.length) % rows.length : 0
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="quick-open-backdrop" {...useModalDismiss(onClose)}>
      <div className="quick-open branch-picker">
        <div className="quick-pick-title">Selecionar branch</div>
        <input
          ref={inputRef}
          className="quick-open-input"
          type="text"
          placeholder="Selecione uma branch para fazer checkout"
          value={query}
          aria-label="Seletor de branch: filtrar branches"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />

        <div className="quick-open-list" role="listbox" ref={listRef}>
          {rows.length === 0 ? (
            <div className="quick-open-empty">
              {!rootPath
                ? "Abra uma pasta de um repositório git."
                : loading
                  ? "Carregando branches…"
                  : query.trim()
                    ? "Nenhuma branch encontrada."
                    : "Nenhuma branch local."}
            </div>
          ) : (
            rows.map((row, i) =>
              row.kind === "action" ? (
                <div
                  key={`action:${row.action.id}`}
                  role="option"
                  aria-selected={i === selected}
                  aria-disabled={!row.action.enabled}
                  className={
                    "branch-picker-action" +
                    (i === selected ? " selected" : "") +
                    (row.action.enabled ? "" : " disabled")
                  }
                  title={row.action.title}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => activate(i)}
                >
                  <Codicon name="add" className="quick-open-icon" />
                  <span className="branch-picker-action-label">
                    {row.action.label}
                  </span>
                </div>
              ) : (
                <div
                  key={`branch:${row.branch.name}`}
                  role="option"
                  aria-selected={i === selected}
                  className={
                    "branch-picker-item" + (i === selected ? " selected" : "")
                  }
                  title={row.branch.name}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => activate(i)}
                >
                  <Codicon name="gitBranch" className="quick-open-icon" />
                  <div className="branch-picker-text">
                    <div className="branch-picker-primary">
                      <span className="branch-picker-name">
                        {row.branch.name}
                      </span>
                      {row.branch.current && (
                        <Codicon
                          name="success"
                          className="branch-picker-current"
                        />
                      )}
                      {row.branch.hasUpstream &&
                        (row.branch.ahead > 0 || row.branch.behind > 0) && (
                          <span className="branch-picker-track">
                            {row.branch.behind > 0 && (
                              <>
                                {row.branch.behind}
                                <Codicon name="gitPull" />
                              </>
                            )}
                            {row.branch.ahead > 0 && (
                              <>
                                {row.branch.ahead}
                                <Codicon name="gitPush" />
                              </>
                            )}
                          </span>
                        )}
                      <span className="branch-picker-date">
                        {row.branch.date}
                      </span>
                    </div>
                    <div className="branch-picker-secondary">
                      {row.branch.author} · {row.branch.short} ·{" "}
                      {row.branch.subject}
                    </div>
                  </div>
                </div>
              )
            )
          )}
        </div>
      </div>
    </div>
  );
}
