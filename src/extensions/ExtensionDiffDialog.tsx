import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { useModalFocus } from "../components/useModalFocus";
import { languageForFile } from "../language";

export type ExtDocumentView =
  | {
      kind: "diff";
      title: string;
      left: { uri: string; path?: string; content: string };
      right: { uri: string; path?: string; content: string };
    }
  | { kind: "document"; title: string; content: string; path: string };

function nameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * Visualização somente leitura do `vscode.diff` / documentos virtuais pedidos
 * por uma extensão (ex.: diff proposto pelo Claude Code). PoC: modal com o
 * DiffEditor do Monaco; aceitar/rejeitar continua na própria UI da extensão.
 */
export function ExtensionDiffDialog({ view, onClose }: { view: ExtDocumentView; onClose: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalFocus(surfaceRef, { onEscape: onClose });
  const pathForLang = view.kind === "diff" ? view.right.path ?? view.right.uri : view.path;
  const language = languageForFile(nameOf(pathForLang));
  return createPortal(
    <div className="confirm-overlay" onMouseDown={onClose}>
      <div
        ref={surfaceRef}
        className="ext-diff-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ext-diff-header">
          <h2 id={titleId} className="confirm-title">
            {view.title}
          </h2>
          <button className="confirm-button" onClick={onClose}>
            Fechar
          </button>
        </div>
        <div className="ext-diff-body">
          {view.kind === "diff" ? (
            <DiffEditor
              original={view.left.content}
              modified={view.right.content}
              language={language}
              theme="fluent-acrylic-dark"
              options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, automaticLayout: true }}
            />
          ) : (
            <Editor
              value={view.content}
              language={language}
              theme="fluent-acrylic-dark"
              options={{ readOnly: true, minimap: { enabled: false }, automaticLayout: true }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
