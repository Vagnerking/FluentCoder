import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";
import logoUrl from "../assets/fluent-coder.png";

export interface WelcomeScreenProps {
  /** Whether a folder is currently open (drives the contextual layout). */
  hasFolder: boolean;
  /** Name of the open folder (shown when `hasFolder`). */
  folderName?: string | null;
  /** Absolute path of the open folder (filtered out of the recents list). */
  folderPath?: string | null;
  /** Recently-opened folder paths (most recent first). */
  recents: string[];
  onNewFile: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onConnectRemote: () => void;
  onOpenRecent: (path: string) => void;
}

/** Real, implemented shortcuts shown (informationally) once a project is open. */
const HINTS: { label: string; keys: string[] }[] = [
  { label: "Mostrar Comandos", keys: ["Ctrl", "Shift", "P"] },
  { label: "Ir para Arquivo", keys: ["Ctrl", "P"] },
  { label: "Buscar no Projeto", keys: ["Ctrl", "Shift", "F"] },
  { label: "Novo Arquivo", keys: ["Ctrl", "N"] },
  { label: "Alternar Barra Lateral", keys: ["Ctrl", "B"] },
  { label: "Alternar Terminal", keys: ["Ctrl", "`"] },
];

interface Action {
  id: string;
  icon: IconAction;
  label: string;
  hint?: string;
  run: () => void;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
function dirName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.join("/") || path;
}

function ActionButton({ a }: { a: Action }) {
  return (
    <button type="button" className="welcome-action" onClick={a.run}>
      <span className="welcome-action-icon">
        <Codicon name={a.icon} size={16} />
      </span>
      <span className="welcome-action-label">{a.label}</span>
      {a.hint && <kbd className="welcome-action-hint">{a.hint}</kbd>}
    </button>
  );
}

/**
 * The "no editor" screen — CONTEXTUAL and branded (Fluent Coder identity):
 * - WITH a project open → a refined home: the wordmark + project context and a
 *   panel of REAL, clickable shortcuts (each runs an actually-implemented
 *   command and shows its key chord). No "open file/folder" prompts.
 * - WITH NOTHING open → a welcome with create/open actions + recent folders, so
 *   the user has a way to get started.
 */
export function WelcomeScreen(props: WelcomeScreenProps) {
  if (props.hasFolder) {
    // Just calm, non-interactive hints filling the empty editor — discreet, no
    // highlights, no cards. The shortcuts are real (work from the keyboard).
    return (
      <div className="welcome welcome-home">
        <div className="welcome-home-inner">
          <div className="welcome-home-brand">
            <img className="welcome-home-logo" src={logoUrl} alt="" />
            <div>
              <div className="welcome-wordmark">Fluent Coder</div>
              {props.folderName && (
                <div className="welcome-context">{props.folderName}</div>
              )}
            </div>
          </div>
          <div className="welcome-hints">
            {HINTS.map((h) => (
              <div className="welcome-hint" key={h.label}>
                <span className="welcome-hint-label">{h.label}</span>
                <span className="welcome-hint-keys">
                  {h.keys.map((k, i) => (
                    <kbd key={i}>{k}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const actions: Action[] = [
    { id: "new", icon: "newFile", label: "Novo Arquivo", hint: "Ctrl+N", run: props.onNewFile },
    { id: "openFile", icon: "file", label: "Abrir Arquivo…", hint: "Ctrl+O", run: props.onOpenFile },
    {
      id: "openFolder",
      icon: "folderOpened",
      label: "Abrir Pasta…",
      hint: "Ctrl+K Ctrl+O",
      run: props.onOpenFolder,
    },
    { id: "remote", icon: "remote", label: "Conectar via SSH…", run: props.onConnectRemote },
  ];
  const recents = props.recents.filter((p) => p !== props.folderPath);

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <header className="welcome-hero">
          <img className="welcome-logo-img" src={logoUrl} alt="Fluent Coder" />
          <div>
            <h1 className="welcome-title">Fluent Coder</h1>
            <p className="welcome-subtitle">
              Editor de código — comece criando um arquivo ou abrindo uma pasta.
            </p>
          </div>
        </header>

        <div className="welcome-columns">
          <section className="welcome-col">
            <h2 className="welcome-col-title">Começar</h2>
            <div className="welcome-actions">
              {actions.map((a) => (
                <ActionButton key={a.id} a={a} />
              ))}
            </div>
          </section>
          <section className="welcome-col">
            <h2 className="welcome-col-title">Recentes</h2>
            {recents.length === 0 ? (
              <p className="welcome-empty">Nenhuma pasta recente ainda.</p>
            ) : (
              <div className="welcome-recents">
                {recents.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className="welcome-recent"
                    title={path}
                    onClick={() => props.onOpenRecent(path)}
                  >
                    <Codicon name="folder" size={15} />
                    <span className="welcome-recent-name">{baseName(path)}</span>
                    <span className="welcome-recent-path">{dirName(path)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <footer className="welcome-tip">
          <Codicon name="commandPalette" size={13} />
          Dica: pressione <kbd>Ctrl+Shift+P</kbd> para abrir a Paleta de Comandos.
        </footer>
      </div>
    </div>
  );
}
