/**
 * Tipos do protocolo app ↔ host de extensões (`tools/ext-host/main.js`).
 * Transporte: linhas JSON pelo stdio do sidecar, relayadas pelo backend Rust
 * (`ext_host_send` / evento `ext-host://message`). O host valida toda mensagem
 * recebida (`tools/ext-host/src/protocol.js`).
 */

export interface ContributedCommand {
  command: string;
  title: string;
  category?: string;
  paletteWhen?: string;
}

export interface ContributedKeybinding {
  command: string;
  /** Normalizada em minúsculas, ex.: "ctrl+shift+escape". */
  key: string;
  when?: string;
}

export interface InstalledExtension {
  id: string;
  path: string;
  version: string;
  displayName: string;
  publisher?: string;
  /**
   * Pode rodar neste host: habilitada E aprovada no portão de
   * compatibilidade (Claude Code/Codex são embutidas e liberadas por padrão).
   */
  supported: boolean;
  /** "app" = pasta gerenciada; "vscode" = ~/.vscode/extensions (somente leitura). */
  source?: "app" | "vscode";
  builtin?: boolean;
  enabled?: boolean;
  /** Por que não roda: disabled | not-evaluated | incompatible | unknown. */
  blockedReason?: string;
  /** `activationEvents` com `*`/`onStartupFinished` (só não embutidas). */
  activateOnStartup?: boolean;
  /** Rótulo curto exibido na UI ("Claude Code", "Codex"). */
  label: string;
  /** Views de webview preferidas (a primeira registrada é usada). */
  viewIds: string[];
  /** Só para as suportadas: comandos/atalhos do `contributes`. */
  commands?: ContributedCommand[];
  keybindings?: ContributedKeybinding[];
  /** Ícone do contêiner da view (data URI SVG/PNG do pacote), se houver. */
  icon?: string;
  /** Botões `editor/title` (grupo navigation) contribuídos, sem os de diff. */
  editorTitle?: ContributedEditorTitleAction[];
}

export interface ContributedEditorTitleAction {
  command: string;
  title: string;
  when?: string;
  /** `src` = data URI do ícone do pacote; `codicon` = `$(nome)`. */
  icon?: { src: string } | { codicon: string };
}

export interface LoadedExtension {
  id: string;
  displayName: string;
  version: string;
  isActive: boolean;
  views: { id: string; name: string; container: string }[];
  commands?: ContributedCommand[];
  keybindings?: ContributedKeybinding[];
  activationMs?: number;
}

export interface WebviewInfo {
  handle: string;
  viewType: string;
  kind: "view" | "panel" | "customEditor";
  extensionId: string;
  title?: string;
  /** URL do HTML servido pelo host (127.0.0.1 + token), ou null antes do 1º `html`. */
  url: string | null;
  /** `webview.options.enableForms` (sandbox `allow-forms`). */
  enableForms?: boolean;
  resolveMs?: number;
  /** Painel: `ViewColumn` pedida (1…9, -1 = ativa, -2 = ao lado). */
  viewColumn?: number;
  /** Painel: abrir sem roubar o foco. */
  preserveFocus?: boolean;
}

export interface InitializeResult {
  origin: string;
  port: number;
  dataDir: string;
  pid: number;
  node: string;
  compileCache?: string | null;
  extensions: InstalledExtension[];
}

export interface PlainPosition {
  line: number;
  character: number;
}
export interface PlainRange {
  start: PlainPosition;
  end: PlainPosition;
}
export interface PlainSelection {
  anchor: PlainPosition;
  active: PlainPosition;
}

/** @deprecated snapshot do editor do PoC (substituído pelo editorBridge). */
export interface EditorStatePayload {
  path: string | null;
  languageId?: string;
  selection?: PlainRange;
  openFiles?: string[];
  dirty?: boolean;
  text?: string;
}

export type HostRequestKind =
  | "showMessage"
  | "quickPick"
  | "inputBox"
  | "openDialog"
  | "saveDialog"
  | "applyEdit"
  | "saveDocument"
  | "clipboardRead";

export interface DiffSide {
  uri: string;
  path?: string;
  content: string;
  readonly?: boolean;
}

/** `vscode.diff` aberto por uma extensão (ex.: edição proposta do Claude Code). */
export interface ExtensionDiffEvent {
  event: "diff";
  diffId: string;
  title: string;
  extensionId?: string;
  extensionName?: string;
  /** Arquivo real afetado (lado esquerdo `file://`, senão o caminho do direito). */
  filePath: string;
  isNewFile: boolean;
  /** A extensão contribui aceitar/rejeitar (menu `editor/title`). */
  reviewable: boolean;
  left: DiffSide;
  right: DiffSide;
  preserveFocus?: boolean;
}

