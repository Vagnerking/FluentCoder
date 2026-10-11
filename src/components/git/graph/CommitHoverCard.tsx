import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Codicon } from "../../../icons/codicons/Codicon";
import { IconButton } from "../../ui/IconButton";
import { gitCommitDetails, type CommitDetails, type GraphRow } from "../../../git/graphApi";
import { commitWebUrl, splitCommitMessage, type HostingRemote, type RefPill } from "../../../git/graphModel";
import {
  CommitAuthorship,
  CommitMessageBody,
  CommitStatsLine,
  RefPillView,
  copyText,
  openExternalUrl,
} from "./CommitParts";

export interface CommitCardActions {
  checkout: () => void;
  createBranch: () => void;
  cherryPick: () => void;
  revert: () => void;
  compare: (event: ReactMouseEvent<HTMLElement>) => void;
  more: (event: ReactMouseEvent<HTMLElement>) => void;
}

interface CommitHoverCardProps {
  row: GraphRow;
  rootPath: string;
  connId?: string;
  /** Retângulo da linha (viewport) e x do ponteiro (ou null = teclado). */
  anchor: { top: number; bottom: number; left: number; right: number; pointerX: number | null };
  pills: RefPill[];
  hosting: HostingRemote | null;
  isHead: boolean;
  flow: "incoming" | "outgoing" | null;
  actions: CommitCardActions;
  /** Aberto pelo teclado: o foco entra no cartão. */
  focusOnOpen: boolean;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onClose: (restoreFocus: boolean) => void;
}

const CARD_WIDTH = 440;
const GAP = 4;

/**
 * Cartão de commit (hover do grafo), com o conteúdo do hover do VS Code:
 * avatar + autor + data relativa e por extenso, co-autores, mensagem
 * completa (markdown leve), "N arquivos alterados, X inserções(+), Y
 * exclusões(-)", hash com copiar, "Abrir no GitHub/GitLab/Bitbucket" e as
 * ações do commit. Portal, interativo (o mouse pode entrar), Esc fecha.
 */
export function CommitHoverCard({
  row,
  rootPath,
  connId,
  anchor,
  pills,
  hosting,
  isHead,
  flow,
  actions,
  focusOnOpen,
  onPointerEnter,
  onPointerLeave,
  onClose,
}: CommitHoverCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({ left: -9999, top: -9999, ready: false });

  useEffect(() => {
    let alive = true;
    setDetails(null);
    setError(null);
    gitCommitDetails(rootPath, row.hash, connId)
      .then((d) => alive && setDetails(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [connId, rootPath, row.hash]);

  // Posição: abaixo da linha (acima se não couber), x perto do ponteiro.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x0 = anchor.pointerX !== null ? anchor.pointerX - 48 : anchor.left + 24;
    const left = Math.max(8, Math.min(x0, vw - w - 8));
    const below = anchor.bottom + GAP;
    const top = below + h <= vh - 8 ? below : Math.max(8, anchor.top - GAP - h);
    setPos({ left, top, ready: true });
  }, [anchor, details, error]);

  useEffect(() => {
    if (focusOnOpen && pos.ready) ref.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
  }, [focusOnOpen, pos.ready]);

  const short = row.hash.slice(0, 7);
  const split = details ? splitCommitMessage(details.message) : null;
  const webUrl = hosting ? commitWebUrl(hosting, row.hash) : null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    }
  };

  return createPortal(
    <div
      ref={ref}
      className={`commit-hover-card${pos.ready ? " is-ready" : ""}`}
      role="dialog"
      aria-labelledby={titleId}
      style={{ left: pos.left, top: pos.top, width: Math.min(CARD_WIDTH, window.innerWidth - 16) }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      <CommitAuthorship
        author={row.author}
        authorEmail={row.authorEmail}
        authorTime={row.authorTime}
        coAuthors={row.coAuthors}
      />
      <div className="commit-hover-sep" />
      <div className="commit-hover-message">
        <div className="commit-hover-subject" id={titleId}>
          {row.subject}
        </div>
        {split?.body ? <CommitMessageBody body={split.body} hosting={hosting} /> : null}
        {!details && !error && <div className="commit-skeleton" aria-hidden="true" />}
      </div>
      <div className="commit-hover-sep" />
      <div className="commit-hover-meta" role="status">
        {details ? (
          <CommitStatsLine files={details.files.length} additions={details.additions} deletions={details.deletions} />
        ) : error ? (
          <span className="commit-hover-error">{error}</span>
        ) : (
          <span className="commit-hover-loading">Carregando alterações…</span>
        )}
        {(pills.length > 0 || isHead || flow) && (
          <div className="commit-hover-refs">
            {pills.slice(0, 8).map((p) => (
              <RefPillView key={p.key} pill={p} compact />
            ))}
            {pills.length > 8 && (
              <span className="graph-ref-more" title={pills.slice(8).map((p) => p.label).join(", ")}>
                +{pills.length - 8} refs
              </span>
            )}
            {flow === "incoming" && (
              <span className="graph-flow-chip is-incoming">
                <Codicon name="arrowDown" size={12} /> a receber
              </span>
            )}
            {flow === "outgoing" && (
              <span className="graph-flow-chip is-outgoing">
                <Codicon name="arrowUp" size={12} /> a enviar
              </span>
            )}
          </div>
        )}
      </div>
      <div className="commit-hover-sep" />
      <div className="commit-hover-footer">
        <button
          type="button"
          className="commit-hash-chip"
          onClick={() => copyText(row.hash)}
          aria-label={`Copiar hash ${short}`}
          title="Copiar hash completo"
        >
          <Codicon name="gitCommit" size={14} />
          <span>{short}</span>
          <Codicon name="copy" size={12} />
        </button>
        {hosting && webUrl && (
          <>
            <span className="commit-hover-divider" aria-hidden="true" />
            <a
              className="commit-hover-link"
              href={webUrl}
              onClick={(e) => {
                e.preventDefault();
                openExternalUrl(webUrl);
              }}
            >
              <Codicon name="linkExternal" size={12} />
              Abrir no {hosting.label}
            </a>
          </>
        )}
        <span className="commit-hover-spacer" />
        <div className="commit-hover-actions" role="toolbar" aria-label="Ações do commit">
          <IconButton icon="target" size="sm" label="Fazer checkout deste commit" onClick={actions.checkout} disabled={isHead} />
          <IconButton icon="gitBranch" size="sm" label="Criar branch aqui…" onClick={actions.createBranch} />
          <IconButton icon="cherryPick" size="sm" label="Cherry-pick no HEAD" onClick={actions.cherryPick} disabled={isHead} />
          <IconButton icon="discard" size="sm" label="Reverter commit" onClick={actions.revert} />
          <IconButton icon="gitCompare" size="sm" label="Comparar com…" onClick={(e) => actions.compare(e)} />
          <IconButton icon="more" size="sm" label="Mais ações do commit" onClick={(e) => actions.more(e)} />
        </div>
      </div>
    </div>,
    document.body
  );
}
