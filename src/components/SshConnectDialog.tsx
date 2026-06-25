import { useRef, useState } from "react";
import { Codicon } from "../icons/codicons/Codicon";
import type { SshConnectInput } from "../api";
import { useModalDismiss } from "./useModalDismiss";
import { useModalFocus } from "./useModalFocus";

interface SshConnectDialogProps {
  /** Prefill (e.g. from a saved host without a user, or a key host). */
  initial?: Partial<SshConnectInput>;
  /**
   * Opens the SSH connection. Should reject with a human-readable message; the
   * dialog shows it inline and stays open. On success the caller advances to the
   * remote folder browser.
   */
  onConnect: (input: SshConnectInput) => Promise<void>;
  /**
   * When set, Cancel / Esc / the back arrow return to the previous step (the host
   * quick-pick) instead of closing the whole flow.
   */
  onBack?: () => void;
  onClose: () => void;
}

type AuthMode = "password" | "key" | "agent";

/**
 * SSH connection form (issue #8) — the "new host" / manual step of the connect
 * flow. Host selection lives in the quick-pick before this, so the form is just
 * the target + auth fields. Cancel goes back to the picker when `onBack` is set.
 */
export function SshConnectDialog({
  initial,
  onConnect,
  onBack,
  onClose,
}: SshConnectDialogProps) {
  const dismiss = onBack ?? onClose;
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [user, setUser] = useState(initial?.user ?? "");
  const [authMode, setAuthMode] = useState<AuthMode>(
    initial?.keyPath ? "key" : "password"
  );
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? "");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);

  // Contrato de modal compartilhado: foco inicial no campo Host, trap + restore,
  // e Esc cancela/volta via `dismiss` (F2-AUD-007). O Esc deixa o onKeyDown.
  useModalFocus(surfaceRef, { initialFocus: hostRef, onEscape: dismiss });

  const authReady =
    authMode === "agent"
      ? true
      : authMode === "password"
        ? password !== ""
        : keyPath.trim() !== "";
  const canSubmit =
    host.trim() !== "" && user.trim() !== "" && authReady && !connecting;

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    setConnecting(true);
    const portNum = Number.parseInt(port, 10);
    const input: SshConnectInput = {
      host: host.trim(),
      port: Number.isFinite(portNum) && portNum > 0 ? portNum : 22,
      user: user.trim(),
      ...(authMode === "password"
        ? { password }
        : authMode === "key"
          ? { keyPath: keyPath.trim(), keyPassphrase: keyPassphrase || undefined }
          : { useAgent: true }),
    };
    try {
      await onConnect(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConnecting(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  const authTabs: { id: AuthMode; label: string }[] = [
    { id: "password", label: "Senha" },
    { id: "key", label: "Chave privada" },
    { id: "agent", label: "Agente SSH" },
  ];

  return (
    <div className="quick-open-backdrop" {...useModalDismiss(dismiss)}>
      <div
        className="ssh-card ssh-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Conectar a um host SSH"
        tabIndex={-1}
        ref={surfaceRef}
        onKeyDown={onKeyDown}
      >
        <header className="ssh-head">
          {onBack && (
            <button
              type="button"
              className="ssh-head-back"
              title="Voltar"
              aria-label="Voltar"
              onClick={onBack}
            >
              <Codicon name="arrowLeft" />
            </button>
          )}
          <span className="ssh-head-badge">
            <Codicon name="remote" />
          </span>
          <div className="ssh-head-text">
            <span className="ssh-head-title">
              {onBack ? "Novo host SSH" : "Conectar a um host SSH"}
            </span>
            <span className="ssh-head-sub">
              Edite arquivos e rode comandos numa máquina remota
            </span>
          </div>
        </header>

        <div className="ssh-dialog-row ssh-dialog-host">
          <label className="ssh-dialog-field ssh-dialog-grow">
            <span>Host</span>
            <input
              ref={hostRef}
              type="text"
              value={host}
              placeholder="exemplo.com ou 192.168.0.10"
              onChange={(e) => setHost(e.target.value)}
            />
          </label>
          <label className="ssh-dialog-field ssh-dialog-port">
            <span>Porta</span>
            <input
              type="number"
              value={port}
              min={1}
              max={65535}
              onChange={(e) => setPort(e.target.value)}
            />
          </label>
        </div>

        <label className="ssh-dialog-field">
          <span>Usuário</span>
          <input
            type="text"
            value={user}
            placeholder="root"
            onChange={(e) => setUser(e.target.value)}
          />
        </label>

        <div
          className="ssh-dialog-auth-toggle"
          role="tablist"
          aria-label="Método de autenticação"
        >
          {authTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={authMode === tab.id}
              className={authMode === tab.id ? "active" : ""}
              onClick={() => setAuthMode(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {authMode === "password" ? (
          <label className="ssh-dialog-field">
            <span>Senha</span>
            <input
              type="password"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        ) : authMode === "key" ? (
          <>
            <label className="ssh-dialog-field">
              <span>Caminho da chave privada</span>
              <input
                type="text"
                value={keyPath}
                placeholder="C:\Users\voce\.ssh\id_ed25519"
                onChange={(e) => setKeyPath(e.target.value)}
              />
            </label>
            <label className="ssh-dialog-field">
              <span>Senha da chave (opcional)</span>
              <input
                type="password"
                value={keyPassphrase}
                autoComplete="off"
                onChange={(e) => setKeyPassphrase(e.target.value)}
              />
            </label>
          </>
        ) : (
          <div className="ssh-dialog-agent-hint">
            <Codicon name="info" />
            <span>
              Usa as chaves carregadas no seu agente SSH (OpenSSH/Pageant). Nada
              a digitar — é só conectar.
            </span>
          </div>
        )}

        {error && (
          <div className="ssh-dialog-error" role="alert">
            <Codicon name="error" />
            <span>{error}</span>
          </div>
        )}

        <div className="ssh-dialog-actions">
          <button type="button" className="ssh-dialog-cancel" onClick={dismiss}>
            {onBack ? "Voltar" : "Cancelar"}
          </button>
          <button
            type="button"
            className="ssh-dialog-connect"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {connecting && <Codicon name="loading" />}
            {connecting ? "Conectando…" : "Conectar"}
          </button>
        </div>
      </div>
    </div>
  );
}
