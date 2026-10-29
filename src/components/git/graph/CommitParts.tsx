import { Fragment, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { Codicon } from "../../../icons/codicons/Codicon";
import { formatLongDate, formatRelativeDateLong } from "../../../ui/format";
import { GitAvatar } from "../GitAvatar";
import type { GraphPerson } from "../../../git/graphApi";
import {
  parseMessageBody,
  pullRequestWebUrl,
  type HostingRemote,
  type InlineToken,
  type RefPill,
} from "../../../git/graphModel";

/** Abre http(s) no navegador do SO (`window.open` não chega lá no WebKitGTK). */
export function openExternalUrl(url: string | null | undefined) {
  if (!url) return;
  void import("../../../platform/commands")
    .then((m) => m.openExternal(url))
    .catch((err) => console.error("Falha ao abrir o link externo:", err));
}

export function copyText(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/** Pílula de ref (branch/remota/tag/HEAD) com a cor da lane da branch. */
export function RefPillView({
  pill,
  active,
  onEnter,
  onLeave,
  onClick,
  compact,
}: {
  pill: RefPill;
  active?: boolean;
  onEnter?: (pill: RefPill, el: HTMLElement) => void;
  onLeave?: (pill: RefPill) => void;
  onClick?: (pill: RefPill, event: ReactMouseEvent<HTMLElement>) => void;
  compact?: boolean;
}) {
  const icon = pill.kind === "tag" ? "tag" : pill.kind === "remote" ? "cloud" : "gitBranch";
  const style = { "--pill-color": `var(--graph-lane-${pill.color})` } as CSSProperties;
  const interactive = Boolean(onClick);
  const className = `graph-ref-pill is-${pill.kind}${active ? " is-active" : ""}${compact ? " is-compact" : ""}`;
  const content = (
    <>
      <Codicon name={icon} size={12} />
      <span className="graph-ref-pill-label">{pill.label}</span>
      {pill.remote && <Codicon name="cloud" size={12} className="graph-ref-pill-remote" />}
    </>
  );
  if (!interactive) {
    return (
      <span className={className} style={style} title={pill.title}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      style={style}
      title={`${pill.title} — clique para ver a linhagem`}
      aria-pressed={active}
      onPointerEnter={(e) => onEnter?.(pill, e.currentTarget)}
      onPointerLeave={() => onLeave?.(pill)}
      onFocus={(e) => onEnter?.(pill, e.currentTarget)}
      onBlur={() => onLeave?.(pill)}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(pill, e);
      }}
    >
      {content}
    </button>
  );
}

function Inline({ tokens, hosting }: { tokens: InlineToken[]; hosting: HostingRemote | null }) {
  return (
    <>
      {tokens.map((t, i) => {
        switch (t.kind) {
          case "code":
            return <code key={i}>{t.text}</code>;
          case "bold":
            return <strong key={i}>{t.text}</strong>;
          case "link":
            return (
              <a key={i} href={t.href} onClick={(e) => (e.preventDefault(), openExternalUrl(t.href))}>
                {t.text}
              </a>
            );
          case "issue":
            return hosting ? (
              <a
                key={i}
                href={pullRequestWebUrl(hosting, t.number)}
                onClick={(e) => (e.preventDefault(), openExternalUrl(pullRequestWebUrl(hosting, t.number)))}
              >
                {t.text}
              </a>
            ) : (
              <Fragment key={i}>{t.text}</Fragment>
            );
          default:
            return <Fragment key={i}>{t.text}</Fragment>;
        }
      })}
    </>
  );
}

/** Corpo da mensagem em markdown leve (parágrafos, listas, `código`, #PR). */
export function CommitMessageBody({ body, hosting }: { body: string; hosting: HostingRemote | null }) {
  const blocks = parseMessageBody(body);
  if (!blocks.length) return null;
  return (
    <div className="commit-message-body">
      {blocks.map((b, i) =>
        b.kind === "list" ? (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>
                <Inline tokens={item} hosting={hosting} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            <Inline tokens={b.inline} hosting={hosting} />
          </p>
        )
      )}
    </div>
  );
}

/**
 * Cabeçalho de autoria (igual ao hover do VS Code): avatar, nome, "há 3
 * meses (9 de julho de 2026 às 17:05)" e uma linha por co-autor.
 */
export function CommitAuthorship({
  author,
  authorEmail,
  authorTime,
  coAuthors,
  committer,
  commitTime,
}: {
  author: string;
  authorEmail: string;
  authorTime: number;
  coAuthors: GraphPerson[];
  committer?: string;
  commitTime?: number;
}) {
  const when = authorTime * 1000;
  const committedLater = committer && commitTime && committer !== author;
  return (
    <div className="commit-authorship">
      <GitAvatar name={author} email={authorEmail} className="commit-avatar is-lg" size={64} />
      <div className="commit-authorship-text">
        <div className="commit-author-line">
          <strong className="commit-author-name">{author}</strong>
          <span className="commit-author-date">
            , {formatRelativeDateLong(when)} ({formatLongDate(when)})
          </span>
        </div>
        {coAuthors.map((p) => (
          <div className="commit-coauthor-line" key={`${p.name}<${p.email}>`}>
            <GitAvatar name={p.name} email={p.email} className="commit-avatar is-sm" size={32} />
            <span>
              {p.name} <span className="commit-coauthor-role">(Coautoria)</span>
            </span>
          </div>
        ))}
        {committedLater && (
          <div className="commit-coauthor-line is-committer">
            <Codicon name="gitCommit" size={12} />
            <span>
              Commit de {committer}, {formatRelativeDateLong(commitTime * 1000)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** "4 arquivos alterados, 93 inserções(+), 53 exclusões(-)" com cores. */
export function CommitStatsLine({ files, additions, deletions }: { files: number; additions: number; deletions: number }) {
  return (
    <div className="commit-stats-line">
      <span>
        {files} {files === 1 ? "arquivo alterado" : "arquivos alterados"}
      </span>
      {additions > 0 && (
        <span className="is-add">
          , {additions} {additions === 1 ? "inserção" : "inserções"}(+)
        </span>
      )}
      {deletions > 0 && (
        <span className="is-del">
          , {deletions} {deletions === 1 ? "exclusão" : "exclusões"}(-)
        </span>
      )}
    </div>
  );
}
