/**
 * Revisão de alteração proposta pelo Claude Code (ferramenta `openDiff` da
 * ponte IDE — ver `src/agents/ideBridge.ts`). Cobre a área do editor com o
 * diff editor do Monaco (original × proposta, lado direito editável) e as
 * ações Aceitar (Ctrl+Enter) / Rejeitar (Esc). O CLI fica bloqueado até a
 * decisão; com várias propostas, revisa-se uma por vez (fila).
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import * as monaco from "monaco-editor";
import { whenMonacoReady } from "../monaco-loader";
import { Codicon } from "../icons/codicons/Codicon";
import { languageForFile } from "../language";
import { formatShortcutsInText } from "../platform";
import type { PendingDiff } from "../agents/ideBridge";

interface Props {
  diff: PendingDiff;
  /** Total na fila (inclui este). */
  queued: number;
  rootPath: string | null;
  onAccept: (id: string, finalText: string) => Promise<void> | void;
  onReject: (id: string) => void;
  /** Quem propôs (padrão: a ponte IDE do Claude Code; extensões passam o nome delas). */
  sourceLabel?: string;
  /**
   * Chamado quando o diff editor existe (ex.: extensões ligam os threads de
   * comentário por hunk e as edições do lado direito ao host). Devolve a limpeza.
   */
  onEditorReady?: (editor: monaco.editor.IStandaloneDiffEditor) => (() => void) | void;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Caminho relativo ao workspace para o subtítulo (absoluto se for de fora). */
function displayPath(path: string, root: string | null): string {
  if (!root) return path;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/$/, "");
  const p = norm(path);
  const r = norm(root);
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : path;
}

export function ClaudeDiffReview({ diff, queued, rootPath, onAccept, onReject, sourceLabel = "Claude Code", onEditorReady }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const readyRef = useRef(onEditorReady);
  readyRef.current = onEditorReady;

  // Último callback/estado lidos pelos atalhos registrados no Monaco.
  const actionsRef = useRef({ accept: () => {}, reject: () => {} });
  actionsRef.current = {
    accept: () => {
      if (saving) return;
      const text = editorRef.current?.getModifiedEditor().getValue() ?? diff.proposed;
      setSaving(true);
      void Promise.resolve(onAccept(diff.id, text)).finally(() => setSaving(false));
    },
    reject: () => {
      if (!saving) onReject(diff.id);
    },
  };

  useEffect(() => {
    let disposed = false;
    const created: monaco.IDisposable[] = [];
    void whenMonacoReady.then(() => {
      if (disposed || !hostRef.current) return;
      const language = languageForFile(baseName(diff.newPath), diff.newPath);
      // Esquema próprio: os modelos do diff nunca são confundidos com arquivos
      // (LSP, ponte IDE e Problemas só olham `file://`).
      const uri = (side: string) =>
        monaco.Uri.from({ scheme: "fluent-diff", path: `/${diff.id}/${side}/${baseName(diff.newPath)}` });
      const original = monaco.editor.createModel(diff.original, language, uri("original"));
      const modified = monaco.editor.createModel(diff.proposed, language, uri("proposed"));
      const editor = monaco.editor.createDiffEditor(hostRef.current, {
        theme: "fluent-acrylic-dark",
        automaticLayout: true,
        renderSideBySide: true,
        originalEditable: false,
        readOnly: false,
        fontSize: 14,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderOverviewRuler: true,
      });
      editor.setModel({ original, modified });
      editor.getModifiedEditor().addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
        () => actionsRef.current.accept()
      );
      editor.getOriginalEditor().addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
        () => actionsRef.current.accept()
      );
      editorRef.current = editor;
      const cleanup = readyRef.current?.(editor);
      if (cleanup) created.push({ dispose: cleanup });
      created.push(editor, original, modified);
      acceptRef.current?.focus();
    });
    return () => {
      disposed = true;
      editorRef.current = null;
      // Editor antes dos modelos (a ordem de push já garante).
      created.forEach((d) => d.dispose());
    };
  }, [diff.id, diff.newPath, diff.original, diff.proposed]);

  const onKeyDown = (e: KeyboardEvent) => {
    // Esc só rejeita quando nenhum widget do Monaco (sugestão, busca…) o
    // consumiu — o Monaco chama preventDefault quando trata a tecla.
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      actionsRef.current.reject();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.defaultPrevented) {
      e.preventDefault();
      actionsRef.current.accept();
    }
  };

  return (
    <section
      className="claude-diff"
      role="region"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <header className="claude-diff-header">
        <Codicon name="agents" className="claude-diff-icon" />
        <div className="claude-diff-heading">
          <h2 id={titleId} className="claude-diff-title" title={diff.tabName}>
            {diff.tabName}
          </h2>
          <span className="claude-diff-path" title={diff.newPath}>
            {displayPath(diff.newPath, rootPath)}
            {diff.isNewFile ? " · novo arquivo" : ""}
            {" · "}Alteração proposta pelo {sourceLabel}. Você pode editar o lado
            direito antes de aceitar.
          </span>
        </div>
        {queued > 1 && (
          <span className="claude-diff-queue" role="status">
            1 de {queued}
          </span>
        )}
        <div className="claude-diff-actions">
          <button
            type="button"
            className="confirm-button confirm-secondary"
            title="Rejeitar (Esc)"
            disabled={saving}
            onClick={() => actionsRef.current.reject()}
          >
            <Codicon name="close" /> Rejeitar
          </button>
          <button
            ref={acceptRef}
            type="button"
            className="confirm-button confirm-primary"
            title={formatShortcutsInText("Aceitar e salvar (Ctrl+Enter)")}
            disabled={saving}
            aria-busy={saving}
            onClick={() => actionsRef.current.accept()}
          >
            <Codicon name="success" /> {saving ? "Salvando…" : "Aceitar"}
          </button>
        </div>
      </header>
      {diff.error && (
        <div className="claude-diff-error" role="alert">
          <Codicon name="error" /> {diff.error} Verifique as permissões do
          arquivo e tente Aceitar de novo, ou Rejeite.
        </div>
      )}
      <div ref={hostRef} className="claude-diff-editor" />
    </section>
  );
}
