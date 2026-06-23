import { invoke, Channel } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  BlameHunk,
  FileNode,
  GitBranchInfo,
  GitCommit,
  GitStatus,
  OpenTab,
  ProjectFile,
  RawDirEntry,
  RunConfig,
  SearchOptions,
  SearchStreamEvent,
  Session,
} from "./types";
import type {
  AcpEvent,
  AgentMode,
  AgentStore,
  RevertPoint,
} from "./agents/types";

/** Raw shape returned by the Rust `git_status` (snake_case from serde). */
interface RawGitStatus {
  branch: string;
  ahead: number;
  behind: number;
  is_repo: boolean;
  has_upstream: boolean;
  files: GitStatus["files"];
}

/** Opens the native folder picker; returns the chosen path or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

/** Opens the native file picker (single file); returns the chosen path or null. */
export async function pickFile(): Promise<string | null> {
  const selected = await open({ multiple: false });
  return typeof selected === "string" ? selected : null;
}

/** Native "save as" dialog; returns the chosen destination path or null if cancelled. */
export async function pickSavePath(defaultName?: string): Promise<string | null> {
  const selected = await save({ defaultPath: defaultName });
  return typeof selected === "string" ? selected : null;
}

/** Lists the immediate children of `path` and maps them to `FileNode`s. */
export async function readDir(path: string): Promise<FileNode[]> {
  const entries = await invoke<RawDirEntry[]>("read_dir", { path });
  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    isDir: e.is_dir,
  }));
}

/** Reads a text file's contents. */
export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

/**
 * Reads a file's bytes as a base64 `data:` URL (mime inferred from extension).
 * Used by the image preview mode — see {@link ImagePreview}.
 */
export function readFileBase64(path: string): Promise<string> {
  return invoke<string>("read_file_base64", { path });
}

/** Writes contents to a file. */
export function writeFile(path: string, contents: string): Promise<void> {
  return invoke("write_file", { path, contents });
}

function mapDirEntry(entry: RawDirEntry): FileNode {
  return { name: entry.name, path: entry.path, isDir: entry.is_dir };
}

export async function createFile(
  workspaceRoot: string,
  parent: string,
  name: string
): Promise<FileNode> {
  return mapDirEntry(
    await invoke<RawDirEntry>("create_file", { workspaceRoot, parent, name })
  );
}

export async function createFolder(
  workspaceRoot: string,
  parent: string,
  name: string
): Promise<FileNode> {
  return mapDirEntry(
    await invoke<RawDirEntry>("create_folder", { workspaceRoot, parent, name })
  );
}

/** Renames `path` to `newName` in place; rejects on collision. */
export async function renamePath(
  workspaceRoot: string,
  path: string,
  newName: string
): Promise<FileNode> {
  return mapDirEntry(
    await invoke<RawDirEntry>("rename_path", { workspaceRoot, path, newName })
  );
}

/** Moves `path` to the OS recycle bin (recoverable). */
export function deleteToTrash(workspaceRoot: string, path: string): Promise<void> {
  return invoke("delete_to_trash", { workspaceRoot, path });
}

/** Copies `src` (file/folder, recursive) into `destParent`, resolving collisions. */
export async function copyPath(
  workspaceRoot: string,
  src: string,
  destParent: string
): Promise<FileNode> {
  return mapDirEntry(
    await invoke<RawDirEntry>("copy_path", { workspaceRoot, src, destParent })
  );
}

/** Moves `src` (file/folder, recursive) into `destParent`, resolving collisions. */
export async function movePath(
  workspaceRoot: string,
  src: string,
  destParent: string
): Promise<FileNode> {
  return mapDirEntry(
    await invoke<RawDirEntry>("move_path", { workspaceRoot, src, destParent })
  );
}

/** Opens the OS file manager with `path` selected (Windows `explorer /select,`). */
export function revealInExplorer(workspaceRoot: string, path: string): Promise<void> {
  return invoke("reveal_in_explorer", { workspaceRoot, path });
}

