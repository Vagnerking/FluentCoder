import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getActiveRemote } from "./remote/host";
import type {
  BlameHunk,
  FileNode,
  GitBranchInfo,
  GitCommit,
  GitCommitFile,
  GitGraphCommit,
  GitRemoteInfo,
  GitStashEntry,
  GitStashFile,
  GitStatus,
  GitUpstreamComparison,
  GitWorktreeInfo,
  Eol,
  GraphData,
  KnowledgeIndex,
  McpConfig,
  OpenTab,
  PackageWorkspaceSummary,
  PackageDependency,
  PackageLockfile,
  PackageManager,
  PackageOutdatedReport,
  PackageAuditReport,
  PackageVersionsReport,
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
import { getFilesExcludeGlobs } from "./settings/filesExclude";

/** Raw shape returned by the Rust `git_status` (snake_case from serde). */
interface RawGitStatus {
  branch: string;
  ahead: number;
  behind: number;
  is_repo: boolean;
  has_upstream: boolean;
  conflicted: number;
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

/** Opens a local Fluent/VS Code workspace file. */
export async function pickWorkspaceFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Workspace", extensions: ["fluent-workspace", "code-workspace"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Native "save as" dialog; returns the chosen destination path or null if cancelled. */
export async function pickSavePath(defaultName?: string): Promise<string | null> {
  const selected = await save({ defaultPath: defaultName });
  return typeof selected === "string" ? selected : null;
}

/** Native "save workspace as" dialog. Workspace files are always local files. */
export async function pickWorkspaceSavePath(defaultName?: string): Promise<string | null> {
  const selected = await save({
    defaultPath: defaultName,
    filters: [{ name: "Fluent Workspace", extensions: ["fluent-workspace"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Workspace files passed by the OS at launch, e.g. double-clicking `.fluent-workspace`. */
export function openedWorkspaceFiles(): Promise<string[]> {
  return invoke<string[]>("opened_workspace_files");
}

/** Remote SFTP dir entry — `ssh_list_dir` already serializes camelCase. */
interface RemoteDirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/**
 * The opened folder's root path, used to evaluate prefix-anchored `files.exclude`
 * globs (e.g. `src/generated`, `foo/bar` subtree) against each entry's
 * workspace-relative path. Set on folder open; basename patterns (globstar `bin`)
 * work regardless. Module-scoped so the `readDir(path)` call sites stay unchanged.
 */
let explorerWorkspaceRoot: string | null = null;

/** Records the opened folder so `readDir` can anchor `files.exclude` globs. */
export function setExplorerWorkspaceRoot(root: string | null): void {
  explorerWorkspaceRoot = root;
}

/**
 * Lists the immediate children of `path` and maps them to `FileNode`s. When a
 * remote SSH session is attached, the listing comes from the host over SFTP
 * (issue #8); otherwise from the local filesystem, where entries matching the
 * active `files.exclude` globs (e.g. `bin`/`obj`/`.git`, or prefix-anchored ones
 * like `src/generated`) are hidden by the backend so the tree mirrors VS Code's
 * exclusion behavior.
 */
export async function readDir(path: string): Promise<FileNode[]> {
  const remote = getActiveRemote();
  if (remote) {
    const entries = await invoke<RemoteDirEntry[]>("ssh_list_dir", {
      connId: remote.connId,
      path,
    });
    return entries.map((e) => ({ name: e.name, path: e.path, isDir: e.isDir }));
  }
  const entries = await invoke<RawDirEntry[]>("read_dir", {
    path,
    exclude: getFilesExcludeGlobs(),
    workspaceRoot: explorerWorkspaceRoot,
  });
  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    isDir: e.is_dir,
  }));
}

export type { Eol };

/** A decoded text file plus the metadata needed to round-trip it on save. */
export interface DecodedFile {
  /** Contents, normalised to LF line endings. */
  content: string;
  /** Encoding label (e.g. "UTF-8", "UTF-16LE", "windows-1252"). */
  encoding: string;
  /** Whether the file began with a byte-order mark. */
  bom: boolean;
  /** Original line-ending style. */
  eol: Eol;
}

/**
 * Reads a text file with encoding + line-ending detection (remote over SFTP
 * when a session is attached). Local files go through the Rust detector (BOM,
 * UTF-16, Windows-1252/Latin-1 heuristic); remote SFTP reads are assumed UTF-8
 * + LF since the SFTP path returns a decoded string.
 */
export async function readFile(path: string): Promise<DecodedFile> {
  const remote = getActiveRemote();
  if (remote) {
    const content = await invoke<string>("ssh_read_file", {
      connId: remote.connId,
      path,
    });
    return { content, encoding: "UTF-8", bom: false, eol: "Lf" };
  }
  return invoke<DecodedFile>("read_file", { path });
}

/** Reads a text file from a specific SSH connection, independent of window state. */
export async function readSshTextFile(connId: string, path: string): Promise<DecodedFile> {
  const content = await invoke<string>("ssh_read_file", { connId, path });
  return { content, encoding: "UTF-8", bom: false, eol: "Lf" };
}

/** Reads a local text file even when the app is attached to an SSH workspace. */
export async function readLocalTextFile(path: string): Promise<string> {
  return (await invoke<DecodedFile>("read_file", { path })).content;
}

/**
 * Re-reads a local file forcing a specific encoding ("Reopen with Encoding").
 * Not available on remote SSH workspaces — the encoding detector only runs on
 * the local FS command, so we reject rather than read the remote path locally.
 */
export function readFileWithEncoding(
  path: string,
  encoding: string
): Promise<DecodedFile> {
  if (getActiveRemote()) {
    return Promise.reject(
      new Error("Reabrir com codificação ainda não é suportado em workspaces remotos.")
    );
  }
  return invoke<DecodedFile>("read_file_with_encoding", { path, encoding });
}

const PACKAGE_LOCKFILES: { name: string; manager: PackageManager }[] = [
  { name: "package-lock.json", manager: "npm" },
  { name: "npm-shrinkwrap.json", manager: "npm" },
  { name: "pnpm-lock.yaml", manager: "pnpm" },
  { name: "yarn.lock", manager: "yarn" },
  { name: "bun.lockb", manager: "bun" },
  { name: "bun.lock", manager: "bun" },
];

function normalizeProjectRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function joinRemotePath(root: string, rel: string): string {
  return rel ? `${root.replace(/\/+$/, "")}/${rel}` : root;
}

function relDir(path: string): string {
  const normalized = normalizeProjectRel(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function parsePackageManager(raw: unknown): PackageManager | null {
  if (typeof raw !== "string") return null;
  const name = raw.split("@")[0]?.trim().toLowerCase();
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun"
    ? name
    : null;
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function objectSize(value: unknown): number {
  return objectKeys(value).length;
}

function readPackageDependencies(json: Record<string, unknown>): PackageDependency[] {
  const deps: PackageDependency[] = [];
  for (const kind of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const value = json[kind];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [name, declaredVersion] of Object.entries(value)) {
      if (typeof declaredVersion !== "string") continue;
      deps.push({ name, declaredVersion, kind });
    }
  }
  return deps.sort((a, b) => a.name.localeCompare(b.name));
}

function uniqueManagers(lockfiles: PackageLockfile[]): PackageManager[] {
  return Array.from(new Set(lockfiles.map((lock) => lock.manager))).sort();
}

function chooseManagerFromLocks(managers: PackageManager[]): PackageManager {
  for (const candidate of ["pnpm", "yarn", "bun", "npm"] as const) {
    if (managers.includes(candidate)) return candidate;
  }
  return "npm";
}

function recommendPackageManager(
  declared: unknown,
  lockfiles: PackageLockfile[]
): PackageWorkspaceSummary["projects"][number]["detectedManager"] {
  const declaredManager = parsePackageManager(declared);
  if (declaredManager) {
    return {
      manager: declaredManager,
      confidence: "high",
      reason: "Definido explicitamente no campo packageManager do package.json.",
    };
  }
  const managers = uniqueManagers(lockfiles);
  if (managers.length === 1) {
    return {
      manager: managers[0],
      confidence: "high",
      reason: `Detectado pelo lockfile ${lockfiles[0]?.name ?? managers[0]}.`,
    };
  }
  if (managers.length > 1) {
    return {
      manager: chooseManagerFromLocks(managers),
      confidence: "medium",
      reason:
        "Há múltiplos lockfiles; escolha sugerida pela prioridade pnpm/yarn/bun/npm até o usuário confirmar.",
    };
  }
  return {
    manager: "npm",
    confidence: "low",
    reason:
      "Nenhum lockfile ou packageManager encontrado; npm é o fallback universal para package.json.",
  };
}

function packageWarnings(declared: unknown, lockfiles: PackageLockfile[]): string[] {
  const warnings: string[] = [];
  const managers = uniqueManagers(lockfiles);
  if (managers.length > 1) {
    warnings.push(
      "Múltiplos lockfiles encontrados. Isso pode instalar árvores diferentes entre máquinas."
    );
  }
  if (lockfiles.length === 0) {
    warnings.push(
      "Sem lockfile. Instalações podem variar entre máquinas/CI se versões não estiverem travadas."
    );
  }
  if (typeof declared === "string") {
    const declaredManager = parsePackageManager(declared);
    if (declaredManager && managers.length > 0 && !managers.includes(declaredManager)) {
      warnings.push(
        `packageManager declara ${declaredManager}, mas os lockfiles apontam para outro gerenciador.`
      );
    } else if (!declaredManager) {
      warnings.push(
        `packageManager não reconhecido: ${declared}. Suportados agora: npm, pnpm, yarn e bun.`
      );
    }
  }
  return warnings;
}

async function sshPackageIntelScan(
  root: string,
  connId: string
): Promise<PackageWorkspaceSummary> {
  const files = await listProjectFiles(root, connId);
  const relFiles = new Set(files.map((file) => normalizeProjectRel(file.rel)));
  const packageFiles = files
    .filter((file) => file.name === "package.json")
    .sort((a, b) => normalizeProjectRel(a.rel).localeCompare(normalizeProjectRel(b.rel)));
  const projects: PackageWorkspaceSummary["projects"] = [];

  for (const file of packageFiles) {
    const path = normalizeProjectRel(file.rel);
    const dirRel = relDir(path);
    try {
      const raw = (await readSshTextFile(connId, file.path)).content;
      const json = JSON.parse(raw) as Record<string, unknown>;
      if (!json || typeof json !== "object" || Array.isArray(json)) continue;
      const lockfiles = PACKAGE_LOCKFILES.flatMap((lock): PackageLockfile[] => {
        const lockRel = normalizeProjectRel(dirRel ? `${dirRel}/${lock.name}` : lock.name);
        return relFiles.has(lockRel)
          ? [{ name: lock.name, path: lockRel, manager: lock.manager }]
          : [];
      });
      const name =
        typeof json.name === "string" && json.name.trim()
          ? json.name
          : dirRel.split("/").filter(Boolean).pop() || "package";
      const dependencies = readPackageDependencies(json);
      const declaredPackageManager =
        typeof json.packageManager === "string" ? json.packageManager : null;
      projects.push({
        name,
        path,
        dir: joinRemotePath(root, dirRel),
        relativeDir: dirRel || ".",
        declaredPackageManager,
        detectedManager: recommendPackageManager(json.packageManager, lockfiles),
        lockfiles,
        scripts: objectKeys(json.scripts),
        dependencies,
        dependencyCounts: {
          dependencies: objectSize(json.dependencies),
          devDependencies: objectSize(json.devDependencies),
          peerDependencies: objectSize(json.peerDependencies),
          optionalDependencies: objectSize(json.optionalDependencies),
        },
        hasWorkspaces: Boolean(json.workspaces),
        warnings: packageWarnings(json.packageManager, lockfiles),
      });
    } catch {
      /* Ignore malformed/unreadable manifests, matching the local scanner. */
    }
  }

  const managerCounts: Record<string, number> = {};
  let warningCount = 0;
  for (const project of projects) {
    managerCounts[project.detectedManager.manager] =
      (managerCounts[project.detectedManager.manager] ?? 0) + 1;
    warningCount += project.warnings.length;
  }

  return { root, projects, managerCounts, warningCount };
}

/** Scans JS/TS package manifests and recommends the package manager per project. */
export function packageIntelScan(
  root: string,
  connId?: string
): Promise<PackageWorkspaceSummary> {
  if (connId) return sshPackageIntelScan(root, connId);
  return invoke<PackageWorkspaceSummary>("package_intel_scan", { root });
}

/** Read-only dependency version check. Does not update package.json/lockfiles. */
export function packageIntelOutdated(
  root: string,
  projectPath: string,
  manager: PackageManager,
  connId?: string
): Promise<PackageOutdatedReport> {
  if (connId) {
    return invoke<PackageOutdatedReport>("ssh_package_intel_outdated", {
      connId,
      root,
      projectPath,
      manager,
    });
  }
  return invoke<PackageOutdatedReport>("package_intel_outdated", {
    root,
    projectPath,
    manager,
  });
}

/** Read-only security audit. Does not run audit fix or install/update packages. */
export function packageIntelAudit(
  root: string,
  projectPath: string,
  manager: PackageManager,
  connId?: string
): Promise<PackageAuditReport> {
  if (connId) {
    return invoke<PackageAuditReport>("ssh_package_intel_audit", {
      connId,
      root,
      projectPath,
      manager,
    });
  }
  return invoke<PackageAuditReport>("package_intel_audit", {
    root,
    projectPath,
    manager,
  });
}

/** Reads real published versions for one package through the selected package manager. */
export function packageIntelVersions(
  root: string,
  projectPath: string,
  manager: PackageManager,
  packageName: string,
  connId?: string
): Promise<PackageVersionsReport> {
  if (connId) {
    return invoke<PackageVersionsReport>("ssh_package_intel_versions", {
      connId,
      root,
      projectPath,
      manager,
      packageName,
    });
  }
  return invoke<PackageVersionsReport>("package_intel_versions", {
    root,
    projectPath,
    manager,
    packageName,
  });
}

/**
 * Reads a file's bytes as a base64 `data:` URL (mime inferred from extension).
 * Used by the image/video/audio preview modes. Routes over SFTP when a remote
 * session is attached.
 */
export function readFileBase64(path: string): Promise<string> {
  const remote = getActiveRemote();
  if (remote) {
    return invoke<string>("ssh_read_file_base64", { connId: remote.connId, path });
  }
  return invoke<string>("read_file_base64", { path });
}

/** Reads bytes as base64 through a specific SSH connection. */
export function readSshFileBase64(connId: string, path: string): Promise<string> {
  return invoke<string>("ssh_read_file_base64", { connId, path });
}

/**
 * Writes contents to a file (remote over SFTP when a session is attached).
 *
 * `contents` is the editor's LF buffer. When `encoding`/`eol`/`bom` are given
 * (the normal save of an opened file), the local backend re-applies them so the
 * file keeps its original encoding/BOM/line ending. The remote SFTP path writes
 * the buffer as-is (UTF-8/LF).
 */
export function writeFile(
  path: string,
  contents: string,
  opts?: { encoding?: string; eol?: Eol; bom?: boolean }
): Promise<void> {
  const remote = getActiveRemote();
  if (remote) {
    return invoke("ssh_write_file", { connId: remote.connId, path, contents });
  }
  return invoke("write_file", {
    path,
    contents,
    encoding: opts?.encoding ?? null,
    eol: opts?.eol ?? null,
    bom: opts?.bom ?? null,
  });
}

/** Writes a text file through a specific SSH connection, independent of window state. */
export function writeSshTextFile(
  connId: string,
  path: string,
  contents: string
): Promise<void> {
  return invoke("ssh_write_file", { connId, path, contents });
}

/** Writes a local text file even when the app is attached to an SSH workspace. */
export function writeLocalTextFile(path: string, contents: string): Promise<void> {
  return invoke("write_file", {
    path,
    contents,
    encoding: null,
    eol: null,
    bom: null,
  });
}

// ---- Remote SSH (issue #8) ----

/** Credentials/target for opening an SSH connection. */
export interface SshConnectInput {
  host: string;
  port?: number;
  user: string;
  /** Password auth; omit to use a private key instead. */
  password?: string;
  /** Path to a private-key file (used when no password is given). */
  keyPath?: string;
  /** Passphrase for an encrypted private key. */
  keyPassphrase?: string;
  /** Authenticate through the running SSH agent (ignores password/key). */
  useAgent?: boolean;
}

/**
 * Opens an SSH connection and returns a connection id used by subsequent remote
 * FS calls. Rejects with a human-readable message on auth/connection failure.
 */
export function sshConnect(input: SshConnectInput): Promise<string> {
  return invoke<string>("ssh_connect", { args: input });
}

/** Closes a remote connection and frees it on the backend. */
export function sshDisconnect(connId: string): Promise<void> {
  return invoke("ssh_disconnect", { connId });
}

/**
 * Lists a remote directory by explicit connection id (used by the folder browser
 * before a session is attached). Unlike {@link readDir}, it never routes locally.
 */
export async function sshListDir(connId: string, path: string): Promise<FileNode[]> {
  const entries = await invoke<RemoteDirEntry[]>("ssh_list_dir", { connId, path });
  return entries.map((e) => ({ name: e.name, path: e.path, isDir: e.isDir }));
}

/** Resolves a remote path to its absolute canonical form (`.` → home). */
export function sshCanonicalize(connId: string, path: string): Promise<string> {
  return invoke<string>("ssh_canonicalize", { connId, path });
}

/** A host parsed from the user's `~/.ssh/config`. */
export interface SavedHost {
  label: string;
  host: string;
  user?: string | null;
  port?: number | null;
  identityFile?: string | null;
}

/** Lists hosts from `~/.ssh/config` (like VS Code / Zed). Empty when none. */
export function sshListSavedHosts(): Promise<SavedHost[]> {
  return invoke<SavedHost[]>("ssh_list_saved_hosts");
}

function mapDirEntry(entry: RawDirEntry): FileNode {
  return { name: entry.name, path: entry.path, isDir: entry.is_dir };
}

function mapRemoteEntry(entry: RemoteDirEntry): FileNode {
  return { name: entry.name, path: entry.path, isDir: entry.isDir };
}

export async function createFile(
  workspaceRoot: string,
  parent: string,
  name: string
): Promise<FileNode> {
  const remote = getActiveRemote();
  if (remote) {
    return mapRemoteEntry(
      await invoke<RemoteDirEntry>("ssh_create_file", {
        connId: remote.connId,
        parent,
        name,
      })
    );
  }
  return mapDirEntry(
    await invoke<RawDirEntry>("create_file", { workspaceRoot, parent, name })
  );
}

export async function sshCreateFile(
  connId: string,
  parent: string,
  name: string
): Promise<FileNode> {
  return mapRemoteEntry(
    await invoke<RemoteDirEntry>("ssh_create_file", { connId, parent, name })
  );
}

export async function createFolder(
  workspaceRoot: string,
  parent: string,
  name: string
): Promise<FileNode> {
  const remote = getActiveRemote();
  if (remote) {
    return mapRemoteEntry(
      await invoke<RemoteDirEntry>("ssh_create_folder", {
        connId: remote.connId,
        parent,
        name,
      })
    );
  }
  return mapDirEntry(
    await invoke<RawDirEntry>("create_folder", { workspaceRoot, parent, name })
  );
}

export async function sshCreateFolder(
  connId: string,
  parent: string,
  name: string
): Promise<FileNode> {
  return mapRemoteEntry(
    await invoke<RemoteDirEntry>("ssh_create_folder", { connId, parent, name })
  );
}

/** Renames `path` to `newName` in place; rejects on collision. */
export async function renamePath(
  workspaceRoot: string,
  path: string,
  newName: string
): Promise<FileNode> {
  const remote = getActiveRemote();
  if (remote) {
    return mapRemoteEntry(
      await invoke<RemoteDirEntry>("ssh_rename", {
        connId: remote.connId,
        path,
        newName,
      })
    );
  }
  return mapDirEntry(
    await invoke<RawDirEntry>("rename_path", { workspaceRoot, path, newName })
  );
}

export async function sshRenamePath(
  connId: string,
  path: string,
  newName: string
): Promise<FileNode> {
  return mapRemoteEntry(
    await invoke<RemoteDirEntry>("ssh_rename", { connId, path, newName })
  );
}

/**
 * Moves `path` to the OS recycle bin locally (recoverable). On a remote host
 * there is no recycle bin, so the deletion is permanent (SFTP recursive remove).
 */
export function deleteToTrash(workspaceRoot: string, path: string): Promise<void> {
  const remote = getActiveRemote();
  if (remote) {
    return invoke("ssh_delete", { connId: remote.connId, path });
  }
  return invoke("delete_to_trash", { workspaceRoot, path });
}

export function sshDeletePath(connId: string, path: string): Promise<void> {
  return invoke("ssh_delete", { connId, path });
}

/** Copies `src` (file/folder, recursive) into `destParent`, resolving collisions. */
export async function copyPath(
  workspaceRoot: string,
  src: string,
  destParent: string
): Promise<FileNode> {
  const remote = getActiveRemote();
  if (remote) {
    return mapRemoteEntry(
      await invoke<RemoteDirEntry>("ssh_copy", {
        connId: remote.connId,
        src,
        destParent,
      })
    );
  }
  return mapDirEntry(
    await invoke<RawDirEntry>("copy_path", { workspaceRoot, src, destParent })
  );
}

export async function sshCopyPath(
  connId: string,
  src: string,
  destParent: string
): Promise<FileNode> {
  return mapRemoteEntry(
    await invoke<RemoteDirEntry>("ssh_copy", { connId, src, destParent })
  );
}

/** Moves `src` (file/folder, recursive) into `destParent`, resolving collisions. */
export async function movePath(
  workspaceRoot: string,
  src: string,
  destParent: string
): Promise<FileNode> {
  const remote = getActiveRemote();
  if (remote) {
    return mapRemoteEntry(
      await invoke<RemoteDirEntry>("ssh_move", {
        connId: remote.connId,
        src,
        destParent,
      })
    );
  }
  return mapDirEntry(
    await invoke<RawDirEntry>("move_path", { workspaceRoot, src, destParent })
  );
}

export async function sshMovePath(
  connId: string,
  src: string,
  destParent: string
): Promise<FileNode> {
  return mapRemoteEntry(
    await invoke<RemoteDirEntry>("ssh_move", { connId, src, destParent })
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
  onEvent: (event: SearchStreamEvent) => void,
  connId?: string
): Promise<void> {
  const channel = new Channel<SearchStreamEvent>();
  channel.onmessage = onEvent;
  if (connId) {
    return invoke<void>("ssh_search", {
      connId,
      root,
      query,
      options,
      onEvent: channel,
    });
  }
  const remote = getActiveRemote();
  if (remote) {
    // Remote search runs `grep` on the host and streams the same events.
    return invoke<void>("ssh_search", {
      connId: remote.connId,
      root,
      query,
      options,
      onEvent: channel,
    });
  }
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
  // Remote search uses the host's grep (ssh_search), so no local index is needed.
  if (getActiveRemote()) return Promise.resolve();
  return invoke<void>("build_search_index", { root });
}

/** Lists every file under `root` (skipping heavy dirs) for Quick Open (Ctrl+P).
 *  Over SSH the host's `find` produces the list (no contents read). */
export function listProjectFiles(root: string, connId?: string): Promise<ProjectFile[]> {
  if (connId) {
    return invoke<ProjectFile[]>("ssh_list_project_files", {
      connId,
      root,
    });
  }
  const remote = getActiveRemote();
  if (remote)
    return invoke<ProjectFile[]>("ssh_list_project_files", {
      connId: remote.connId,
      root,
    });
  return invoke<ProjectFile[]>("list_project_files", { root });
}

/**
 * Whether `root` contains a `.sln`/`.csproj` (bounded depth). Async + off the
 * main thread on the backend (early-exit walk), so it never stalls the UI. Used
 * to warm-start the C# Roslyn on folder open.
 */
export function hasDotnetProject(root: string): Promise<boolean> {
  return invoke<boolean>("has_dotnet_project", { root });
}

/** Builds the workspace "context graph" (markdown links + code imports) for the
 *  Obsidian-style graph view. Over SSH the host enumerates + reads the files
 *  (one `find | cat` exec) and we build the graph from that stream. */
export function buildContextGraph(root: string, connId?: string): Promise<GraphData> {
  if (connId)
    return invoke<GraphData>("ssh_build_context_graph", {
      connId,
      root,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<GraphData>("ssh_build_context_graph", {
      connId: remote.connId,
      root,
    });
  return invoke<GraphData>("build_context_graph", { root });
}

/** Builds the richer knowledge index (links with line+snippet, tags, headings).
 *  The base the backlinks panel, the MCP tools and the RAG retrieval consume.
 *  Over SSH the host streams the files and we build the index from that. */
export function buildKnowledgeIndex(root: string, connId?: string): Promise<KnowledgeIndex> {
  if (connId)
    return invoke<KnowledgeIndex>("ssh_build_knowledge_index", {
      connId,
      root,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<KnowledgeIndex>("ssh_build_knowledge_index", {
      connId: remote.connId,
      root,
    });
  return invoke<KnowledgeIndex>("build_knowledge_index", { root });
}

/** Message for MCP actions while attached to a remote host. */
const REMOTE_MCP_MSG =
  "O cérebro (MCP) indexa o workspace localmente e ainda não cobre um " +
  "workspace remoto (SSH). Abra a pasta localmente para conectá-lo ao Claude Code.";

/** How to register this workspace's knowledge MCP server in an MCP client. */
export function mcpConfig(root: string): Promise<McpConfig> {
  if (getActiveRemote()) return Promise.reject(new Error(REMOTE_MCP_MSG));
  return invoke<McpConfig>("mcp_config", { root });
}

/** Writes/merges a project-scoped `.mcp.json` so Claude Code auto-detects the
 *  knowledge server. Returns the written file path. */
export function mcpWriteProjectConfig(root: string): Promise<string> {
  if (getActiveRemote()) return Promise.reject(new Error(REMOTE_MCP_MSG));
  return invoke<string>("mcp_write_project_config", { root });
}

/** Places the Snap Layouts overlay over the maximize button (CSS px, viewport
 *  coords). A zero-size rect removes it. No-op off Windows. */
export function snapSetMaxButtonRect(
  x: number,
  y: number,
  width: number,
  height: number
): Promise<void> {
  return invoke<void>("snap_set_max_button_rect", { x, y, width, height });
}

/** Assembles a markdown "context bundle" — the seed file + its graph neighbours
 *  (up to `depth` hops) — to feed an agent. */
export function buildContextBundle(
  root: string,
  path: string,
  depth = 1,
  connId?: string
): Promise<string> {
  if (connId)
    return invoke<string>("ssh_build_context_bundle", {
      connId,
      root,
      path,
      depth,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_build_context_bundle", {
      connId: remote.connId,
      root,
      path,
      depth,
    });
  return invoke<string>("build_context_bundle", { root, path, depth });
}

/** Builds a concise graph overview for agents: workspace stats, clusters, hubs
 *  and, when `path` is provided, the seed file's immediate neighbourhood. */
export function buildGraphAgentDigest(
  root: string,
  path?: string,
  connId?: string
): Promise<string> {
  if (connId)
    return invoke<string>("ssh_build_graph_agent_digest", {
      connId,
      root,
      path: path ?? null,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_build_graph_agent_digest", {
      connId: remote.connId,
      root,
      path: path ?? null,
    });
  return invoke<string>("build_graph_agent_digest", { root, path: path ?? null });
}

/** Returns the current git branch for `path`, or null if not a repo. */
export function gitBranch(path: string, connId?: string): Promise<string | null> {
  if (connId) return invoke<string | null>("ssh_git_branch", { connId, root: path });
  const remote = getActiveRemote();
  if (remote) {
    return invoke<string | null>("ssh_git_branch", { connId: remote.connId, root: path });
  }
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
export async function gitBranches(path: string, connId?: string): Promise<GitBranchInfo[]> {
  const remote = getActiveRemote();
  const raw = connId
    ? await invoke<RawGitBranchInfo[]>("ssh_git_branches", { connId, root: path })
    : remote
    ? await invoke<RawGitBranchInfo[]>("ssh_git_branches", { connId: remote.connId, root: path })
    : await invoke<RawGitBranchInfo[]>("git_branches", { path });
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

export async function gitRemoteBranches(path: string, connId?: string): Promise<GitBranchInfo[]> {
  const remote = getActiveRemote();
  const raw = connId
    ? await invoke<RawGitBranchInfo[]>("ssh_git_remote_branches", { connId, root: path })
    : remote
    ? await invoke<RawGitBranchInfo[]>("ssh_git_remote_branches", { connId: remote.connId, root: path })
    : await invoke<RawGitBranchInfo[]>("git_remote_branches", { path });
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

export function gitRemotes(path: string, connId?: string): Promise<GitRemoteInfo[]> {
  if (connId) return invoke<GitRemoteInfo[]>("ssh_git_remotes", { connId, root: path });
  const remote = getActiveRemote();
  if (remote) return invoke<GitRemoteInfo[]>("ssh_git_remotes", { connId: remote.connId, root: path });
  return invoke<GitRemoteInfo[]>("git_remotes", { path });
}

/** Adds a remote to a Git repository. */
export function gitRemoteAdd(path: string, name: string, url: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_remote_add", { connId, root: path, name, url });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_remote_add", { connId: remote.connId, root: path, name, url });
  return invoke("git_remote_add", { path, name, url });
}

/** Removes a remote from a Git repository. */
export function gitRemoteRemove(path: string, name: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_remote_remove", { connId, root: path, name });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_remote_remove", { connId: remote.connId, root: path, name });
  return invoke("git_remote_remove", { path, name });
}

/** Renames a Git remote. */
export function gitRemoteRename(
  path: string,
  oldName: string,
  newName: string,
  connId?: string
): Promise<void> {
  if (connId) return invoke("ssh_git_remote_rename", { connId, root: path, oldName, newName });
  const remote = getActiveRemote();
  if (remote) {
    return invoke("ssh_git_remote_rename", {
      connId: remote.connId,
      root: path,
      oldName,
      newName,
    });
  }
  return invoke("git_remote_rename", { path, oldName, newName });
}

/** Updates a Git remote fetch URL. */
export function gitRemoteSetUrl(path: string, name: string, url: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_remote_set_url", { connId, root: path, name, url });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_remote_set_url", { connId: remote.connId, root: path, name, url });
  return invoke("git_remote_set_url", { path, name, url });
}

/** Checks out an existing local branch. Rejects with git's message on failure. */
export function gitCheckout(path: string, branch: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_checkout", { connId, root: path, branch });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_checkout", { connId: remote.connId, root: path, branch });
  return invoke("git_checkout", { path, branch });
}

/** Creates a new branch from HEAD and checks it out (`git checkout -b`). */
export function gitCreateBranch(path: string, name: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_create_branch", { connId, root: path, name });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_create_branch", { connId: remote.connId, root: path, name });
  return invoke("git_create_branch", { path, name });
}

/** Renames a local branch. */
export function gitRenameBranch(
  path: string,
  oldName: string,
  newName: string,
  connId?: string
): Promise<void> {
  if (connId) return invoke("ssh_git_rename_branch", { connId, root: path, oldName, newName });
  const remote = getActiveRemote();
  if (remote) {
    return invoke("ssh_git_rename_branch", {
      connId: remote.connId,
      root: path,
      oldName,
      newName,
    });
  }
  return invoke("git_rename_branch", { path, oldName, newName });
}

/** Deletes a local branch. Uses a force delete when requested. */
export function gitDeleteBranch(
  path: string,
  name: string,
  force = false,
  connId?: string
): Promise<void> {
  if (connId) return invoke("ssh_git_delete_branch", { connId, root: path, name, force });
  const remote = getActiveRemote();
  if (remote) {
    return invoke("ssh_git_delete_branch", {
      connId: remote.connId,
      root: path,
      name,
      force,
    });
  }
  return invoke("git_delete_branch", { path, name, force });
}

/** Deletes a branch from a remote via `git push <remote> --delete <branch>`. */
export function gitDeleteRemoteBranch(
  path: string,
  remoteName: string,
  branchName: string,
  connId?: string
): Promise<string> {
  if (connId) {
    return invoke<string>("ssh_git_delete_remote_branch", {
      connId,
      root: path,
      remote: remoteName,
      branch: branchName,
    });
  }
  const remote = getActiveRemote();
  if (remote) {
    return invoke<string>("ssh_git_delete_remote_branch", {
      connId: remote.connId,
      root: path,
      remote: remoteName,
      branch: branchName,
    });
  }
  return invoke<string>("git_delete_remote_branch", {
    path,
    remote: remoteName,
    branch: branchName,
  });
}

/** Creates a local branch that tracks a remote branch, then checks it out. */
export function gitCheckoutRemoteBranch(
  path: string,
  remoteBranch: string,
  localName: string,
  connId?: string
): Promise<void> {
  if (connId) {
    return invoke("ssh_git_checkout_remote_branch", {
      connId,
      root: path,
      remoteBranch,
      localName,
    });
  }
  const remote = getActiveRemote();
  if (remote) {
    return invoke("ssh_git_checkout_remote_branch", {
      connId: remote.connId,
      root: path,
      remoteBranch,
      localName,
    });
  }
  return invoke("git_checkout_remote_branch", { path, remoteBranch, localName });
}

/** Working-tree status: branch, ahead/behind, and changed files. */
export async function gitStatus(path: string, connId?: string): Promise<GitStatus> {
  const remote = getActiveRemote();
  const raw = connId
    ? await invoke<RawGitStatus>("ssh_git_status", { connId, root: path })
    : remote
    ? await invoke<RawGitStatus>("ssh_git_status", { connId: remote.connId, root: path })
    : await invoke<RawGitStatus>("git_status", { path });
  return {
    branch: raw.branch,
    ahead: raw.ahead,
    behind: raw.behind,
    isRepo: raw.is_repo,
    hasUpstream: raw.has_upstream,
    conflicted: raw.conflicted ?? 0,
    files: raw.files,
  };
}

/** Linked local worktrees for the repo containing `path`. */
export function gitWorktrees(path: string, connId?: string): Promise<GitWorktreeInfo[]> {
  if (connId) return invoke<GitWorktreeInfo[]>("ssh_git_worktrees", { connId, root: path });
  const remote = getActiveRemote();
  if (remote) return invoke<GitWorktreeInfo[]>("ssh_git_worktrees", { connId: remote.connId, root: path });
  return invoke<GitWorktreeInfo[]>("git_worktrees", { path });
}

export function gitWorktreeAdd(
  path: string,
  target: string,
  branchOrRef?: string,
  createBranch = false,
  connId?: string,
): Promise<void> {
  const branch_or_ref = branchOrRef?.trim() || null;
  if (connId) {
    return invoke("ssh_git_worktree_add", {
      connId,
      root: path,
      target,
      branchOrRef: branch_or_ref,
      createBranch,
    });
  }
  const remote = getActiveRemote();
  if (remote) {
    return invoke("ssh_git_worktree_add", {
      connId: remote.connId,
      root: path,
      target,
      branchOrRef: branch_or_ref,
      createBranch,
    });
  }
  return invoke("git_worktree_add", {
    path,
    target,
    branchOrRef: branch_or_ref,
    createBranch,
  });
}

export function gitWorktreeRemove(
  path: string,
  worktreePath: string,
  force = false,
  connId?: string,
): Promise<void> {
  if (connId) {
    return invoke("ssh_git_worktree_remove", { connId, root: path, worktreePath, force });
  }
  const remote = getActiveRemote();
  if (remote) {
    return invoke("ssh_git_worktree_remove", {
      connId: remote.connId,
      root: path,
      worktreePath,
      force,
    });
  }
  return invoke("git_worktree_remove", { path, worktreePath, force });
}

export function gitWorktreePrune(path: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_worktree_prune", { connId, root: path });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_worktree_prune", { connId: remote.connId, root: path });
  return invoke("git_worktree_prune", { path });
}

export function gitStage(path: string, file: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_stage", { connId, root: path, file });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_stage", { connId: remote.connId, root: path, file });
  return invoke("git_stage", { path, file });
}
export function gitUnstage(path: string, file: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_unstage", { connId, root: path, file });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_unstage", { connId: remote.connId, root: path, file });
  return invoke("git_unstage", { path, file });
}
export function gitUnstageAll(path: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_unstage_all", { connId, root: path });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_unstage_all", { connId: remote.connId, root: path });
  return invoke("git_unstage_all", { path });
}
export function gitStageAll(path: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_stage_all", { connId, root: path });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_stage_all", { connId: remote.connId, root: path });
  return invoke("git_stage_all", { path });
}
export function gitCommit(path: string, message: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_commit", { connId, root: path, message });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_commit", { connId: remote.connId, root: path, message });
  return invoke("git_commit", { path, message });
}
export function gitFetch(path: string, connId?: string): Promise<void> {
  if (connId) return invoke<string>("ssh_git_fetch", { connId, root: path }).then(() => {});
  const remote = getActiveRemote();
  if (remote) {
    return invoke<string>("ssh_git_fetch", { connId: remote.connId, root: path }).then(() => {});
  }
  return invoke("git_fetch", { path });
}

export function gitFetchRemote(path: string, remoteName: string, connId?: string): Promise<void> {
  if (connId) {
    return invoke<string>("ssh_git_fetch_remote", { connId, root: path, remote: remoteName }).then(
      () => {}
    );
  }
  const remote = getActiveRemote();
  if (remote) {
    return invoke<string>("ssh_git_fetch_remote", {
      connId: remote.connId,
      root: path,
      remote: remoteName,
    }).then(() => {});
  }
  return invoke("git_fetch_remote", { path, remote: remoteName });
}

export function gitPull(path: string, connId?: string): Promise<string> {
  if (connId) return invoke<string>("ssh_git_pull", { connId, root: path });
  const remote = getActiveRemote();
  if (remote) return invoke<string>("ssh_git_pull", { connId: remote.connId, root: path });
  return invoke<string>("git_pull", { path });
}
export function gitPush(path: string, connId?: string): Promise<string> {
  if (connId) return invoke<string>("ssh_git_push", { connId, root: path });
  const remote = getActiveRemote();
  if (remote) return invoke<string>("ssh_git_push", { connId: remote.connId, root: path });
  return invoke<string>("git_push", { path });
}
/** Publishes a branch with no upstream (`git push -u <remote> <branch>`). Over
 *  SSH this falls back to a plain push (no `-u` wiring there yet). */
export function gitPublish(path: string, connId?: string): Promise<string> {
  if (connId) return invoke<string>("ssh_git_push", { connId, root: path });
  const remote = getActiveRemote();
  if (remote) return invoke<string>("ssh_git_push", { connId: remote.connId, root: path });
  return invoke<string>("git_publish", { path });
}
/** Discards a file's changes (reverts to HEAD; deletes if untracked). */
export function gitDiscardFile(
  path: string,
  file: string,
  untracked: boolean,
  connId?: string
): Promise<void> {
  if (connId) return invoke("ssh_git_discard_file", { connId, root: path, file, untracked });
  const remote = getActiveRemote();
  if (remote)
    return invoke("ssh_git_discard_file", { connId: remote.connId, root: path, file, untracked });
  return invoke("git_discard_file", { path, file, untracked });
}
/** Discards ALL working-tree changes (revert tracked + remove untracked). */
export function gitDiscardAll(path: string, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_discard_all", { connId, root: path });
  const remote = getActiveRemote();
  if (remote) return invoke("ssh_git_discard_all", { connId: remote.connId, root: path });
  return invoke("git_discard_all", { path });
}
/** Stashes the working tree (incl. untracked), with an optional message. */
export function gitStashPush(path: string, message?: string, connId?: string): Promise<string> {
  if (connId)
    return invoke<string>("ssh_git_stash_push", {
      connId,
      root: path,
      message: message ?? null,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_git_stash_push", {
      connId: remote.connId,
      root: path,
      message: message ?? null,
    });
  return invoke<string>("git_stash_push", { path, message: message ?? null });
}
/** Lists the stash entries (newest first). */
export function gitStashList(path: string, connId?: string): Promise<GitStashEntry[]> {
  if (connId) return invoke<GitStashEntry[]>("ssh_git_stash_list", { connId, root: path });
  const remote = getActiveRemote();
  if (remote)
    return invoke<GitStashEntry[]>("ssh_git_stash_list", { connId: remote.connId, root: path });
  return invoke<GitStashEntry[]>("git_stash_list", { path });
}
/** Lists files contained in a stash entry without applying it. */
export function gitStashFiles(path: string, index: number, connId?: string): Promise<GitStashFile[]> {
  if (connId) return invoke<GitStashFile[]>("ssh_git_stash_files", { connId, root: path, index });
  const remote = getActiveRemote();
  if (remote) {
    return invoke<GitStashFile[]>("ssh_git_stash_files", {
      connId: remote.connId,
      root: path,
      index,
    });
  }
  return invoke<GitStashFile[]>("git_stash_files", { path, index });
}
export function gitStashApply(path: string, index: number, connId?: string): Promise<string> {
  if (connId) return invoke<string>("ssh_git_stash_apply", { connId, root: path, index });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_git_stash_apply", { connId: remote.connId, root: path, index });
  return invoke<string>("git_stash_apply", { path, index });
}
export function gitStashPop(path: string, index: number, connId?: string): Promise<string> {
  if (connId) return invoke<string>("ssh_git_stash_pop", { connId, root: path, index });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_git_stash_pop", { connId: remote.connId, root: path, index });
  return invoke<string>("git_stash_pop", { path, index });
}
export function gitStashDrop(path: string, index: number, connId?: string): Promise<void> {
  if (connId) return invoke("ssh_git_stash_drop", { connId, root: path, index });
  const remote = getActiveRemote();
  if (remote)
    return invoke("ssh_git_stash_drop", { connId: remote.connId, root: path, index });
  return invoke("git_stash_drop", { path, index });
}

export function gitRevertCommit(path: string, commit: string, connId?: string): Promise<string> {
  if (connId) return invoke<string>("ssh_git_revert_commit", { connId, root: path, commit });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_git_revert_commit", { connId: remote.connId, root: path, commit });
  return invoke<string>("git_revert_commit", { path, commit });
}

export function gitUndoLastCommit(path: string, connId?: string): Promise<string> {
  if (connId) return invoke<string>("ssh_git_undo_last_commit", { connId, root: path });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_git_undo_last_commit", { connId: remote.connId, root: path });
  return invoke<string>("git_undo_last_commit", { path });
}

export function gitLog(path: string, limit = 30, connId?: string): Promise<GitCommit[]> {
  if (connId) return invoke<GitCommit[]>("ssh_git_log", { connId, root: path, limit });
  const remote = getActiveRemote();
  if (remote)
    return invoke<GitCommit[]>("ssh_git_log", { connId: remote.connId, root: path, limit });
  return invoke<GitCommit[]>("git_log", { path, limit });
}

export function gitGraph(path: string, limit = 60, connId?: string): Promise<GitGraphCommit[]> {
  if (connId) return invoke<GitGraphCommit[]>("ssh_git_graph", { connId, root: path, limit });
  const remote = getActiveRemote();
  if (remote)
    return invoke<GitGraphCommit[]>("ssh_git_graph", { connId: remote.connId, root: path, limit });
  return invoke<GitGraphCommit[]>("git_graph", { path, limit });
}

export function gitCompareUpstream(
  path: string,
  limit = 40,
  connId?: string
): Promise<GitUpstreamComparison> {
  if (connId) return invoke<GitUpstreamComparison>("ssh_git_compare_upstream", { connId, root: path, limit });
  const remote = getActiveRemote();
  if (remote)
    return invoke<GitUpstreamComparison>("ssh_git_compare_upstream", {
      connId: remote.connId,
      root: path,
      limit,
    });
  return invoke<GitUpstreamComparison>("git_compare_upstream", { path, limit });
}

/**
 * History of a single file (ISSUE-71 · File History): commits that touched
 * `file`, newest first, following renames. `file` may be absolute or relative
 * to the repo at `path`.
 */
export function gitLogFile(
  path: string,
  file: string,
  limit = 50,
  connId?: string
): Promise<GitCommit[]> {
  if (connId)
    return invoke<GitCommit[]>("ssh_git_log_file", {
      connId,
      root: path,
      file,
      limit,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<GitCommit[]>("ssh_git_log_file", {
      connId: remote.connId,
      root: path,
      file,
      limit,
    });
  return invoke<GitCommit[]>("git_log_file", { path, file, limit });
}

/**
 * Git Fluent Line History: commits that changed the selected line, newest
 * first. Remote workspaces temporarily fall back to file history until the SSH
 * bridge gets its own `git log -L` command.
 */
export function gitLogLine(
  path: string,
  file: string,
  line: number,
  limit = 50,
  connId?: string
): Promise<GitCommit[]> {
  if (connId)
    return invoke<GitCommit[]>("ssh_git_log_file", {
      connId,
      root: path,
      file,
      limit,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<GitCommit[]>("ssh_git_log_file", {
      connId: remote.connId,
      root: path,
      file,
      limit,
    });
  return invoke<GitCommit[]>("git_log_line", { path, file, line, limit });
}

/** Reads a file as it existed at a specific commit/revision. */
export function gitShowFileAtCommit(
  path: string,
  file: string,
  commit: string,
  connId?: string
): Promise<string> {
  if (connId)
    return invoke<string>("ssh_git_show_file_at_commit", {
      connId,
      root: path,
      file,
      commit,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_git_show_file_at_commit", {
      connId: remote.connId,
      root: path,
      file,
      commit,
    });
  return invoke<string>("git_show_file_at_commit", { path, file, commit });
}

export type GitRevisionDiffTarget = "previous" | "working";
export type GitChangeView = "working" | "staged";

/** Returns a unified patch for a Git Fluent file revision. */
export function gitDiffFileRevision(
  path: string,
  file: string,
  commit: string,
  compareTo: GitRevisionDiffTarget,
  connId?: string
): Promise<string> {
  if (connId)
    return invoke<string>("ssh_git_diff_file_revision", {
      connId,
      root: path,
      file,
      commit,
      compareTo,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_git_diff_file_revision", {
      connId: remote.connId,
      root: path,
      file,
      commit,
      compareTo,
    });
  return invoke<string>("git_diff_file_revision", {
    path,
    file,
    commit,
    compareTo,
  });
}

/** Returns the working-tree patch for a tracked file versus HEAD. */
export function gitDiffFile(path: string, file: string, connId?: string): Promise<string> {
  if (connId)
    return invoke<string>("ssh_git_diff_file", {
      connId,
      root: path,
      file,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_git_diff_file", {
      connId: remote.connId,
      root: path,
      file,
    });
  return invoke<string>("git_diff_file", { path, file });
}

/** Returns the staged/index patch for a file versus HEAD. */
export function gitDiffFileStaged(path: string, file: string, connId?: string): Promise<string> {
  if (connId)
    return invoke<string>("ssh_git_diff_file_staged", {
      connId,
      root: path,
      file,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_git_diff_file_staged", {
      connId: remote.connId,
      root: path,
      file,
    });
  return invoke<string>("git_diff_file_staged", { path, file });
}

/** Returns the file contents currently staged in the Git index. */
export function gitShowFileStaged(path: string, file: string, connId?: string): Promise<string> {
  if (connId)
    return invoke<string>("ssh_git_show_file_staged", {
      connId,
      root: path,
      file,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<string>("ssh_git_show_file_staged", {
      connId: remote.connId,
      root: path,
      file,
    });
  return invoke<string>("git_show_file_staged", { path, file });
}

/** Lists files changed by a commit for the Git Fluent Commit Details card. */
export function gitCommitFiles(
  path: string,
  commit: string,
  connId?: string
): Promise<GitCommitFile[]> {
  if (connId)
    return invoke<GitCommitFile[]>("ssh_git_commit_files", {
      connId,
      root: path,
      commit,
    });
  const remote = getActiveRemote();
  if (remote)
    return invoke<GitCommitFile[]>("ssh_git_commit_files", {
      connId: remote.connId,
      root: path,
      commit,
    });
  return invoke<GitCommitFile[]>("git_commit_files", { path, commit });
}

/** Returns per-line blame info for `file` inside the repo at `root`. */
export function gitBlame(root: string, file: string, connId?: string): Promise<BlameHunk[]> {
  if (connId)
    return invoke<BlameHunk[]>("ssh_git_blame", { connId, root, file });
  const remote = getActiveRemote();
  if (remote)
    return invoke<BlameHunk[]>("ssh_git_blame", { connId: remote.connId, root, file });
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

// Terminals created while a remote session is attached are PTYs on the host;
// their subsequent write/resize/close calls must route to the SSH commands. The
// id is what we have at write/resize/close time, so remember which ids are remote.
const remoteTerminals = new Set<string>();

export function termCreate(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  command?: string | null,
  connId?: string
): Promise<void> {
  if (connId) {
    remoteTerminals.add(id);
    return invoke<void>("ssh_term_create", {
      connId,
      id,
      cwd,
      cols,
      rows,
    }).catch((error) => {
      remoteTerminals.delete(id);
      throw error;
    });
  }
  const remote = getActiveRemote();
  if (remote) {
    remoteTerminals.add(id);
    return invoke<void>("ssh_term_create", {
      connId: remote.connId,
      id,
      cwd,
      cols,
      rows,
    }).catch((error) => {
      remoteTerminals.delete(id);
      throw error;
    });
  }
  return invoke("term_create", { id, cwd, cols, rows, command: command ?? null });
}
export function termWrite(id: string, data: string): Promise<void> {
  if (remoteTerminals.has(id)) return invoke("ssh_term_write", { id, data });
  return invoke("term_write", { id, data });
}
export function termResize(id: string, cols: number, rows: number): Promise<void> {
  if (remoteTerminals.has(id)) return invoke("ssh_term_resize", { id, cols, rows });
  return invoke("term_resize", { id, cols, rows });
}
export function termClose(id: string): Promise<void> {
  if (remoteTerminals.has(id)) {
    remoteTerminals.delete(id);
    return invoke("ssh_term_close", { id });
  }
  return invoke("term_close", { id });
}

/**
 * Forgets all remote terminal ids (called on disconnect; the backend already
 * aborts the underlying channels when the connection drops).
 */
export function clearRemoteTerminals(): void {
  remoteTerminals.clear();
}

// ---- Run / Debug configurations ----

/** Loads saved run configs from `.project/run.json` (empty if none yet). */
export function runConfigsLoad(root: string, connId?: string): Promise<RunConfig[]> {
  if (connId)
    return invoke<RunConfig[]>("ssh_run_configs_load", { connId, root });
  const remote = getActiveRemote();
  if (remote)
    return invoke<RunConfig[]>("ssh_run_configs_load", { connId: remote.connId, root });
  return invoke<RunConfig[]>("run_configs_load", { root });
}
/** Persists run configs to `.project/run.json`. */
export function runConfigsSave(
  root: string,
  configs: RunConfig[],
  connId?: string
): Promise<void> {
  if (connId)
    return invoke("ssh_run_configs_save", { connId, root, configs });
  const remote = getActiveRemote();
  if (remote)
    return invoke("ssh_run_configs_save", { connId: remote.connId, root, configs });
  return invoke("run_configs_save", { root, configs });
}
/** Suggests run configs by inspecting package.json scripts, Cargo.toml, etc. */
export function runConfigsDetect(root: string, connId?: string): Promise<RunConfig[]> {
  if (connId)
    return invoke<RunConfig[]>("ssh_run_configs_detect", { connId, root });
  const remote = getActiveRemote();
  if (remote)
    return invoke<RunConfig[]>("ssh_run_configs_detect", { connId: remote.connId, root });
  return invoke<RunConfig[]>("run_configs_detect", { root });
}

// ---- Local CLI agents ----

/** Loads agents and conversation history from `<root>/.project/agents.json`. */
export function agentsLoad(root: string): Promise<AgentStore> {
  const remote = getActiveRemote();
  if (remote)
    return invoke<AgentStore>("ssh_agents_load", { connId: remote.connId, root });
  return invoke<AgentStore>("agents_load", { root });
}

/** Persists agents and conversation history inside the current workspace. */
export function agentsSave(root: string, store: AgentStore): Promise<void> {
  const remote = getActiveRemote();
  if (remote)
    return invoke("ssh_agents_save", { connId: remote.connId, root, store });
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
  model: string,
  nativeSessionId: string | null,
  onEvent: (event: AcpEvent) => void,
): Promise<void> {
  if (getActiveRemote())
    return Promise.reject(
      new Error(
        "O modo agente roda localmente e ainda não opera num workspace remoto (SSH). " +
          "Abra a pasta localmente para usar os agentes."
      )
    );
  const channel = new Channel<AcpEvent>();
  channel.onmessage = onEvent;
  return invoke("acp_prompt", {
    provider,
    workspaceRoot,
    conversationId,
    contextPrompt,
    prompt,
    mode,
    model,
    nativeSessionId,
    onEvent: channel,
  });
}

/** Pré-aquece o processo do provedor para o workspace (o boot sai do caminho
 *  do primeiro envio). Fire-and-forget; no-op sobre SSH. */
export function acpWarm(
  provider: "codex" | "claude",
  workspaceRoot: string,
): Promise<void> {
  if (getActiveRemote()) return Promise.resolve();
  return invoke("acp_warm", { provider, workspaceRoot });
}

/** Interrupts the in-flight turn while preserving any streamed response. */
export function acpCancel(): Promise<void> {
  return invoke("acp_cancel");
}

/** Stops cached provider processes and sessions associated with a workspace.
 *  No-op over SSH (the agent never started — it runs locally only). */
export function acpStopWorkspace(workspaceRoot: string): Promise<void> {
  if (getActiveRemote()) return Promise.resolve();
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
    layout: s.layout ?? null,
    workspace: s.workspace ?? null,
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
  activePath: string | null,
  layout?: string | null
): Promise<void> {
  return invoke("session_set_open_files", { tabs, activePath, layout: layout ?? null });
}

/** Persists or clears the current workspace shell, including unsaved workspaces. */
export function sessionSetWorkspace(workspace: Session["workspace"]): Promise<void> {
  return invoke("session_set_workspace", { workspace: workspace ?? null });
}

// ---- Windows ----

/** Opens a workbench window in the already-warm app process. */
export function openNewWindow(remoteAttach?: string, localAttach?: string): Promise<void> {
  return invoke("open_new_window", {
    remoteAttach: remoteAttach ?? null,
    localAttach: localAttach ?? null,
  });
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

const runtimeWindowLabel = getCurrentWindow().label;
const runtimeLspId = (id: string) => `${runtimeWindowLabel}:${id}`;

/** `{ program, args }` resolved by `lsp_ensure_ts_server` (TS/JS). */
export interface LspLaunchInfo {
  program: string;
  args: string[];
  /** TS only: the `tsserver.js` path, forwarded via `initializationOptions`. */
  tsserverPath?: string;
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
  return invoke<LspBridgeInfo>("lsp_start_server", {
    id: runtimeLspId(id),
    program,
    args,
    cwd,
  });
}

// LSP servers started on the remote host (their stop must route to ssh_lsp_stop).
const remoteLspServers = new Set<string>();

/** Stops the LSP server with the given id, routing to the host bridge if remote. */
export function stopLspServer(id: string): Promise<void> {
  if (remoteLspServers.has(id)) {
    remoteLspServers.delete(id);
    return invoke("ssh_lsp_stop", { id: runtimeLspId(id) });
  }
  return invoke("lsp_stop_server", { id: runtimeLspId(id) });
}

// ── DAP (debugger) bridge — roadmap csharp-ide-parity, Fase B ────────────────

/** Downloads/locates netcoredbg; returns the executable path. */
export function dapEnsureNetcoredbg(): Promise<string> {
  return invoke<string>("dap_ensure_netcoredbg");
}

/** Spawns a debug adapter and its WS bridge; same shape as the LSP bridge. */
export function dapStartSession(
  id: string,
  program: string,
  args: string[],
  cwd: string
): Promise<LspBridgeInfo> {
  return invoke<LspBridgeInfo>("dap_start_session", {
    id: runtimeLspId(id),
    program,
    args,
    cwd,
  });
}

/** Stops a debug session (bridge kills the adapter process). */
export function dapStopSession(id: string): Promise<void> {
  return invoke("dap_stop_session", { id: runtimeLspId(id) });
}

/** A running .NET process candidate for attach. */
export interface DotnetProcess {
  pid: number;
  name: string;
}

/** Lists running dotnet processes (attach picker). Best-effort. */
export function dapListDotnetProcesses(): Promise<DotnetProcess[]> {
  return invoke<DotnetProcess[]>("dap_list_dotnet_processes");
}

/** Builds the csproj and returns its output DLL (TargetPath) for launch. */
export function dapResolveDotnetTarget(csprojPath: string): Promise<string> {
  return invoke<string>("dap_resolve_dotnet_target", { csprojPath });
}

// ── .NET test runner — roadmap csharp-ide-parity, Fase C ─────────────────────

/** One test outcome from a TRX run. */
export interface DotnetTestResult {
  name: string;
  /** `Passed` | `Failed` | `NotExecuted` (TRX vocabulary). */
  outcome: string;
  durationMs: number | null;
  message: string | null;
}

export interface DotnetTestRun {
  results: DotnetTestResult[];
  outputTail: string;
}

/** Lists fully-qualified test names (builds the project as a side effect). */
export function dotnetTestList(csprojPath: string): Promise<string[]> {
  return invoke<string[]>("dotnet_test_list", { csprojPath });
}

/** Runs all tests (or only `filter` = one FullyQualifiedName). */
export function dotnetTestRun(
  csprojPath: string,
  filter?: string
): Promise<DotnetTestRun> {
  return invoke<DotnetTestRun>("dotnet_test_run", { csprojPath, filter: filter ?? null });
}

/**
 * Starts a language server ON THE REMOTE host (issue #8, Phase 6) and bridges its
 * stdio to a local WebSocket — returns the same `{ port, token }` as
 * {@link startLspServer}, so monaco connects identically. `command` is the full
 * shell command to run on the host (the binary must already exist there).
 */
export function sshLspStart(
  connId: string,
  id: string,
  command: string,
  cwd: string
): Promise<LspBridgeInfo> {
  remoteLspServers.add(id);
  return invoke<LspBridgeInfo>("ssh_lsp_start", {
    connId,
    id: runtimeLspId(id),
    command,
    cwd,
  }).catch((error) => {
    remoteLspServers.delete(id);
    throw error;
  });
}

/** Forgets all remote LSP server ids (called on disconnect). */
export function clearRemoteLspServers(): void {
  remoteLspServers.clear();
}

/** Returns the bridge `{ port, token }` for an active session (reconnect). */
export function lspBridgeInfo(id: string): Promise<LspBridgeInfo> {
  return invoke<LspBridgeInfo>("lsp_bridge_info", { id: runtimeLspId(id) });
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

/** Project + editor-managed TypeScript versions (for the version picker). */
export interface TsVersions {
  project: string | null;
  editor: string | null;
}

/** Reads the TypeScript versions available to a project (own + editor-managed). */
export function tsVersions(rootPath: string): Promise<TsVersions> {
  return invoke<TsVersions>("lsp_ts_versions", { rootPath });
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

// ── Razor projection broker (ADR 0002) ────────────────────────────────────────

/** One materialized projection: the `.cshtml` plus the projected `.g.cs`. */
export interface RazorProjectionInfo {
  /** `.cshtml` path relative to the user project (as requested). */
  cshtmlRel: string;
  /** Absolute `.cshtml` path — the exact key the `razorRemap*` commands use. */
  cshtmlPath: string;
  /** Absolute path to the projected C# inside the shadow (Roslyn opens this). */
  generatedPath: string;
}

/** Summary returned by {@link razorPrepare}. */
export interface RazorPrepareResult {
  /** Directory of the generated shadow project. */
  shadowDir: string;
  /** Solution (user + shadow) to open in the Roslyn client. */
  solutionPath: string;
  /** `.cshtml` that got a usable projection (with its projected `.g.cs` path). */
  available: RazorProjectionInfo[];
  /** `.cshtml` (relative) requested but with no projection (degraded). */
  missing: string[];
  /**
   * Derived reference DLLs missing on disk (ProjectReferences never built).
   * Semantics degrade for their types — surface honestly instead of letting
   * Roslyn report false "type does not exist" errors.
   */
  missingReferences: string[];
}

/** A remapped 0-based LSP position. */
export interface RazorRemapPos {
  line: number;
  character: number;
}

/** A 0-based LSP range on the batch-remap wire (camelCase of Rust RemapRange). */
export interface RazorRemapRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
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

/**
 * Remap N projected-C# ranges back to the `.cshtml` in ONE IPC round-trip.
 * Entry `i` of the result matches entry `i` of `ranges`; `null` = unmappable
 * (synthetic C#). Diagnostics-grade mapping: spans crossing `#line` regions come
 * back truncated at the region end rather than dropped.
 */
export function razorRemapRangesToSource(
  cshtmlPath: string,
  ranges: RazorRemapRange[]
): Promise<(RazorRemapRange | null)[]> {
  return invoke<(RazorRemapRange | null)[]>("razor_remap_ranges_to_source", {
    cshtmlPath,
    ranges,
  });
}

/**
 * STRICT batch remap — for `TextEdit` ranges (code actions/quick fixes): a
 * range not fully inside one mapped region comes back `null` and the caller
 * must drop the whole action (an approximated edit span would corrupt code).
 */
export function razorRemapRangesToSourceStrict(
  cshtmlPath: string,
  ranges: RazorRemapRange[]
): Promise<(RazorRemapRange | null)[]> {
  return invoke<(RazorRemapRange | null)[]>("razor_remap_ranges_to_source_strict", {
    cshtmlPath,
    ranges,
  });
}

/** Drop a `.cshtml`'s cached source map (on close). */
export function razorForget(cshtmlPath: string): Promise<void> {
  return invoke<void>("razor_forget", { cshtmlPath });
}

/** Append a line to the shared Razor/C# pipeline diagnostic log
 * (`<app_data_dir>/razor-diag.log`), so the frontend LSP chain lands in the
 * same ordered trace as the backend broker steps. Best-effort fire-and-forget. */
export function razorDiagLog(line: string): Promise<void> {
  return invoke<void>("razor_diag_log", { line });
}

/** Result of a live emit (per-keystroke projection via the sidecar). */
export interface RazorEmitLiveResult {
  /** The fresh projected C# — feed straight into Roslyn (didOpen). */
  generatedText: string;
  /** Generation this was applied under (drop stale out-of-order responses). */
  generation: number;
  /** False when the live path is unavailable — caller falls back to reprepare. */
  ok: boolean;
  error?: string;
}

/**
 * Live re-emit of a `.cshtml`'s projection from in-memory `text` via the sidecar
 * (~ms, no `dotnet build`). Reparses the `#line` map and PARKS it as pending under
 * `generation`. The caller must, after syncing Roslyn with `generatedText`, call
 * {@link razorCommitLiveMap} to promote that map to active — so remapping never
 * runs ahead of the `.g.cs` Roslyn has open. `ok:false` ⇒ fall back to reprepare.
 */
export function razorEmitLive(cshtmlPath: string, text: string): Promise<RazorEmitLiveResult> {
  return invoke<RazorEmitLiveResult>("razor_emit_live", { cshtmlPath, text });
}

/**
 * Promote the pending live map for `cshtmlPath` (from {@link razorEmitLive}) to
 * active, once Roslyn has the matching `generation`'s `.g.cs` open. No-op if a
 * newer emit superseded it. Returns true if committed.
 */
export function razorCommitLiveMap(cshtmlPath: string, generation: number): Promise<boolean> {
  return invoke<boolean>("razor_commit_live_map", { cshtmlPath, generation });
}

/** Warm the live sidecar for `cshtmlPath` so the first keystroke is fast. */
export function razorWarm(cshtmlPath: string): Promise<void> {
  return invoke<void>("razor_warm", { cshtmlPath });
}

/** Build the live sidecar binary on first use. Returns false on soft-fail. */
export function razorEnsureSidecar(): Promise<boolean> {
  return invoke<boolean>("razor_ensure_sidecar");
}
