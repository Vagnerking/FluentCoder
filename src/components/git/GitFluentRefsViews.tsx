import type { MouseEvent } from "react";
import type { GitFluentContributor, GitFluentTagRef } from "../../git/gitFluent";
import { Codicon } from "../../icons/codicons/Codicon";

interface GitFluentTagsViewProps {
  tags: GitFluentTagRef[];
  onSelectTag: (tag: GitFluentTagRef) => void;
  onOpenTagMenu: (event: MouseEvent, tag: GitFluentTagRef) => void;
}

interface GitFluentContributorsViewProps {
  contributors: GitFluentContributor[];
  onSelectContributor: (contributor: GitFluentContributor) => void;
  onOpenContributorMenu: (event: MouseEvent, contributor: GitFluentContributor) => void;
}

function initialsForName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function GitFluentTagsView({
  tags,
  onSelectTag,
  onOpenTagMenu,
}: GitFluentTagsViewProps) {
  return (
    <div className="git-fluent-list" role="tabpanel">
      {tags.length === 0 ? (
        <div className="git-fluent-empty">Nenhuma tag carregada no grafo recente.</div>
      ) : (
        <div className="git-ref-list">
          <div className="git-ref-section-header">
            <span>
              <Codicon name="tag" size={12} />
              Tags
            </span>
            <small>{tags.length}</small>
          </div>
          {tags.map((tag) => (
            <button
              key={`fluent-tag-${tag.name}-${tag.commit.hash}`}
              type="button"
              className="git-ref-row git-fluent-ref-button tag"
              title={`${tag.name} · ${tag.commit.hash}`}
              onClick={() => onSelectTag(tag)}
              onContextMenu={(event) => onOpenTagMenu(event, tag)}
            >
              <Codicon name="tag" size={13} />
              <div className="git-ref-main">
                <span className="git-ref-name">{tag.name}</span>
                <span className="git-ref-meta">
                  {tag.commit.subject} · {tag.commit.date} · {tag.commit.author}
                </span>
              </div>
              <Codicon name="chevronRight" size={12} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function GitFluentContributorsView({
  contributors,
  onSelectContributor,
  onOpenContributorMenu,
}: GitFluentContributorsViewProps) {
  return (
    <div className="git-fluent-list" role="tabpanel">
      {contributors.length === 0 ? (
        <div className="git-fluent-empty">Nenhum contributor carregado no grafo recente.</div>
      ) : (
        <div className="git-ref-list">
          <div className="git-ref-section-header">
            <span>
              <Codicon name="account" size={12} />
              Pessoas
            </span>
            <small>{contributors.length}</small>
          </div>
          {contributors.map((contributor) => (
            <button
              key={`fluent-contributor-${contributor.email || contributor.name}`}
              type="button"
              className="git-ref-row git-fluent-ref-button contributor"
              title={contributor.email || contributor.name}
              onClick={() => onSelectContributor(contributor)}
              onContextMenu={(event) => onOpenContributorMenu(event, contributor)}
            >
              <span className="git-ref-avatar" aria-hidden="true">
                {contributor.latestCommit.avatarUrl ? (
                  <img src={contributor.latestCommit.avatarUrl} alt="" />
                ) : (
                  initialsForName(contributor.name)
                )}
              </span>
              <div className="git-ref-main">
                <span className="git-ref-name">{contributor.name}</span>
                <span className="git-ref-meta">
                  {contributor.latestCommit.subject} · último {contributor.latestDate}
                </span>
              </div>
              <span className="git-ref-sync">{contributor.commits}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