/**
 * Writes `text` to the OS clipboard. Uses the WebView clipboard API, which is
 * available inside a user-gesture handler (menu click / shortcut) in Tauri's
 * WebView2; this avoids pulling in an extra Tauri plugin just for plain text.
 * Returns false (without throwing) when the write fails, so callers can decide
 * whether to surface a message.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error("Falha ao copiar para a área de transferência:", err);
    return false;
  }
}

/**
 * Streams a recursive search of `root` for `query`, honoring `.gitignore`, the
 * fixed heavy-folder skip list and the user's `options` (regex, case-sensitivity,
 * whole-word, include/exclude globs). Results arrive incrementally on `onEvent`
 * — one `matches` event per file, then a final `done` event. The returned
 * Promise resolves when the search finishes and rejects on an invalid regex (so
 * callers can flag the input). Starting a new search cancels any in-flight one.
 */
export function searchInDir(
  root: string,
  query: string,
  options: SearchOptions,
  onEvent: (event: SearchStreamEvent) => void
): Promise<void> {
  const channel = new Channel<SearchStreamEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("search_in_dir", { root, query, options, onEvent: channel });
}

export function cancelSearch(): Promise<void> {
  return invoke<void>("cancel_search");
}

/**
 * Warms the in-memory file index for `root` so the first search is instant.
 * Fire-and-forget: called when a folder opens. The index is the cached list of
 * searchable paths (the directory walk + ignore-file parsing); searches reuse it
 * while fresh, so typing doesn't re-walk the disk on every keystroke.
 */
export function buildSearchIndex(root: string): Promise<void> {
  return invoke<void>("build_search_index", { root });
}

/** Lists every file under `root` (skipping heavy dirs) for Quick Open (Ctrl+P). */
export function listProjectFiles(root: string): Promise<ProjectFile[]> {
  return invoke<ProjectFile[]>("list_project_files", { root });
}

/** Returns the current git branch for `path`, or null if not a repo. */
export function gitBranch(path: string): Promise<string | null> {
  return invoke<string | null>("git_branch", { path });
}

/** Raw shape returned by the Rust `git_branches` (snake_case from serde). */
interface RawGitBranchInfo {
  name: string;
  current: boolean;
  short: string;
  date: string;
  author: string;
  subject: string;
  ahead: number;
  behind: number;
  has_upstream: boolean;
}

/**
 * Lists local branches for the picker (issue #16), most-recently-committed
 * first. Empty when `path` isn't a git repo.
 */
export async function gitBranches(path: string): Promise<GitBranchInfo[]> {
  const raw = await invoke<RawGitBranchInfo[]>("git_branches", { path });
  return raw.map((b) => ({
    name: b.name,
    current: b.current,
    short: b.short,
    date: b.date,
    author: b.author,
    subject: b.subject,
    ahead: b.ahead,
    behind: b.behind,
    hasUpstream: b.has_upstream,
  }));
}

/** Checks out an existing local branch. Rejects with git's message on failure. */
export function gitCheckout(path: string, branch: string): Promise<void> {
  return invoke("git_checkout", { path, branch });
}

/** Creates a new branch from HEAD and checks it out (`git checkout -b`). */
export function gitCreateBranch(path: string, name: string): Promise<void> {
  return invoke("git_create_branch", { path, name });
}

/** Working-tree status: branch, ahead/behind, and changed files. */
export async function gitStatus(path: string): Promise<GitStatus> {
  const raw = await invoke<RawGitStatus>("git_status", { path });
  return {
    branch: raw.branch,
    ahead: raw.ahead,
    behind: raw.behind,
    isRepo: raw.is_repo,
    hasUpstream: raw.has_upstream,
    files: raw.files,
  };
}

