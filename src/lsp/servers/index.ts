/**
 * Single registry mapping Monaco language ids to the LSP server that handles
 * them. The manager (ISSUE-25) consults this to decide which server to start
 * when a language is first opened.
 *
 * Every adapter shares one signature — `(rootPath) => Promise<MonacoLanguageClient>`
 * — so the manager never special-cases a language. C#, TypeScript/JavaScript and
 * Razor each register their entries here.
 */
import type { MonacoLanguageClient } from "monaco-languageclient";
import { CSHARP_SERVER_ID, startCsharpServer } from "./csharp";
import { TS_SERVER_ID, startTypescriptServer } from "./typescript";
import { RAZOR_SERVER_ID, startRazorServer } from "./razor";

/**
 * Brings up one language server end-to-end: ensure/locate the binary,
 * `lsp_start_server` on the backend, then `createLanguageClient`. Returns the
 * live client so the manager can stop it.
 */
export interface LspWorkspaceInfo {
  serverId: string;
  solutionPath?: string;
  projectCount: number;
  loaded: boolean;
}

export interface ServerStartContext {
  onWorkspaceInfo?: (info: LspWorkspaceInfo) => void;
}

export type ServerStarter = (
  rootPath: string,
  context?: ServerStartContext
) => Promise<MonacoLanguageClient>;

export interface ServerEntry {
  serverId: string;
  start: ServerStarter;
}

/** Monaco language id -> server entry. */
export const SERVER_REGISTRY: Record<string, ServerEntry> = {
  csharp: { serverId: CSHARP_SERVER_ID, start: startCsharpServer },
  typescript: { serverId: TS_SERVER_ID, start: startTypescriptServer },
  javascript: { serverId: TS_SERVER_ID, start: startTypescriptServer },
  typescriptreact: { serverId: TS_SERVER_ID, start: startTypescriptServer },
  javascriptreact: { serverId: TS_SERVER_ID, start: startTypescriptServer },
  razor: { serverId: RAZOR_SERVER_ID, start: startRazorServer },
};

/** Languages that have a registered LSP server. */
export function lspLanguageIds(): string[] {
  return Object.keys(SERVER_REGISTRY);
}

/** Resolves the server entry for a Monaco language id, or null if unsupported. */
export function serverIdForLanguage(language: string): ServerEntry | null {
  return SERVER_REGISTRY[language] ?? null;
}
