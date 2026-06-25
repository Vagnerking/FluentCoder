import { useId, useRef, useState } from "react";
import { Codicon } from "../icons/codicons/Codicon";
import { useModalDismiss } from "./useModalDismiss";
import { useModalFocus } from "./useModalFocus";

interface QuickInputProps {
  /** Title bar text (e.g. "Senha de rafael@host"). */
  title?: string;
  placeholder?: string;
  /** Hint shown under the input when there's no error/progress. */
  prompt?: string;
  password?: boolean;
  /**
   * Submits the value. Async — reject with a message to show an inline error and
   * keep the input open (e.g. a wrong password); resolve to let the caller close.
   */
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}

/**
 * Generic VS Code-style quick input: a single-line prompt (text or password)
 * with Enter to submit and Esc to cancel. Used by the SSH flow to ask for a
 * password without leaving the quick-pick visual language.
 */
export function QuickInput({
  title,
  placeholder,
  prompt,
  password,
  onSubmit,
  onClose,
}: QuickInputProps) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  // Contrato de modal compartilhado: foco inicial no input, trap + restore, e
  // Esc cancela (F2-AUD-007). O Esc deixa de ser tratado no onKeyDown do input.
  useModalFocus(surfaceRef, { initialFocus: inputRef, onEscape: onClose });

  async function submit() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await onSubmit(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="quick-open-backdrop" {...useModalDismiss(onClose)}>
      <div
        className="quick-open quick-input"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : "Entrada rápida"}
        tabIndex={-1}
        ref={surfaceRef}
      >
        {title && (
          <div id={titleId} className="quick-pick-title">
            {title}
          </div>
        )}
        <input
          ref={inputRef}
          className="quick-open-input"
          type={password ? "password" : "text"}
          placeholder={placeholder}
          value={value}
          disabled={busy}
          aria-label={title ?? placeholder ?? "Entrada rápida"}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {error ? (
          <div className="quick-input-msg error">
            <Codicon name="error" /> {error}
          </div>
        ) : busy ? (
          <div className="quick-input-msg">
            <Codicon name="loading" /> Conectando…
          </div>
        ) : prompt ? (
          <div className="quick-input-msg">{prompt}</div>
        ) : null}
      </div>
    </div>
  );
}
