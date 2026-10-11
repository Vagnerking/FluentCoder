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
  | "expandAll"
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
  | "gitRepo"
  | "gitGraph"
  | "gitRemote"
  | "gitStash"
  | "gitWorktree"
  | "gitContributor"
  | "cloudUpload"
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
  | "packages"
  | "commandPalette"
  | "menu"
  | "agents"
  | "graph"
  | "backlinks"
  | "solution"
  | "send"
  | "modeAsk"
  | "modePlan"
  | "modeEdit"
  | "modeAuto"
  | "modeBypass"
  | "model"
  | "attachContext"
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
  | "timeline"
  // Remote (SSH) — issue #8
  | "remote"
  | "debugDisconnect"
  // Media preview (image/video/audio)
  | "video"
  | "audio"
  // Navigation
  | "arrowUp"
  | "arrowLeft"
  // Misc
  | "tag"
  | "bookmark"
  | "key"
  | "lock"
  // Form controls (src/components/ui)
  | "checkmark"
  | "indeterminate"
  // Fluent Chat (sidebar secundária de IA)
  | "fluentChat"
  | "sparkle"
  | "robot"
  | "retry"
  | "editMessage"
  | "thinking"
  | "toolRead"
  | "toolEdit"
  | "toolExecute"
  | "toolSearch"
  | "toolFetch"
  | "toolPlan"
  | "toolOther"
  | "toolDelete"
  | "toolMove"
  | "usage"
  | "selection"
  | "workspaceContext"
  | "linkExternal"
  | "globe"
  | "pending"
  | "duplicate"
  // Ícones escolhíveis de agentes personalizados
  | "agentHubot"
  | "agentRobot"
  | "agentSparkle"
  | "agentBeaker"
  | "agentBug"
  | "agentBook"
  | "agentRocket"
  | "agentShield"
  | "agentTools"
  | "agentLaw"
  | "agentMortarBoard"
  | "agentPulse"
  | "agentDatabase"
  | "agentPaintcan"
  | "agentGlobe"
  | "agentOrganization"
  // Workbench chrome (title bar layout toggles, tab strip, menus)
  | "layoutSidebarLeft"
  | "layoutSidebarLeftOff"
  | "layoutSidebarRight"
  | "layoutSidebarRightOff"
  | "layoutPanel"
  | "layoutPanelOff"
  | "chevronLeft"
  | "more"
  | "dirty"
  | "clearAll"
  | "filter"
  | "debugPause"
  | "stepInto"
  | "stepOut"
  | "zoomIn"
  | "zoomOut"
  | "zoomFit"
  | "list"
  | "pin"
  | "pinned"
  | "annotationBlame"
  | "annotationHeatmap"
  | "symbolFile"
  | "symbolModule"
  | "symbolNamespace"
  | "symbolClass"
  | "symbolMethod"
  | "symbolProperty"
  | "symbolField"
  | "symbolConstructor"
  | "symbolEnum"
  | "symbolInterface"
  | "symbolFunction"
  | "symbolVariable"
  | "symbolConstant"
  | "symbolString"
  | "symbolKey"
  | "symbolEnumMember"
  | "symbolStruct"
  | "symbolEvent"
  | "symbolOperator"
  | "symbolTypeParameter"
  | "symbolMisc"
  | "workspaceRoot"
  // View Extensões
  | "cloudDownload"
  | "verified"
  | "circleSlash"
  | "pass"
  // Views & layout (registro de views, mover entre regiões)
  | "output"
  | "problems"
  | "moveView"
  | "hideView"
  | "layout";

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
  expandAll: "expand-all",
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
  gitRepo: "repo",
  gitGraph: "git-commit",
  gitRemote: "cloud",
  gitStash: "archive",
  gitWorktree: "folder-library",
  gitContributor: "organization",
  cloudUpload: "cloud-upload",
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
  packages: "package",
  commandPalette: "symbol-color",
  menu: "menu",
  agents: "hubot",
  graph: "type-hierarchy",
  backlinks: "references",
  solution: "layers",
  send: "send",
  modeAsk: "comment",
  modePlan: "checklist",
  modeEdit: "code",
  modeAuto: "zap",
  modeBypass: "shield",
  model: "sparkle",
  attachContext: "mention",
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

  // Remote (SSH)
  remote: "remote",
  debugDisconnect: "debug-disconnect",

  // Media preview
  video: "device-camera-video",
  audio: "unmute",

  // Navigation
  arrowUp: "arrow-up",
  arrowLeft: "arrow-left",

  // Misc
  tag: "tag",
  bookmark: "bookmark",
  key: "key",
  lock: "lock",

  // Form controls (src/components/ui)
  checkmark: "check",
  indeterminate: "dash",

  // Fluent Chat
  fluentChat: "chat-sparkle",
  sparkle: "sparkle",
  robot: "robot",
  retry: "debug-rerun",
  editMessage: "edit",
  thinking: "lightbulb",
  toolRead: "eye",
  toolEdit: "edit",
  toolExecute: "terminal",
  toolSearch: "search",
  toolFetch: "globe",
  toolPlan: "checklist",
  toolOther: "tools",
  toolDelete: "trash",
  toolMove: "arrow-swap",
  usage: "dashboard",
  selection: "selection",
  workspaceContext: "folder-library",
  linkExternal: "link-external",
  globe: "globe",
  pending: "circle-large-outline",
  duplicate: "copy",
  agentHubot: "hubot",
  agentRobot: "robot",
  agentSparkle: "sparkle",
  agentBeaker: "beaker",
  agentBug: "bug",
  agentBook: "book",
  agentRocket: "rocket",
  agentShield: "shield",
  agentTools: "tools",
  agentLaw: "law",
  agentMortarBoard: "mortar-board",
  agentPulse: "pulse",
  agentDatabase: "database",
  agentPaintcan: "paintcan",
  agentGlobe: "globe",
  agentOrganization: "organization",
  layoutSidebarLeft: "layout-sidebar-left",
  layoutSidebarLeftOff: "layout-sidebar-left-off",
  layoutSidebarRight: "layout-sidebar-right",
  layoutSidebarRightOff: "layout-sidebar-right-off",
  layoutPanel: "layout-panel",
  layoutPanelOff: "layout-panel-off",
  chevronLeft: "chevron-left",
  more: "ellipsis",
  dirty: "circle-filled",
  clearAll: "clear-all",
  filter: "filter",
  debugPause: "debug-pause",
  stepInto: "debug-step-into",
  stepOut: "debug-step-out",
  zoomIn: "zoom-in",
  zoomOut: "zoom-out",
  zoomFit: "screen-full",
  list: "list-unordered",
  pin: "pin",
  pinned: "pinned",
  // Anotações Git do editor e ícones de símbolo (breadcrumbs)
  annotationBlame: "person",
  annotationHeatmap: "flame",
  symbolFile: "symbol-file",
  symbolModule: "symbol-module",
  symbolNamespace: "symbol-namespace",
  symbolClass: "symbol-class",
  symbolMethod: "symbol-method",
  symbolProperty: "symbol-property",
  symbolField: "symbol-field",
  symbolConstructor: "symbol-constructor",
  symbolEnum: "symbol-enum",
  symbolInterface: "symbol-interface",
  symbolFunction: "symbol-function",
  symbolVariable: "symbol-variable",
  symbolConstant: "symbol-constant",
  symbolString: "symbol-string",
  symbolKey: "symbol-key",
  symbolEnumMember: "symbol-enum-member",
  symbolStruct: "symbol-structure",
  symbolEvent: "symbol-event",
  symbolOperator: "symbol-operator",
  symbolTypeParameter: "symbol-parameter",
  symbolMisc: "symbol-misc",
  workspaceRoot: "root-folder",
  cloudDownload: "cloud-download",
  verified: "verified-filled",
  circleSlash: "circle-slash",
  pass: "pass",
  output: "output",
  problems: "issues",
  moveView: "arrow-swap",
  hideView: "eye-closed",
  layout: "layout",
};

/** Codicon names that should spin (loading/sync feedback). */
export const SPINNING: ReadonlySet<IconAction> = new Set<IconAction>([
  "loading",
]);
