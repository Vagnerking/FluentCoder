import { IconButton } from "../ui/IconButton";
import type { MouseEvent } from "react";
import type { GitStashEntry, GitStashFile } from "../../types";
import { Codicon } from "../../icons/codicons/Codicon";
import { commitFileStatusClass } from "../../git/gitUi";

interface GitFluentStashesViewProps {
  stashes: GitStashEntry[];
  expandedStashes: Set<number>;
  stashFiles: Record<number, GitStashFile[]>;
  stashFilesLoading: Record<number, boolean>;
  busy: boolean;
  onToggleStash: (index: number) => void;
  onOpenStashMenu: (event: MouseEvent, stash: GitStashEntry) => void;
  onApplyStash: (stash: GitStashEntry) => void;
  onOpenStashFile: (stash: GitStashEntry, file: GitStashFile) => void;
}

function stashFileBadge(file: GitStashFile): { letter: string; kind: string } {
  const status = file.status.charAt(0) || "M";
  return { letter: status, kind: commitFileStatusClass(status) };
}

export function GitFluentStashesView({
  stashes,
  expandedStashes,
  stashFiles,
  stashFilesLoading,
  busy,
  onToggleStash,
  onOpenStashMenu,
  onApplyStash,
  onOpenStashFile,
}: GitFluentStashesViewProps) {
  return (
    <div className="git-fluent-list" role="tabpanel">
      {stashes.length === 0 ? (
        <div className="git-fluent-empty">Nenhum stash salvo.</div>
      ) : (
        stashes.map((stash) => {
          const expanded = expandedStashes.has(stash.index);
          const files = stashFiles[stash.index] ?? [];
          const loading = stashFilesLoading[stash.index] ?? false;
          const fileCountLabel =
            files.length > 0 ? `${files.length} arquivo${files.length === 1 ? "" : "s"}` : null;

          return (
            <div
              key={`fluent-stash-${stash.index}`}
              className="git-stash-block"
              onContextMenu={(event) => onOpenStashMenu(event, stash)}
            >
              <div className="git-stash-row" title={stash.message}>
                <button
                  type="button"
                  className="git-disclosure-btn"
                  aria-label={expanded ? "Recolher stash" : "Expandir stash"}
                  onClick={() => onToggleStash(stash.index)}
                >
                  <Codicon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
                </button>
                <Codicon name="gitStash" size={13} />
                <span className="git-stash-msg">{stash.message}</span>
                <code className="git-stash-ref">{`stash@{${stash.index}}`}</code>
                {fileCountLabel && <span className="git-stash-count">{fileCountLabel}</span>}
                <span className="git-file-spacer" />
                <IconButton
                  icon="add"
                  size="sm"
                  label="Aplicar (mantém o stash)"
                  className="git-file-action"
                  disabled={busy}
                  onClick={() => onApplyStash(stash)}
                />
                <IconButton
                  icon="filterFiles"
                  size="sm"
                  label={`Mais ações para stash@{${stash.index}}`}
                  className="git-file-action"
                  onClick={(event) => onOpenStashMenu(event, stash)}
                />
              </div>
              {expanded && (
                <div className="git-stash-files">
                  {loading ? (
                    <div className="git-stash-file-empty">Carregando arquivos...</div>
                  ) : files.length === 0 ? (
                    <div className="git-stash-file-empty">Nenhum arquivo listado.</div>
                  ) : (
                    files.map((file) => {
                      const badge = stashFileBadge(file);
                      return (
                        <button
                          key={`${stash.index}:${file.status}:${file.path}`}
                          type="button"
                          className="git-stash-file-row"
                          title={file.path}
                          onClick={() => onOpenStashFile(stash, file)}
                        >
                          <span className={`git-badge ${badge.kind}`}>{badge.letter}</span>
                          <span className="git-stash-file-path">{file.path}</span>
                          <Codicon name="compareWithSelected" size={12} />
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