export interface StatusBarItemEvent {
  event: "statusBarItem";
  id: string;
  extensionId: string;
  visible: boolean;
  alignment: "left" | "right";
  priority: number;
  text: string;
  tooltip?: string;
  name?: string;
  command?: { command: string; title?: string; arguments?: unknown[] };
  color?: string | { themeColor: string };
  backgroundColor?: { themeColor: string };
}

/** Eventos emitidos pelo host (campo `event`). */
export type HostEvent =
  | { event: "hello"; pid: number; node: string }
  | { event: "hostExit" }
  | { event: "hostRestarted" }
  | { event: "hostReady" }
  | { event: "installedChanged" }
  | { event: "log"; message: string; level?: string }
  | { event: "extensionLoaded" | "extensionActivated"; extension: LoadedExtension; ms?: number }
  | { event: "viewProviderRegistered"; extensionId: string; viewId: string }
  | ({ event: "webviewHtml" | "webviewPanelCreated" } & WebviewInfo)
  | { event: "postMessage"; handle: string; message: unknown }
  | { event: "revealWebview"; handle: string; preserveFocus: boolean; viewColumn?: number }
  | { event: "revealView"; viewId?: string; container?: string }
  | { event: "webviewTitle"; handle: string; title: string }
  | { event: "webviewDisposed"; handle: string }
  /** Painéis persistíveis (serializer/custom editor) — o app guarda por workspace. */
  | { event: "webviewPanels"; panels: unknown[] }
  | { event: "context"; key: string; value: unknown }
  | {
      event: "request";
      requestId: number;
      kind: HostRequestKind;
      params: Record<string, unknown>;
    }
  | {
      event: "openFile";
      path: string;
      selection?: PlainRange;
      preview?: boolean;
      preserveFocus?: boolean;
    }
  | {
      event: "openVirtualDocument";
      uri: string;
      title: string;
      languageId: string;
      content: string;
    }
  | ExtensionDiffEvent
  | { event: "closeDiff"; diffId: string; left: string; right: string }
  | { event: "openExternal"; url: string }
  | { event: "clipboardWrite"; text: string }
  | { event: "filesChanged"; paths: string[] }
  | { event: "setSelection"; path: string; selections: PlainSelection[] }
  | { event: "revealRange"; path: string; range: PlainRange; revealType: number }
  | { event: "decorationType"; key: string; options: Record<string, unknown> }
  | { event: "decorationTypeDisposed"; key: string }
  | {
      event: "decorations";
      /** Arquivo; ou `uri` + `diffId` para o lado virtual de um diff aberto. */
      path?: string;
      uri?: string;
      diffId?: string;
      key: string;
      items: { range: PlainRange; hoverMessage?: string; renderOptions?: Record<string, unknown> }[];
    }
  | { event: "diffContent"; diffId: string; side: "right"; text: string }
  | { event: "commentThreadDisposed"; handle: string }
  | { event: "quickInputHide"; id: string }
  | { event: "extDiagnostics"; owner: string; path: string; diagnostics: { range: PlainRange; message: string; severity: number; source?: string }[] }
  | StatusBarItemEvent
  | { event: "statusMessage"; id: string; extensionId: string; text: string | null; progress?: boolean }
  | { event: "output"; channel: string; text: string }
  | { event: "outputShow"; channel: string; preserveFocus: boolean }
  | {
      event: "terminalCreate";
      id: string;
      name: string;
      cwd?: string;
      env?: Record<string, string>;
      strictEnv?: boolean;
      shellPath?: string;
      shellArgs?: string[];
      hideFromUser?: boolean;
      isTransient?: boolean;
      extensionId?: string;
      shellIntegration?: boolean;
    }
  | { event: "terminalShow"; id: string; preserveFocus: boolean }
  | { event: "terminalSendText"; id: string; text: string }
  | { event: "terminalDispose"; id: string }
  | { event: "closeEditor"; path: string }
  | { event: "appCommand"; command: string; args: unknown[] }
  | { event: string; [key: string]: unknown };

/** Linha do host: resposta a uma chamada OU evento. */
export type HostLine =
  | { id: number | string; result?: unknown; error?: { message: string } }
  | HostEvent;