export function gitStage(path: string, file: string): Promise<void> {
  return invoke("git_stage", { path, file });
}
export function gitUnstage(path: string, file: string): Promise<void> {
  return invoke("git_unstage", { path, file });
}
export function gitStageAll(path: string): Promise<void> {
  return invoke("git_stage_all", { path });
}
export function gitCommit(path: string, message: string): Promise<void> {
  return invoke("git_commit", { path, message });
}
export function gitFetch(path: string): Promise<void> {
  return invoke("git_fetch", { path });
}
export function gitPull(path: string): Promise<string> {
  return invoke<string>("git_pull", { path });
}
export function gitPush(path: string): Promise<string> {
  return invoke<string>("git_push", { path });
}
export function gitLog(path: string, limit = 30): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_log", { path, limit });
}

/**
 * History of a single file (ISSUE-71 · File History): commits that touched
 * `file`, newest first, following renames. `file` may be absolute or relative
 * to the repo at `path`.
 */
export function gitLogFile(
  path: string,
  file: string,
  limit = 50
): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_log_file", { path, file, limit });
}

/** Returns per-line blame info for `file` inside the repo at `root`. */
export function gitBlame(root: string, file: string): Promise<BlameHunk[]> {
  return invoke<BlameHunk[]>("git_blame", { root, file });
}

interface RawGitSnapshot {
  snapshot_id: string;
  head: string;
}

/**
 * Captures the working tree at `path` so a later restore can undo what the agent
 * changes next. Resolves to null when `path` isn't a git repo (revert disabled).
 */
export async function gitSnapshotCreate(
  path: string,
): Promise<RevertPoint | null> {
  try {
    const raw = await invoke<RawGitSnapshot>("git_snapshot_create", { path });
    return { snapshotId: raw.snapshot_id, head: raw.head };
  } catch {
    return null;
  }
}

/** Restores the working tree at `path` to a snapshot, discarding agent edits. */
export function gitSnapshotRestore(
  path: string,
  point: RevertPoint,
): Promise<void> {
  return invoke("git_snapshot_restore", {
    path,
    snapshotId: point.snapshotId,
    head: point.head,
  });
}

export function termCreate(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  command?: string | null
): Promise<void> {
  return invoke("term_create", { id, cwd, cols, rows, command: command ?? null });
}
export function termWrite(id: string, data: string): Promise<void> {
  return invoke("term_write", { id, data });
}
export function termResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("term_resize", { id, cols, rows });
}
export function termClose(id: string): Promise<void> {
  return invoke("term_close", { id });
}

// ---- Run / Debug configurations ----

/** Loads saved run configs from `.project/run.json` (empty if none yet). */
export function runConfigsLoad(root: string): Promise<RunConfig[]> {
  return invoke<RunConfig[]>("run_configs_load", { root });
}
/** Persists run configs to `.project/run.json`. */
export function runConfigsSave(root: string, configs: RunConfig[]): Promise<void> {
  return invoke("run_configs_save", { root, configs });
}
/** Suggests run configs by inspecting package.json scripts, Cargo.toml, etc. */
export function runConfigsDetect(root: string): Promise<RunConfig[]> {
  return invoke<RunConfig[]>("run_configs_detect", { root });
}

// ---- Local CLI agents ----

/** Loads agents and conversation history from `<root>/.project/agents.json`. */
export function agentsLoad(root: string): Promise<AgentStore> {
  return invoke<AgentStore>("agents_load", { root });
}

/** Persists agents and conversation history inside the current workspace. */
export function agentsSave(root: string, store: AgentStore): Promise<void> {
  return invoke("agents_save", { root, store });
}

/**
 * Runs one prompt against the selected local CLI provider. Text and lifecycle
 * updates are streamed through a request-scoped Tauri channel.
 */
export function acpPrompt(
  provider: "codex" | "claude",
  workspaceRoot: string,
  conversationId: string,
  contextPrompt: string,
  prompt: string,
  mode: AgentMode,
  onEvent: (event: AcpEvent) => void,
): Promise<void> {
  const channel = new Channel<AcpEvent>();
  channel.onmessage = onEvent;
  return invoke("acp_prompt", {
    provider,
    workspaceRoot,
    conversationId,
    contextPrompt,
    prompt,
    mode,
    onEvent: channel,
  });
}

