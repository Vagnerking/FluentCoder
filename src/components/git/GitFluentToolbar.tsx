import { Fragment, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  GIT_FLUENT_PRIMARY_TABS,
  shouldSeparateGitFluentTab,
  type GitFluentTab,
  type GitFluentToolbarDensity,
} from "../../git/gitFluent";
import { Codicon } from "../../icons/codicons/Codicon";
import { Tooltip } from "../Tooltip";

interface GitFluentToolbarProps {
  activeTab: GitFluentTab;
  counts: Record<GitFluentTab, number | undefined>;
  density: GitFluentToolbarDensity;
  tabs?: typeof GIT_FLUENT_PRIMARY_TABS;
  onSelectTab: (tab: GitFluentTab) => void;
  onOpenMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  viewActions?: ReactNode;
}

function formatTabCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function GitFluentToolbar({
  activeTab,
  counts,
  density,
  tabs,
  onSelectTab,
  onOpenMenu,
  viewActions,
}: GitFluentToolbarProps) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const toolbarTabs = tabs ?? GIT_FLUENT_PRIMARY_TABS;
  const activeIndex = Math.max(0, toolbarTabs.findIndex((tab) => tab.id === activeTab));

  function selectTab(tab: GitFluentTab, focus = false) {
    onSelectTab(tab);
    if (focus) {
      requestAnimationFrame(() => tabRefs.current[tab]?.focus());
    }
  }

  function selectByOffset(offset: number) {
    const next = (activeIndex + offset + toolbarTabs.length) % toolbarTabs.length;
    selectTab(toolbarTabs[next].id, true);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectByOffset(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      selectByOffset(1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab(toolbarTabs[0].id, true);
    } else if (event.key === "End") {
      event.preventDefault();
      selectTab(toolbarTabs[toolbarTabs.length - 1].id, true);
    }
  }

  return (
    <div className={`git-fluent-toolbar git-fluent-toolbar-${density}`} aria-label="Git Fluent">
      <div className="git-fluent-tablist" role="tablist" aria-label="Views do Git Fluent">
        {toolbarTabs.map((tab, index) => {
          const active = activeTab === tab.id;
          const previous = index > 0 ? toolbarTabs[index - 1] : null;
          const count = counts[tab.id];
          const hasCount = typeof count === "number";
          const countLabel = hasCount ? `${tab.label} (${count})` : tab.label;
          const ariaLabel = hasCount ? `${tab.label}, ${count}` : tab.label;
          return (
            <Fragment key={tab.id}>
              {shouldSeparateGitFluentTab(previous, tab) && (
                <span className="git-fluent-tab-separator" aria-hidden="true" />
              )}
              <Tooltip label={countLabel}>
                <button
                  type="button"
                  role="tab"
                  className={`git-link-btn git-fluent-tab-btn${active ? " active" : ""}${hasCount ? " has-count" : ""}`}
                  aria-label={ariaLabel}
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  ref={(node) => {
                    tabRefs.current[tab.id] = node;
                  }}
                  onKeyDown={onTabKeyDown}
                  onClick={() => selectTab(tab.id)}
                  onContextMenu={onOpenMenu}
                >
                  <Codicon name={tab.icon} />
                  {hasCount && active && (
                    <span className="git-fluent-tab-count">{formatTabCount(count)}</span>
                  )}
                </button>
              </Tooltip>
            </Fragment>
          );
        })}
      </div>
      {viewActions && (
        <>
          <span className="git-fluent-divider git-fluent-view-divider" aria-hidden="true" />
          <div className="git-fluent-view-actions" aria-label="Ações da visualização ativa">
            {viewActions}
          </div>
        </>
      )}
      <span className="git-fluent-divider git-fluent-command-divider" aria-hidden="true" />
      <div className="git-fluent-toolbar-actions" aria-label="Ações do Git Fluent">
        <Tooltip label="Mais ações do Git Fluent">
          <button type="button" className="git-link-btn" aria-label="Mais ações do Git Fluent" onClick={onOpenMenu}>
            <Codicon name="filterFiles" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
