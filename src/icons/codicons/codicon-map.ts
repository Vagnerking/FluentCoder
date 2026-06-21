/**
 * Central mapping from a semantic UI action/state to a Codicon name.
 *
 * This is the single source of truth the spec asks for: components reference an
 * action key (`"save"`, `"error"`, `"quickFix"`) — never a raw `codicon-*`
 * class. Swapping the glyph for an action means editing one line here, not
 * hunting through screens. Names come from @vscode/codicons (the VSCode set).
 */

/** Every semantic icon slot the UI can ask for. */
export type IconAction =
  // Explorer / file actions
  | "newFile"
  | "newFolder"
  | "save"
  | "saveAll"
  | "closeTab"
  | "closeAll"
  | "refresh"
  | "reload"
  | "collapseAll"
  | "expand"
  | "collapse"
  | "folder"
  | "folderOpened"
  | "file"
  // Explorer context-menu actions
  | "rename"
  | "delete"
  | "cut"
  | "copy"
  | "paste"
  | "copyPath"
  | "revealExplorer"
  | "findInFolder"
  | "splitEditor"
  | "openWith"
  // Search
  | "search"
  | "replace"
  | "caseSensitive"
  | "wholeWord"
  | "regex"
  | "filterFiles"
  // Run / debug
  | "run"
  | "debug"
  | "stop"
  | "restart"
  | "stepOver"
  | "continue"
  // Terminal
  | "terminal"
  | "terminalNew"
  | "trash"
  // Source control / git
  | "sourceControl"
  | "gitBranch"
  | "gitCommit"
  | "gitPull"
  | "gitPush"
  | "sync"
  | "gitMerge"
  | "add"
  | "remove"
  | "discard"
  // Diagnostics / status
  | "error"
  | "warning"
  | "info"
  | "hint"
  | "success"
  | "loading"
  // Code actions / navigation
  | "quickFix"
  | "codeAction"
  | "goToDefinition"
  | "findReferences"
  | "renameSymbol"
  | "formatDocument"
  | "organizeImports"
  // Activity bar / chrome
  | "explorer"
  | "extensions"
  | "account"
  | "settings"
  | "commandPalette"
  | "menu"
  | "agents"
  | "send"
  | "modeAsk"
  | "modePlan"
  | "modeDev"
  | "chevronRight"
  | "chevronDown"
  | "close"
  // Explorer advanced actions (épico "Ações Avançadas do Explorador")
  | "textEditor"
  | "imagePreview"
  | "openChanges"
  | "selectForCompare"
  | "compareWithSelected"
  | "fileHistory"
  | "timeline";

/** action → codicon name (without the `codicon-` prefix). */
export const CODICON_MAP: Record<IconAction, string> = {
  // Explorer / file actions
  newFile: "new-file",
  newFolder: "new-folder",
  save: "save",
  saveAll: "save-all",
  closeTab: "close",
  closeAll: "close-all",
  refresh: "refresh",
  reload: "sync",
  collapseAll: "collapse-all",
  expand: "chevron-down",
  collapse: "chevron-right",
  folder: "folder",
  folderOpened: "folder-opened",
  file: "file",

  // Explorer context-menu actions
  rename: "edit",
  delete: "trash",
  cut: "list-selection",
  copy: "copy",
  paste: "clippy",
  copyPath: "link",
  revealExplorer: "folder-opened",
  findInFolder: "search",
  splitEditor: "split-horizontal",
  openWith: "go-to-file",

  // Search
  search: "search",
  replace: "replace",
  caseSensitive: "case-sensitive",
  wholeWord: "whole-word",
  regex: "regex",
  filterFiles: "ellipsis",

  // Run / debug
  run: "play",
  debug: "debug-alt",
  stop: "debug-stop",
  restart: "debug-restart",
  stepOver: "debug-step-over",
  continue: "debug-continue",

  // Terminal
  terminal: "terminal",
  terminalNew: "add",
  trash: "trash",

  // Source control / git
  sourceControl: "source-control",
  gitBranch: "git-branch",
  gitCommit: "git-commit",
  gitPull: "arrow-down",
  gitPush: "arrow-up",
  sync: "sync",
  gitMerge: "git-merge",
  add: "add",
  remove: "remove",
  discard: "discard",

  // Diagnostics / status
  error: "error",
  warning: "warning",
  info: "info",
  hint: "lightbulb",
  success: "check",
  loading: "loading",

  // Code actions / navigation
  quickFix: "lightbulb",
  codeAction: "lightbulb-sparkle",
  goToDefinition: "go-to-file",
  findReferences: "references",
  renameSymbol: "edit",
  formatDocument: "list-flat",
  organizeImports: "list-tree",

  // Activity bar / chrome
  explorer: "files",
  extensions: "extensions",
  account: "account",
  settings: "settings-gear",
  commandPalette: "symbol-color",
  menu: "menu",
  agents: "hubot",
  send: "send",
  modeAsk: "comment",
  modePlan: "checklist",
  modeDev: "tools",
  chevronRight: "chevron-right",
  chevronDown: "chevron-down",
  close: "close",

  // Explorer advanced actions (open with / diff / history)
  textEditor: "file-code",
  imagePreview: "file-media",
  openChanges: "diff",
  selectForCompare: "inspect",
  compareWithSelected: "diff-multiple",
  fileHistory: "history",
  timeline: "history",
};

/** Codicon names that should spin (loading/sync feedback). */
export const SPINNING: ReadonlySet<IconAction> = new Set<IconAction>([
  "loading",
]);
