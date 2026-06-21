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
import { NPM_SERVERS, makeNpmServerStarter } from "./npm";
import { SYSTEM_SERVERS, makeSystemServerStarter } from "./system";

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

/** Hand-written adapters (C#, TS/JS, Razor). */
const BASE_REGISTRY: Record<string, ServerEntry> = {
  csharp: { serverId: CSHARP_SERVER_ID, start: startCsharpServer },
  typescript: { serverId: TS_SERVER_ID, start: startTypescriptServer },
  javascript: { serverId: TS_SERVER_ID, start: startTypescriptServer },
  typescriptreact: { serverId: TS_SERVER_ID, start: startTypescriptServer },
  javascriptreact: { serverId: TS_SERVER_ID, start: startTypescriptServer },
  razor: { serverId: RAZOR_SERVER_ID, start: startRazorServer },
};

// Generate one registry entry per language each npm-based server handles, so
// opening e.g. a `.py` file auto-installs Pyright. Adding a language is a single
// line in `NPM_SERVERS` — no change needed here.
const NPM_REGISTRY: Record<string, ServerEntry> = {};
for (const config of NPM_SERVERS) {
  const entry: ServerEntry = {
    serverId: config.serverId,
    start: makeNpmServerStarter(config),
  };
  for (const language of config.languages) NPM_REGISTRY[language] = entry;
}

// Same, for SDK-provided servers launched from the PATH (Dart, Go): opening a
// `.dart` file starts the SDK's `dart language-server`. One line in
// `SYSTEM_SERVERS` adds a language.
const SYSTEM_REGISTRY: Record<string, ServerEntry> = {};
for (const config of SYSTEM_SERVERS) {
  const entry: ServerEntry = {
    serverId: config.serverId,
    start: makeSystemServerStarter(config),
  };
  for (const language of config.languages) SYSTEM_REGISTRY[language] = entry;
}

/** Monaco language id -> server entry. */
export const SERVER_REGISTRY: Record<string, ServerEntry> = {
  ...BASE_REGISTRY,
  ...NPM_REGISTRY,
  ...SYSTEM_REGISTRY,
};

/** Languages that have a registered LSP server. */
export function lspLanguageIds(): string[] {
  return Object.keys(SERVER_REGISTRY);
}

/** Resolves the server entry for a Monaco language id, or null if unsupported. */
export function serverIdForLanguage(language: string): ServerEntry | null {
  return SERVER_REGISTRY[language] ?? null;
}
