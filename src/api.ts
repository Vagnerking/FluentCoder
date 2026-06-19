import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  BlameHunk,
  FileNode,
  GitCommit,
  GitStatus,
  ProjectFile,
  RawDirEntry,
  RunConfig,
  SearchMatch,
  Session,
} from "./types";

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

/** Recursively searches `root` for lines containing `query` (case-insensitive). */
export function searchInDir(root: string, query: string): Promise<SearchMatch[]> {
  return invoke<SearchMatch[]>("search_in_dir", { root, query });
}

/** Lists every file under `root` (skipping heavy dirs) for Quick Open (Ctrl+P). */
export function listProjectFiles(root: string): Promise<ProjectFile[]> {
  return invoke<ProjectFile[]>("list_project_files", { root });
}

/** Returns the current git branch for `path`, or null if not a repo. */
export function gitBranch(path: string): Promise<string | null> {
  return invoke<string | null>("git_branch", { path });
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

// ---- Session (reopen last project on launch) ----

/** Loads the persisted session (empty on first run). */
export function sessionLoad(): Promise<Session> {
  return invoke<Session>("session_load");
}
/** Remembers the last opened project folder (pass null to clear). */
export function sessionSetLastFolder(folder: string | null): Promise<void> {
  return invoke("session_set_last_folder", { folder });
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

/** Resolves the `typescript-language-server` launch command for a project. */
export function ensureTsServer(rootPath: string): Promise<LspLaunchInfo> {
  return invoke<LspLaunchInfo>("lsp_ensure_ts_server", { rootPath });
}

/** Resolves the rzls executable path (rejects if not cached — download stubbed). */
export function ensureRazorServer(): Promise<string> {
  return invoke<string>("lsp_ensure_razor_server");
}
