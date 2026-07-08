import { useEffect, useState } from "react";
import {
  getCachedIndex,
  invalidateIndex,
  loadIndex,
  mentionsFor,
  type Mention,
  type Mentions,
} from "../knowledge/knowledgeCache";
import { FileIcon } from "../icon-theme/material/FileIcon";

interface BacklinksPanelProps {
  rootPath: string | null;
  /** SSH connection id when the active root is remote. */
  connId?: string | null;
  /** The file whose connections are shown; null ⇒ "open a file" hint. */
  activePath: string | null;
  /** Lets heavier workspace analysis yield to the first paint of the active view. */
  deferLoadMs?: number;
  onOpenFile: (path: string) => void;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

const RELATION_LABEL: Record<Mention["relation"], string> = {
  link: "link",
  wikilink: "wikilink",
  import: "import",
};

function MentionSection({
  title,
  mentions,
  onOpenFile,
}: {
  title: string;
  mentions: Mention[];
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className="backlinks-section">
      <div className="backlinks-section-head">
        <span>{title}</span>
        <span className="backlinks-count">{mentions.length}</span>
      </div>
      {mentions.length === 0 ? (
        <div className="backlinks-none">Nenhum</div>
      ) : (
        mentions.map((m, i) => (
          <button
            key={`${title}:${m.path}:${m.line}:${i}`}
            type="button"
            className="backlinks-row"
            title={`${m.path}:${m.line}`}
            onClick={() => onOpenFile(m.path)}
          >
            <div className="backlinks-row-head">
              <FileIcon path={m.path} className="backlinks-icon" />
              <span className="backlinks-name">{m.name}</span>
              <span className={`backlinks-rel rel-${m.relation}`}>
                {RELATION_LABEL[m.relation]}
              </span>
            </div>
            {m.snippet && <div className="backlinks-snippet">{m.snippet}</div>}
          </button>
        ))
      )}
    </div>
  );
}

/**
 * Obsidian-style "linked mentions": for the active file, the files that link TO
 * it (backlinks) and the files it links to (outgoing) — each with the source
 * line + a context snippet. Derived from the shared knowledge index.
 */
export function BacklinksPanel({
  rootPath,
  connId = null,
  activePath,
  deferLoadMs = 0,
  onOpenFile,
}: BacklinksPanelProps) {
  const [mentions, setMentions] = useState<Mentions | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!rootPath || !activePath) {
      setMentions(null);
      return;
    }
    const cached = getCachedIndex(rootPath, connId);
    if (cached) {
      setLoading(false);
      setMentions(mentionsFor(cached, activePath));
      return;
    }
    let cancelled = false;
    setMentions(null);
    const start = () => {
      if (cancelled) return;
      setLoading(true);
      loadIndex(rootPath, connId)
        .then((idx) => {
          if (!cancelled) setMentions(mentionsFor(idx, activePath));
        })
        .catch(() => {
          if (!cancelled) setMentions(null);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    const timer = deferLoadMs > 0 ? window.setTimeout(start, deferLoadMs) : null;
    if (timer === null) start();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [rootPath, connId, activePath, deferLoadMs, reloadKey]);

  return (
    <div className="backlinks-panel">
      <div className="explorer-header">
        <span className="explorer-title">BACKLINKS</span>
        <button
          className="git-icon-btn"
          title="Reanalisar o workspace"
          onClick={() => {
            invalidateIndex();
            setReloadKey((k) => k + 1);
          }}
        >
          ⟳
        </button>
      </div>

      {!rootPath ? (
        <div className="panel-empty">Abra uma pasta para ver as conexões.</div>
      ) : !activePath ? (
        <div className="panel-empty">Abra um arquivo para ver suas conexões.</div>
      ) : loading && !mentions ? (
        <div className="panel-empty">Analisando o workspace…</div>
      ) : (
        <div className="backlinks-body">
          <div className="backlinks-current" title={activePath}>
            <FileIcon path={activePath} className="backlinks-icon" />
            <span className="backlinks-name">{baseName(activePath)}</span>
          </div>
          <MentionSection
            title="Vinculados a este arquivo"
            mentions={mentions?.backlinks ?? []}
            onOpenFile={onOpenFile}
          />
          <MentionSection
            title="Links deste arquivo"
            mentions={mentions?.outgoing ?? []}
            onOpenFile={onOpenFile}
          />
        </div>
      )}
    </div>
  );
}
