import { useEffect, useRef } from "react";
import pkg from "../../package.json";
import { useModalDismiss } from "./useModalDismiss";

interface AboutDialogProps {
  /** "about" shows app name/version/link; "shortcuts" lists the keybindings. */
  mode: "about" | "shortcuts";
  /** Closes the dialog (Esc, click outside, or the close button). */
  onClose: () => void;
}

/** Static list of the app's keyboard shortcuts, shown in the "shortcuts" mode. */
const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "Ctrl+S", label: "Salvar" },
  { keys: "Ctrl+Shift+S", label: "Salvar como" },
  { keys: "Ctrl+O", label: "Abrir Arquivo" },
  { keys: "Ctrl+K Ctrl+O", label: "Abrir Pasta" },
  { keys: "Ctrl+`", label: "Alternar Terminal" },
  { keys: "Ctrl+P", label: "Quick Open" },
  { keys: "Ctrl+B", label: "Alternar Barra Lateral" },
];

/** Repository URL shown in the About view. */
const REPO_URL = "https://github.com/Vagnerking/FluentCoder";

/**
 * Modal dialog used for the Help menu's "Sobre" (about) and "Atalhos de Teclado"
 * (shortcuts) entries. Reuses the QuickOpen overlay pattern: a backdrop that
 * closes on outside click, Esc to close, and a centered Fluent surface.
 */
export function AboutDialog({ mode, onClose }: AboutDialogProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Esc closes; focus the surface so the key handler is reachable immediately.
  useEffect(() => {
    surfaceRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const title = mode === "about" ? "Sobre" : "Atalhos de Teclado";

  return (
    <div className="about-backdrop" {...useModalDismiss(onClose)}>
      <div
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={surfaceRef}
      >
        <div className="about-header">
          <span className="about-title">{title}</span>
          <button
            className="about-close"
            aria-label="Fechar"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {mode === "about" ? (
          <div className="about-body">
            <h2 className="about-app-name">Fluent Coder</h2>
            <p className="about-version">Versão {pkg.version}</p>
            <p className="about-link">
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                {REPO_URL}
              </a>
            </p>
          </div>
        ) : (
          <div className="about-body">
            <ul className="about-shortcuts">
              {SHORTCUTS.map((s) => (
                <li key={s.keys} className="about-shortcut-row">
                  <span className="about-shortcut-label">{s.label}</span>
                  <kbd className="about-shortcut-keys">{s.keys}</kbd>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
