import { useEffect, useMemo, useRef, useState } from "react";
import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";
import { FileIcon } from "../icon-theme/material/FileIcon";
import { useModalDismiss } from "./useModalDismiss";

/** One row in a {@link QuickPick}. */
export interface QuickPickItem {
  id: string;
  /** Primary text. */
  label: string;
  /** Inline, dimmed text shown right after the label on the same line. */
  description?: string;
  /** Secondary line, dimmed below the label. */
  detail?: string;
  /** Leading codicon (used when {@link iconFile} is absent). */
  icon?: IconAction;
  /**
   * A file name/path whose Material file-type icon is shown instead of a codicon
   * — e.g. `"x.tsx"` to show the TypeScript-React icon. Takes precedence over
   * {@link icon}.
   */
  iconFile?: string;
  /** Extra text matched by the filter but not displayed. */
  keywords?: string;
  /** Pins the row above the filtered list (e.g. an "add new" action). */
  pinned?: boolean;
  /** Optional danger styling. */
  danger?: boolean;
}

interface QuickPickProps {
  placeholder: string;
  items: QuickPickItem[];
  /** Optional title bar above the input. */
  title?: string;
  onPick: (item: QuickPickItem) => void;
  onClose: () => void;
}

/**
 * Generic VS Code-style quick pick: a filter input over a list, keyboard driven
 * (↑/↓ + Enter, Esc to close). Reuses the QuickOpen overlay/visual language so
 * the command palette, SSH host picker and file open all feel like one UI.
 */
export function QuickPick({
  placeholder,
  items,
  title,
  onPick,
  onClose,
}: QuickPickProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (it: QuickPickItem) =>
      !q ||
      `${it.label} ${it.detail ?? ""} ${it.keywords ?? ""}`
        .toLowerCase()
        .includes(q);
    const pinned = items.filter((it) => it.pinned && matches(it));
    const rest = items.filter((it) => !it.pinned && matches(it));
    return [...pinned, ...rest];
  }, [query, items]);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);
  useEffect(() => {
    (listRef.current?.children[selected] as HTMLElement | undefined)?.scrollIntoView(
      { block: "nearest" }
    );
  }, [selected]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (filtered.length ? (s + 1) % filtered.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) =>
        filtered.length ? (s - 1 + filtered.length) % filtered.length : 0
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[selected];
      if (it) onPick(it);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="quick-open-backdrop" {...useModalDismiss(onClose)}>
      <div className="quick-open quick-pick">
        {title && <div className="quick-pick-title">{title}</div>}
        <input
          ref={inputRef}
          className="quick-open-input"
          type="text"
          placeholder={placeholder}
          value={query}
          aria-label={title ?? placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="quick-open-list" role="listbox" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="quick-open-empty">Nenhum resultado.</div>
          ) : (
            filtered.map((it, i) => (
              <div
                key={it.id}
                role="option"
                aria-selected={i === selected}
                className={
                  "quick-pick-item" +
                  (i === selected ? " selected" : "") +
                  (it.danger ? " danger" : "")
                }
                title={it.detail}
                onMouseMove={() => setSelected(i)}
                onClick={() => onPick(it)}
              >
                {it.iconFile ? (
                  <FileIcon
                    path={it.iconFile}
                    size={16}
                    className="quick-pick-icon"
                  />
                ) : (
                  <Codicon
                    name={it.icon ?? "chevronRight"}
                    className="quick-pick-icon"
                  />
                )}
                <div className="quick-pick-text">
                  <span className="quick-pick-primary">
                    <span className="quick-pick-label">{it.label}</span>
                    {it.description && (
                      <span className="quick-pick-description">
                        {it.description}
                      </span>
                    )}
                  </span>
                  {it.detail && (
                    <span className="quick-pick-detail">{it.detail}</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
