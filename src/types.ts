/** A node in the file explorer tree. Mirrors the Rust `DirEntry`. */
export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  /** Lazily loaded children; undefined until the folder is first expanded. */
  children?: FileNode[];
  /** Whether the folder is currently expanded in the UI. */
  expanded?: boolean;
}

/** Shape returned by the Rust `read_dir` command. */
export interface RawDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** A file currently open in the editor. */
export interface OpenFile {
  path: string;
  name: string;
  content: string;
  /** True when the buffer differs from what's on disk. */
  dirty: boolean;
}

/** Persisted UI session, mirroring the Rust `Session`. */
export interface Session {
  /** Absolute path of the last opened project folder, or null. */
  lastFolder: string | null;
}

/** A single search hit, mirroring the Rust `SearchMatch`. */
export interface SearchMatch {
  path: string;
  name: string;
  line: number;
  text: string;
}

/** One file in the Quick Open index, mirroring the Rust `ProjectFile`. */
export interface ProjectFile {
  /** Absolute path — handed to the editor to open the file. */
  path: string;
  /** File name, shown as the primary label. */
  name: string;
  /** Path relative to the workspace root, normalized to `/`, shown dimmed. */
  rel: string;
}

/** A changed path in `git status`, mirroring the Rust `GitFileStatus`. */
export interface GitFileStatus {
  path: string;
  /** Two-letter porcelain code, e.g. " M", "A ", "??". */
  code: string;
  staged: boolean;
  untracked: boolean;
}

/** Overall repo state, mirroring the Rust `GitStatus`. */
export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  isRepo: boolean;
  hasUpstream: boolean;
  files: GitFileStatus[];
}

/** One commit in the history list, mirroring the Rust `GitCommit`. */
export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

/** A run/debug configuration, mirroring the Rust `RunConfig`. */
export interface RunConfig {
  name: string;
  /** Shell command line to execute, e.g. "npm run dev". */
  command: string;
  /** Working directory relative to the project root; empty = root. */
  cwd: string;
}

/** Per-line blame info returned by `git_blame`, mirroring the Rust `BlameHunk`. */
export interface BlameHunk {
  /** Short SHA (7 chars). Empty for uncommitted lines. */
  short: string;
  author: string;
  /** Relative date, e.g. "há 3 dias". */
  date: string;
  /** First line of the commit message. */
  subject: string;
  /** 1-based line number in the file. */
  line: number;
}

/**
 * Visual state of a file in the explorer/tabs — drives label color and the
 * trailing git badge, mirroring VSCode's decorations. Derived from `git status`
 * and Monaco diagnostics; never set by hand on a node.
 */
export interface FileDecoration {
  /** Which state to color for. Diagnostics outrank git when both apply. */
  kind:
    | "modified"
    | "added"
    | "deleted"
    | "untracked"
    | "ignored"
    | "conflict"
    | "error"
    | "warning";
  /** Short git letter shown at the end of the row (M, A, U…); omitted for none. */
  badge?: string;
}

/** A diagnostic shown in the Problems tab, derived from Monaco markers. */
export interface Problem {
  /** Absolute path of the file the diagnostic belongs to. */
  path: string;
  /** File name for display. */
  name: string;
  severity: "error" | "warning" | "info";
  message: string;
  line: number;
  column: number;
}

/** One item in a MenuBar dropdown. */
export interface MenuItem {
  id: string;
  label: string;
  /** Accelerator hint shown right-aligned, e.g. "Ctrl+S". */
  accelerator?: string;
  /** Invoked on click/activation. Omitted for separators/disabled placeholders. */
  run?: () => void;
  /** When false, the item renders dimmed and never fires. Default true. */
  enabled?: boolean;
  /** When true, renders a divider instead of a clickable row. */
  separator?: boolean;
}

/** A top-level menu in the MenuBar (e.g. File, Edit). */
export interface MenuDef {
  label: string;
  items: MenuItem[];
}

/**
 * One button in a {@link ConfirmDialog}. The caller decides the meaning by the
 * `value` returned when the button is chosen — the dialog itself stays agnostic.
 */
export interface ConfirmButton<T> {
  label: string;
  /** Visual style only: `primary` (accent), `secondary` (neutral), `danger` (red). */
  variant: "primary" | "secondary" | "danger";
  /** Value handed back to the caller when this button is chosen. */
  value: T;
  /** When true, this button gets initial focus, the default highlight and Enter. */
  default?: boolean;
}

/** Props for the reusable {@link ConfirmDialog} modal. */
export interface ConfirmDialogProps<T> {
  title: string;
  message: string;
  buttons: ConfirmButton<T>[];
  /**
   * Reports the user's choice. Receives a button's `value`, or `null` when the
   * dialog is cancelled (Esc / overlay click) without an explicit cancel button.
   */
  onChoice: (value: T | null) => void;
}

/** Imperative handle the App holds to drive the active Monaco editor. */
export interface EditorActionsApi {
  /** Runs a Monaco editor action by id, e.g. "undo", "editor.action.selectAll". */
  run: (actionId: string) => void;
  /** Low-level trigger, e.g. trigger("menu","editor.action.clipboardCutAction"). */
  trigger: (source: string, handlerId: string, payload?: unknown) => void;
  /** Focuses the editor. */
  focus: () => void;
}