/** Interrupts the in-flight turn while preserving any streamed response. */
export function acpCancel(): Promise<void> {
  return invoke("acp_cancel");
}

/** Stops cached provider processes and sessions associated with a workspace. */
export function acpStopWorkspace(workspaceRoot: string): Promise<void> {
  return invoke("acp_stop_workspace", { workspaceRoot });
}

// ---- Session (reopen last project + tabs on launch) ----

/**
 * Loads the persisted session (empty on first run). `openTabs`/`activePath` are
 * normalized to a list/null so callers can treat pre-tabs sessions uniformly.
 */
export async function sessionLoad(): Promise<Session> {
  const s = await invoke<Partial<Session>>("session_load");
  return {
    lastFolder: s.lastFolder ?? null,
    openTabs: s.openTabs ?? [],
    activePath: s.activePath ?? null,
  };
}
/** Remembers the last opened project folder (pass null to clear). */
export function sessionSetLastFolder(folder: string | null): Promise<void> {
  return invoke("session_set_last_folder", { folder });
}
/**
 * Persists the open tabs (paths + view mode, in tab-bar order) and the active
 * tab, leaving the saved folder untouched. The backend re-reads file content
 * from disk on the next launch, so neither content nor `dirty` is sent.
 */
export function sessionSetOpenFiles(
  tabs: OpenTab[],
  activePath: string | null
): Promise<void> {
  return invoke("session_set_open_files", { tabs, activePath });
}

// ---- Windows ----

/** Opens a new, isolated editor window (a separate OS process), starting empty. */
export function openNewWindow(): Promise<void> {
  return invoke("open_new_window");
}

/** Whether this window was launched fresh (`--new`) and should start empty. */
export function isFreshWindow(): Promise<boolean> {
  return invoke<boolean>("is_fresh_window");
}

// ---- LSP (language servers) ----

/** Bridge connection info returned by the backend (`{ port, token }`). */
export interface LspBridgeInfo {
  port: number;
  token: string;
}

/** `{ program, args }` resolved by `lsp_ensure_ts_server` (TS/JS). */
export interface LspLaunchInfo {
  program: string;
  args: string[];
}

/**
 * Spawns an LSP server `id` (`program`/`args`/`cwd` pre-resolved) and opens its
 * local WS bridge. Returns the bridge `{ port, token }`.
 */
export function startLspServer(
  id: string,
  program: string,
  args: string[],
  cwd: string
): Promise<LspBridgeInfo> {
  return invoke<LspBridgeInfo>("lsp_start_server", { id, program, args, cwd });
}

/** Stops the LSP server with the given id and tears down its bridge/process. */
export function stopLspServer(id: string): Promise<void> {
  return invoke("lsp_stop_server", { id });
}

/** Returns the bridge `{ port, token }` for an active session (reconnect). */
export function lspBridgeInfo(id: string): Promise<LspBridgeInfo> {
  return invoke<LspBridgeInfo>("lsp_bridge_info", { id });
}

/**
 * Ensures the Roslyn C# server is cached and `dotnet` is present. Returns the
 * launch command as `"<program>\n<arg1>\n…"` (the caller splits it).
 */
export function ensureCsharpServer(rootPath: string): Promise<string> {
  return invoke<string>("lsp_ensure_csharp_server", { rootPath });
}

/** One diagnostic parsed from `dotnet build`, mirroring the Rust `BuildDiagnostic`. */
export interface BuildDiagnostic {
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code: string;
  message: string;
}

/**
 * Runs the real compiler (`dotnet build`) over the workspace and returns its
 * errors/warnings (issue #11) — pragmatic ground-truth diagnostics for C# and
 * Razor (.cshtml), with file/line/column, independent of the LSP.
 */
export function csharpBuildDiagnostics(rootPath: string): Promise<BuildDiagnostic[]> {
  return invoke<BuildDiagnostic[]>("csharp_build_diagnostics", { rootPath });
}

