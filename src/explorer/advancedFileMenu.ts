/**
 * Advanced file context-menu items for the explorer (épico "Ações Avançadas do
 * Explorador", issues 69/70/71).
 *
 * This module is intentionally SELF-CONTAINED: it produces an array of
 * {@link ContextMenuItem} that épico A's `TreeContextMenu` can splice into the
 * file menu, but it does NOT import or mount that component. The explorer simply
 * calls {@link buildAdvancedFileMenuItems} when building a file's menu and
 * concatenates the result.
 *
 * Coupling is minimal: each item only fires a thin callback ("open `path` to the
 * side", "show `path` history", …); the App decides what each command does.
 *
 * Disabled items follow the épico's rule — they appear dimmed with an "em breve"
 * tooltip and never fire, because the base feature they need (split editor /
 * diff-compare view / timeline) does not exist yet. The structure is in place so
 * enabling them later is a one-line change (`enabled: true` + wire the command).
 */
import type { ContextMenuItem } from "../types";

/**
 * "Select for Compare" memo (ISSUE-71). Modeled now even though
 * "Compare with Selected" stays disabled, so activating the diff view later only
 * needs to flip `enabled` and read this value. Null when nothing is selected.
 */
export interface CompareSelection {
  /** Absolute path memorized by "Select for Compare". */
  path: string;
}

/** Callbacks the advanced items fire. Each is a thin command, no view logic. */
export interface AdvancedFileMenuHandlers {
  /**
   * ISSUE-69 — open `path` to the side (second editor group). DISABLED until the
   * split-editor base feature exists; passed for forward-compat / testing.
   */
  onOpenToSide?: (path: string) => void;
  /** ISSUE-70 — show the "Open With…" mode selector anchored at `x,y`. */
  onOpenWith?: (path: string, x: number, y: number) => void;
  /** ISSUE-71 — show this file's git history in the Source Control panel. */
  onFileHistory?: (path: string) => void;
  /** ISSUE-71 — memorize `path` for a future "Compare with Selected". */
  onSelectForCompare?: (path: string) => void;
}

export interface AdvancedFileMenuContext {
  /** Absolute path of the right-clicked file. */
  path: string;
  /** Click coordinates, forwarded to the "Open With…" selector. */
  x: number;
  y: number;
  /** Whether the workspace is a git repo (gates File History availability). */
  isGitRepo: boolean;
  /** Current "Select for Compare" memo, if any. */
  compareSelection: CompareSelection | null;
}

/** Tooltip on every item gated behind an unbuilt base feature. */
const SOON = "Em breve — depende de uma feature ainda não disponível.";

/**
 * Builds the advanced items for a file's context menu. Returns them grouped and
 * ready to concatenate after the explorer's base file items (the caller decides
 * whether to prefix a separator).
 *
 * Items that depend on missing base features (split editor, diff/compare view,
 * timeline) come back DISABLED with the "em breve" tooltip and no `run`.
 */
export function buildAdvancedFileMenuItems(
  ctx: AdvancedFileMenuContext,
  handlers: AdvancedFileMenuHandlers
): ContextMenuItem[] {
  const { path, x, y, isGitRepo, compareSelection } = ctx;

  // ----- ISSUE-69: Open to the Side (DISABLED: no split editor yet) -----
  // Wired callback kept so flipping `enabled` later is trivial; today it never
  // fires (no `run`). See advancedFileMenu doc + ISSUE-69 for the missing base.
  const openToSide: ContextMenuItem = {
    id: "explorer.openToSide",
    label: "Abrir ao Lado",
    icon: "splitEditor",
    accelerator: "Ctrl+Enter",
    enabled: false,
    title: SOON + " (editor dividido em grupos)",
  };

  // ----- ISSUE-70: Open With… (WORKS) -----
  const openWith: ContextMenuItem = {
    id: "explorer.openWith",
    label: "Abrir com…",
    icon: "openWith",
    enabled: Boolean(handlers.onOpenWith),
    run: handlers.onOpenWith
      ? () => handlers.onOpenWith!(path, x, y)
      : undefined,
  };

  // ----- ISSUE-71: Git actions -----
  // File History works (git_log_file + GitPanel). The rest need a diff/compare
  // view or a timeline, so they stay disabled with the "em breve" tooltip.
  const openChanges: ContextMenuItem = {
    id: "explorer.git.openChanges",
    label: "Abrir Alterações",
    icon: "openChanges",
    enabled: false,
    title: SOON + " (visualização de diff)",
  };

  const selectForCompare: ContextMenuItem = {
    id: "explorer.git.selectForCompare",
    label: "Selecionar para Comparação",
    icon: "selectForCompare",
    // The memo itself is harmless and useful to model now; flipping it on only
    // requires the diff view to exist for "Compare with Selected" to fire.
    enabled: false,
    title: SOON + " (visualização de comparação)",
  };

  const compareWithSelected: ContextMenuItem = {
    id: "explorer.git.compareWithSelected",
    label: compareSelection
      ? `Comparar com "${baseName(compareSelection.path)}"`
      : "Comparar com Selecionado",
    icon: "compareWithSelected",
    enabled: false,
    title: SOON + " (visualização de comparação)",
  };

  const fileHistory: ContextMenuItem = {
    id: "explorer.git.fileHistory",
    label: "Histórico do Arquivo",
    icon: "fileHistory",
    // Enabled only in a repo (and when the host wired the handler).
    enabled: isGitRepo && Boolean(handlers.onFileHistory),
    title: isGitRepo
      ? undefined
      : "Disponível apenas em um repositório Git.",
    run:
      isGitRepo && handlers.onFileHistory
        ? () => handlers.onFileHistory!(path)
        : undefined,
  };

  const openTimeline: ContextMenuItem = {
    id: "explorer.git.openTimeline",
    label: "Abrir Linha do Tempo",
    icon: "timeline",
    enabled: false,
    title: SOON + " (linha do tempo)",
  };

  return [
    openToSide,
    openWith,
    { id: "explorer.adv.sep1", label: "", separator: true },
    openChanges,
    selectForCompare,
    compareWithSelected,
    fileHistory,
    openTimeline,
  ];
}

/** Last path segment, handling Windows and POSIX separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
