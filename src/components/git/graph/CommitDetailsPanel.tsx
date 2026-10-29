import { useEffect, useMemo, useState } from "react";
import { Codicon } from "../../../icons/codicons/Codicon";
import { IconButton } from "../../ui/IconButton";
import type { GitRevisionDiffTarget } from "../../../api";
import type { GitCommitFile } from "../../../types";
import { commitFileStatusClass, joinRepoPath } from "../../../git/gitUi";
import { gitCommitDetails, gitDiffFiles, type CommitDetails, type GraphRow } from "../../../git/graphApi";
import { buildFileTree, commitWebUrl, splitCommitMessage, type HostingRemote } from "../../../git/graphModel";
import { CommitAuthorship, CommitMessageBody, CommitStatsLine, copyText, openExternalUrl } from "./CommitParts";

/** O que o painel mostra: o commit, ou uma comparação com outra revisão. */
export type CommitDetailsMode =
  | { kind: "commit" }
  | { kind: "working" }
  | { kind: "revision"; against: string; label: string };

interface CommitDetailsPanelProps {
  row: GraphRow;
  rootPath: string;
  connId?: string;
  mode: CommitDetailsMode;
  hosting: HostingRemote | null;
  onClose: () => void;
  onSelectHash: (hash: string) => void;
  onOpenRevisionDiff?: (
    filePath: string,
    commitHash: string,
    shortHash: string,
    compareTo: GitRevisionDiffTarget,
    rootPath?: string,
    connId?: string
  ) => void;
  onOpenRevision?: (filePath: string, commitHash: string, shortHash: string, rootPath?: string, connId?: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  A: "Adicionado",
  M: "Modificado",
  D: "Excluído",
  R: "Renomeado",
  C: "Copiado",
  T: "Tipo alterado",
};

/**
 * Detalhes do commit selecionado: autoria, mensagem completa, estatísticas
 * e a árvore de arquivos (pastas comprimidas). Clicar num arquivo abre o
 * diff com o pai (ou com a revisão/árvore comparada).
 */
export function CommitDetailsPanel({
  row,
  rootPath,
  connId,
  mode,
  hosting,
  onClose,
  onSelectHash,
  onOpenRevisionDiff,
  onOpenRevision,
}: CommitDetailsPanelProps) {
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [compareFiles, setCompareFiles] = useState<GitCommitFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [fullMessage, setFullMessage] = useState(false);
  const short = row.hash.slice(0, 7);

  useEffect(() => {
    let alive = true;
    setError(null);
    setDetails(null);
    gitCommitDetails(rootPath, row.hash, connId)
      .then((d) => alive && setDetails(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [connId, rootPath, row.hash]);

  useEffect(() => {
    let alive = true;
    setCompareFiles(null);
    if (mode.kind === "commit") return;
    const from = mode.kind === "working" ? row.hash : mode.against;
    const to = mode.kind === "working" ? null : row.hash;
    gitDiffFiles(rootPath, from, to, connId)
      .then((files) => alive && setCompareFiles(files))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [connId, mode, rootPath, row.hash]);

  const files = mode.kind === "commit" ? details?.files ?? null : compareFiles;
  const tree = useMemo(() => (files ? buildFileTree(files, collapsed) : []), [files, collapsed]);
  const split = details ? splitCommitMessage(details.message) : null;
  const longBody = Boolean(split && (split.body.split("\n").length > 6 || split.body.length > 420));
  const totals = useMemo(
    () =>
      files
        ? files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 })
        : null,
    [files]
  );

  const openFile = (file: GitCommitFile) => {
    const abs = joinRepoPath(rootPath, file.path);
    const target: GitRevisionDiffTarget =
      mode.kind === "working" ? "working" : mode.kind === "revision" ? `rev:${mode.against}` : "previous";
    onOpenRevisionDiff?.(abs, row.hash, short, target, rootPath, connId);
  };

  const title =
    mode.kind === "commit"
      ? `Commit ${short}`
      : mode.kind === "working"
        ? `${short} ↔ árvore de trabalho`
        : `${mode.label} ↔ ${short}`;
  const webUrl = hosting ? commitWebUrl(hosting, row.hash) : null;

  return (
    <section className="commit-details" aria-label={`Detalhes do commit ${short}`}>
      <header className="commit-details-header">
        <Codicon name={mode.kind === "commit" ? "gitCommit" : "gitCompare"} size={14} />
        <span className="commit-details-title">{title}</span>
        <span className="commit-hover-spacer" />
        <IconButton icon="copy" size="sm" label={`Copiar hash ${short}`} onClick={() => copyText(row.hash)} />
        {webUrl && hosting && (
          <IconButton icon="linkExternal" size="sm" label={`Abrir no ${hosting.label}`} onClick={() => openExternalUrl(webUrl)} />
        )}
        <IconButton icon="close" size="sm" label="Fechar detalhes" onClick={onClose} />
      </header>
      <div className="commit-details-scroll">
        <CommitAuthorship
          author={row.author}
          authorEmail={row.authorEmail}
          authorTime={row.authorTime}
          coAuthors={row.coAuthors}
          committer={details?.committer}
          commitTime={details?.commitTime}
        />
        <div className={`commit-details-message${longBody && !fullMessage ? " is-clamped" : ""}`}>
          <div className="commit-hover-subject">{row.subject}</div>
          {split?.body ? <CommitMessageBody body={split.body} hosting={hosting} /> : null}
          {longBody && (
            <button type="button" className="commit-details-more" aria-expanded={fullMessage} onClick={() => setFullMessage((v) => !v)}>
              {fullMessage ? "Mostrar menos" : "Mostrar mensagem completa"}
            </button>
          )}
        </div>
        {details && details.parents.length > 0 && (
          <div className="commit-details-parents">
            <span>{details.parents.length > 1 ? "Pais:" : "Pai:"}</span>
            {details.parents.map((p, i) => (
              <button key={p} type="button" className="commit-parent-link" onClick={() => onSelectHash(p)}>
                {p.slice(0, 7)}
                {details.parents.length > 1 && i === 0 ? " (1º)" : ""}
              </button>
            ))}
            {details.parents.length > 1 && mode.kind === "commit" && (
              <span className="commit-details-note">arquivos comparados ao 1º pai</span>
            )}
          </div>
        )}
        <div className="commit-details-files-head" role="status">
          {files && totals ? (
            <CommitStatsLine files={files.length} additions={totals.add} deletions={totals.del} />
          ) : error ? (
            <span className="commit-hover-error">{error}</span>
          ) : (
            <span className="commit-hover-loading">Carregando arquivos…</span>
          )}
        </div>
        {files && files.length === 0 && <div className="commit-details-empty">Nenhum arquivo alterado.</div>}
        <ul className="commit-file-tree" role="tree" aria-label="Arquivos alterados">
          {tree.map((entry) =>
            entry.kind === "folder" ? (
              <li key={`d:${entry.path}`} role="treeitem" aria-expanded={!collapsed.has(entry.path)}>
                <button
                  type="button"
                  className="commit-file-row is-folder"
                  style={{ paddingLeft: 8 + entry.depth * 12 }}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(entry.path)) next.delete(entry.path);
                      else next.add(entry.path);
                      return next;
                    })
                  }
                >
                  <Codicon name={collapsed.has(entry.path) ? "chevronRight" : "chevronDown"} size={12} />
                  <Codicon name="folder" size={14} />
                  <span className="commit-file-name">{entry.label}</span>
                  <span className="commit-file-count">{entry.count}</span>
                </button>
              </li>
            ) : (
              <li key={`f:${entry.path}`} role="treeitem">
                <div className="commit-file-row-wrap">
                  <button
                    type="button"
                    className="commit-file-row"
                    style={{ paddingLeft: 20 + entry.depth * 12 }}
                    title={entry.file?.oldPath ? `${entry.file.oldPath} → ${entry.path}` : entry.path}
                    onClick={() => entry.file && openFile(entry.file)}
                  >
                    <span className={`git-commit-file-status ${commitFileStatusClass(entry.file?.status ?? "M")}`}>
                      {entry.file?.status}
                    </span>
                    <span className="commit-file-name">{entry.label}</span>
                    {entry.file?.oldPath && <span className="commit-file-old">← {entry.file.oldPath.split("/").pop()}</span>}
                    <span className="commit-file-stats" aria-label={`${entry.file?.additions ?? 0} inserções, ${entry.file?.deletions ?? 0} exclusões`}>
                      {entry.file?.additions ? <span className="is-add">+{entry.file.additions}</span> : null}
                      {entry.file?.deletions ? <span className="is-del">−{entry.file.deletions}</span> : null}
                    </span>
                    <span className="commit-sr-only">{STATUS_LABEL[entry.file?.status ?? ""] ?? ""}</span>
                  </button>
                  {onOpenRevision && entry.file?.status !== "D" && (
                    <IconButton
                      icon="file"
                      size="sm"
                      className="commit-file-open"
                      label="Abrir arquivo nesta revisão"
                      onClick={() => onOpenRevision(joinRepoPath(rootPath, entry.path), row.hash, short, rootPath, connId)}
                    />
                  )}
                </div>
              </li>
            )
          )}
        </ul>
      </div>
    </section>
  );
}