/**
 * Resolves the `typescript-language-server` launch command for a project,
 * auto-installing it into the app cache when missing. `preferEditor` forces the
 * editor-managed (cached) TypeScript version instead of the project's.
 */
export function ensureTsServer(
  rootPath: string,
  preferEditor: boolean
): Promise<LspLaunchInfo> {
  return invoke<LspLaunchInfo>("lsp_ensure_ts_server", { rootPath, preferEditor });
}

/**
 * Ensures the Roslyn cohosting server (C# extension VSIX) is downloaded/cached.
 * Returns the launch command as `"<program>\n<arg1>\n…"` (program on first line).
 */
export function ensureRazorServer(): Promise<string> {
  return invoke<string>("lsp_ensure_razor_server");
}

/**
 * Resolves the launch command for an npm-distributed language server (Python,
 * YAML, JSON/HTML/CSS, Bash, Dockerfile, …) by its `serverId`, auto-installing it
 * into the app cache on first use. Progress arrives via `lsp-download-progress`.
 */
export function ensureNpmLspServer(serverId: string): Promise<LspLaunchInfo> {
  return invoke<LspLaunchInfo>("lsp_ensure_npm_server", { serverId });
}

/**
 * Resolves the launch command for an SDK-provided language server (Dart, Go, …)
 * from the user's PATH — no download. Rejects with an install hint when the
 * SDK's server isn't found.
 */
export function ensureSystemLspServer(serverId: string): Promise<LspLaunchInfo> {
  return invoke<LspLaunchInfo>("lsp_ensure_system_server", { serverId });
}

/**
 * Resolves the launch command for the built-in `fluent-cshtml-lsp` server.
 * The binary ships alongside the app; no download or npm step is needed.
 * Returns the launch command as `"<program>"` (single line, no args).
 */
export function ensureFluentCshtmlServer(): Promise<string> {
  return invoke<string>("lsp_ensure_fluent_cshtml_server");
}

// ── Razor projection broker (ADR 0002) ────────────────────────────────────────

/** Summary returned by {@link razorPrepare}. */
export interface RazorPrepareResult {
  /** Directory of the generated shadow project. */
  shadowDir: string;
  /** Solution (user + shadow) to open in the Roslyn client. */
  solutionPath: string;
  /** `.cshtml` (relative) that got a usable projection. */
  available: string[];
  /** `.cshtml` (relative) requested but with no projection (degraded). */
  missing: string[];
}

/** A remapped 0-based LSP position. */
export interface RazorRemapPos {
  line: number;
  character: number;
}

/**
 * Prepare projection serving: generates the projected C# for `cshtmlRels`
 * (relative to `userProjectDir`), materializes the shadow project + solution, and
 * caches one source map per `.cshtml`. Runs `dotnet` off the UI thread.
 */
export function razorPrepare(opts: {
  workspaceDir: string;
  userProjectDir: string;
  userCsprojPath: string;
  config: string;
  cshtmlRels: string[];
}): Promise<RazorPrepareResult> {
  return invoke<RazorPrepareResult>("razor_prepare", opts);
}

/** Map a `.cshtml` position to the projected C#. `null` if unmapped/no map. */
export function razorRemapToGenerated(
  cshtmlPath: string,
  line: number,
  character: number
): Promise<RazorRemapPos | null> {
  return invoke<RazorRemapPos | null>("razor_remap_to_generated", { cshtmlPath, line, character });
}

/** Map a projected-C# position back to the `.cshtml`. `null` if synthetic/no map. */
export function razorRemapToSource(
  cshtmlPath: string,
  line: number,
  character: number
): Promise<RazorRemapPos | null> {
  return invoke<RazorRemapPos | null>("razor_remap_to_source", { cshtmlPath, line, character });
}

/** Drop a `.cshtml`'s cached source map (on close). */
export function razorForget(cshtmlPath: string): Promise<void> {
  return invoke<void>("razor_forget", { cshtmlPath });
}
