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

/**
 * How a file is rendered when open. `"text"` is the Monaco editor (the default
 * for every file); `"image"` is the read-only image preview. The "Open With…"
 * selector (ISSUE-70) lets the user pick which one, and `OpenFile.mode` records
 * the choice so the App can route the buffer to the right view.
 */
export type OpenMode = "text" | "image";

/** A file currently open in the editor. */
export interface OpenFile {
  path: string;
  name: string;
  content: string;
  /** True when the buffer differs from what's on disk. */
  dirty: boolean;
  /**
   * Which view renders this file. Defaults to `"text"` when omitted (every
   * pre-Open-With caller). Image files opened by double-click default to
   * `"image"`; "Open With…" can override either way.
   */
  mode?: OpenMode;
}

/**
 * A registered "Open With…" mode (ISSUE-70). The selector is data-driven: it
 * lists every mode whose `appliesTo(path)` is true and opens the file in the
 * chosen `mode`. Adding a future mode (hex, markdown preview, …) means adding
 * one entry here — no change to the selector UI.
 */
export interface OpenWithMode {
  /** The {@link OpenMode} this entry opens the file in. */
  mode: OpenMode;
  /** Human label shown in the selector, e.g. "Editor de Texto". */
  label: string;
  /** Codicon action name (central icon map) shown beside the label. */
  icon: import("./icons/codicons/codicon-map").IconAction;
  /** True when this mode can open `path` (e.g. image preview ⇒ image files). */
  appliesTo: (path: string) => boolean;
  /** True when this is the default mode for files it applies to. */
  isDefaultFor?: (path: string) => boolean;
}

/**
 * One item in the explorer's tree context menu (ISSUE-56 / épico A). Defined
 * here so the advanced-action builders (ISSUE-69/70/71) can produce items
 * without importing the not-yet-merged `TreeContextMenu` component. Keep this
 * shape in sync with épico A's `ContextMenuItem`.
 */
export interface ContextMenuItem {
  id: string;
  label: string;
  /** Right-aligned accelerator hint, e.g. "Ctrl+Enter". */
  accelerator?: string;
  /** Invoked when the (enabled) item is clicked. Omitted for separators. */
  run?: () => void;
  /** When false the item renders dimmed and never fires. Default true. */
  enabled?: boolean;
  /** Tooltip shown on hover — used for the "em breve" hints on disabled items. */
  title?: string;
  /** Renders a divider instead of a clickable row. */
  separator?: boolean;
  /** Nested submenu (e.g. the modes under "Open With…"). */
  submenu?: ContextMenuItem[];
  /** Optional Codicon action name shown at the start of the row. */
  icon?: import("./icons/codicons/codicon-map").IconAction;
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

/** Imperative handle the App holds to drive the active Monaco editor. */
export interface EditorActionsApi {
  /** Runs a Monaco editor action by id, e.g. "undo", "editor.action.selectAll". */
  run: (actionId: string) => void;
  /** Low-level trigger, e.g. trigger("menu","editor.action.clipboardCutAction"). */
  trigger: (source: string, handlerId: string, payload?: unknown) => void;
  /** Focuses the editor. */
  focus: () => void;
}
