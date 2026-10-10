/**
 * Avisos das extensões no canto inferior direito: progresso de
 * `withProgress({ location: Notification })` (barra + **Cancelar** ligado ao
 * CancellationToken) e a mensagem simples corrente (`show*Message` sem
 * botões), empilhados para não se sobreporem.
 */
import { useSyncExternalStore } from "react";
import { Button, IconButton } from "../components/ui";
import { extHost } from "./client";
import { markCancelling, progressLabel, progressSnapshot, subscribeProgress } from "./progress";
import "./extOverlays.css";

export interface ExtMessageToast {
  severity: string;
  message: string;
}

export function cancelExtProgress(id: string): void {
  markCancelling(id);
  void extHost.notify("cancelProgress", { id });
}

export function ExtProgressToasts({ message, onDismissMessage }: { message: ExtMessageToast | null; onDismissMessage(): void }) {
  const all = useSyncExternalStore(subscribeProgress, progressSnapshot);
  const notes = all.filter((p) => p.location === "notification");
  if (notes.length === 0 && !message) return null;
  return (
    <div className="ext-toast-stack">
      {message && (
        <div className={`ext-toast ${message.severity}`} role={message.severity === "error" ? "alert" : "status"}>
          <div className="ext-toast-row">
            <span
              className={`ext-toast-icon codicon codicon-${message.severity === "error" ? "error" : message.severity === "warning" ? "warning" : "info"}`}
              aria-hidden="true"
            />
            <span className="ext-toast-body">{message.message}</span>
            <IconButton icon="close" size="sm" label="Fechar aviso" onClick={onDismissMessage} />
          </div>
        </div>
      )}
      {notes.map((p) => {
        const label = progressLabel(p);
        return (
          <div key={p.id} className="ext-toast" role="status" aria-live="polite" aria-busy="true">
            <div className="ext-toast-row">
              <span className="ext-toast-icon codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />
              <span className="ext-toast-body">
                {label}
                <span className="ext-toast-source">{p.extensionName}</span>
              </span>
            </div>
            <div
              className={`ext-toast-bar${p.percent === undefined ? " indeterminate" : ""}`}
              role="progressbar"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={p.percent === undefined ? undefined : Math.round(p.percent)}
            >
              <span style={p.percent === undefined ? undefined : { width: `${p.percent}%` }} />
            </div>
            {p.cancellable && (
              <div className="ext-toast-actions">
                <Button size="sm" variant="secondary" loading={!!p.cancelling} onClick={() => cancelExtProgress(p.id)}>
                  {p.cancelling ? "Cancelando…" : "Cancelar"}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
