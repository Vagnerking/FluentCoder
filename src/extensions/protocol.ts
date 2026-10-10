/**
 * Tipos do protocolo app ↔ host de extensões (`tools/ext-host/main.js`).
 * Transporte: linhas JSON pelo stdio do sidecar, relayadas pelo backend Rust
 * (`ext_host_send` / evento `ext-host://message`).
 */

export interface InstalledExtension {
  id: string;
  path: string;
  version: string;
  displayName: string;
  supported: boolean;
  /** Rótulo curto exibido na UI ("Claude Code", "Codex"). */
  label: string;
  /** Views de webview preferidas (a primeira registrada é usada). */
  viewIds: string[];
}

export interface LoadedExtension {
  id: string;
  displayName: string;
  version: string;
  isActive: boolean;
  views: { id: string; name: string; container: string }[];
}

export interface WebviewInfo {
  handle: string;
  viewType: string;
  kind: "view" | "panel" | "customEditor";
  extensionId: string;
  title?: string;
  /** URL do HTML servido pelo host (127.0.0.1 + token), ou null antes do 1º `html`. */
  url: string | null;
}

export interface InitializeResult {
  origin: string;
  port: number;
  dataDir: string;
  pid: number;
  node: string;
  extensions: InstalledExtension[];
}

export interface EditorStatePayload {
  path: string | null;
  languageId?: string;
  selection?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  openFiles?: string[];
  dirty?: boolean;
  /** Conteúdo do buffer (só quando sujo). */
  text?: string;
}

export type HostRequestKind =
  | "showMessage"
  | "quickPick"
  | "inputBox"
  | "openDialog"
  | "saveDialog";

/** Eventos emitidos pelo host (campo `event`). */
export type HostEvent =
  | { event: "hello"; pid: number; node: string }
  | { event: "log"; message: string; level?: string }
  | { event: "extensionLoaded" | "extensionActivated"; extension: LoadedExtension }
  | { event: "viewProviderRegistered"; extensionId: string; viewId: string }
  | ({ event: "webviewHtml" | "webviewPanelCreated" } & WebviewInfo)
  | { event: "postMessage"; handle: string; message: unknown }
  | { event: "revealWebview"; handle: string; preserveFocus: boolean }
  | { event: "revealView"; viewId?: string; container?: string }
  | { event: "webviewTitle"; handle: string; title: string }
  | { event: "webviewDisposed"; handle: string }
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
      selection?: EditorStatePayload["selection"];
      preview?: boolean;
    }
  | {
      event: "openVirtualDocument";
      uri: string;
      title: string;
      languageId: string;
      content: string;
    }
  | {
      event: "diff";
      title: string;
      left: { uri: string; path?: string; content: string };
      right: { uri: string; path?: string; content: string };
    }
  | { event: "closeDiff"; left: string; right: string }
  | { event: "openExternal"; url: string }
  | { event: "clipboardWrite"; text: string }
  | { event: "filesChanged"; paths: string[] }
  | { event: "terminalShow" | "terminalSendText"; name: string; text?: string }
  | { event: string; [key: string]: unknown };

/** Linha do host: resposta a uma chamada OU evento. */
export type HostLine =
  | { id: number; result?: unknown; error?: { message: string } }
  | HostEvent;
