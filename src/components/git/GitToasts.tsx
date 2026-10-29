import { useSyncExternalStore } from "react";
import { IconButton } from "../ui/IconButton";
import { Codicon } from "../../icons/codicons/Codicon";
import { dismissGitToast, getGitToasts, subscribeGitToasts } from "../../git/gitToasts";

/** Pilha de avisos do Git (substitui os `alert()` das operações). */
export function GitToasts() {
  const toasts = useSyncExternalStore(subscribeGitToasts, getGitToasts, getGitToasts);
  if (toasts.length === 0) return null;
  return (
    <div className="git-toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`git-toast ${toast.severity}`}
          role={toast.severity === "error" ? "alert" : "status"}
        >
          <Codicon
            name={toast.severity === "error" ? "error" : toast.severity === "warning" ? "warning" : "info"}
            size={14}
          />
          <div className="git-toast-body">
            <span className="git-toast-title">{toast.title}</span>
            {toast.detail && <span className="git-toast-detail">{toast.detail}</span>}
          </div>
          <IconButton icon="close" size="sm" label="Fechar aviso" onClick={() => dismissGitToast(toast.id)} />
        </div>
      ))}
    </div>
  );
}
