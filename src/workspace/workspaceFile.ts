export const FLUENT_WORKSPACE_VERSION = 1;
export const FLUENT_WORKSPACE_EXTENSION = ".fluent-workspace";

export type WorkspaceProvider = "local" | "ssh";

export interface SshWorkspaceAuthority {
  type: "ssh";
  host: string;
  user: string;
  port?: number;
  keyPath?: string;
}

export interface FluentWorkspaceFolderInput {
  id?: string;
  name?: string;
  path: string;
  remote?: SshWorkspaceAuthority;
}

export interface FluentWorkspaceFile {
  fluentWorkspace: 1;
  name?: string;
  folders: FluentWorkspaceFolderInput[];
  git?: {
    mode?: "perFolder";
  };
  settings?: Record<string, unknown>;
}

export interface WorkspaceFolder {
  id: string;
  name: string;
  path: string;
  provider: WorkspaceProvider;
  remote?: SshWorkspaceAuthority;
}

export interface NormalizedWorkspace {
  version: 1;
  name: string;
  folders: WorkspaceFolder[];
  gitMode: "perFolder";
  settings: Record<string, unknown>;
}

interface CodeWorkspaceFolder {
  name?: string;
  path?: string;
  uri?: string;
}

interface CodeWorkspaceFile {
  folders?: CodeWorkspaceFolder[];
  settings?: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return normalized.slice(slash + 1) || normalized || "Workspace";
}

function workspaceNameFromFilePath(path: string | null | undefined): string {
  if (!path) return "Workspace";
  const name = baseName(path);
  return name.endsWith(FLUENT_WORKSPACE_EXTENSION)
    ? name.slice(0, -FLUENT_WORKSPACE_EXTENSION.length) || "Workspace"
    : name;
}

function normalizeSshAuthority(value: unknown, index: number): SshWorkspaceAuthority | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`folders[${index}].remote deve ser um objeto.`);
  if (value.type !== "ssh") throw new Error(`folders[${index}].remote.type deve ser "ssh".`);
  if (typeof value.host !== "string" || value.host.trim() === "") {
    throw new Error(`folders[${index}].remote.host e obrigatorio.`);
  }
  if (typeof value.user !== "string" || value.user.trim() === "") {
    throw new Error(`folders[${index}].remote.user e obrigatorio.`);
  }
  if (
    value.port !== undefined &&
    (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535)
  ) {
    throw new Error(`folders[${index}].remote.port deve estar entre 1 e 65535.`);
  }
  return {
    type: "ssh",
    host: value.host.trim(),
    user: value.user.trim(),
    port: typeof value.port === "number" ? value.port : undefined,
    keyPath: typeof value.keyPath === "string" && value.keyPath.trim() ? value.keyPath.trim() : undefined,
  };
}

export function normalizeWorkspaceFile(
  value: unknown,
  workspaceFilePath?: string | null
): NormalizedWorkspace {
  if (!isObject(value)) throw new Error("Workspace deve ser um objeto JSON.");
  if (value.fluentWorkspace !== FLUENT_WORKSPACE_VERSION) {
    throw new Error(`fluentWorkspace deve ser ${FLUENT_WORKSPACE_VERSION}.`);
  }
  if (!Array.isArray(value.folders)) throw new Error("folders deve ser uma lista.");

  const folders = value.folders.map((raw, index): WorkspaceFolder => {
    if (!isObject(raw)) throw new Error(`folders[${index}] deve ser um objeto.`);
    if (typeof raw.path !== "string" || raw.path.trim() === "") {
      throw new Error(`folders[${index}].path e obrigatorio.`);
    }
    const path = raw.path.trim();
    const remote = normalizeSshAuthority(raw.remote, index);
    const provider: WorkspaceProvider = remote ? "ssh" : "local";
    const identity = remote
      ? `ssh:${remote.user}@${remote.host}:${remote.port ?? 22}:${path}`
      : `local:${path.toLocaleLowerCase()}`;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `root-${stableHash(identity)}`;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : baseName(path);
    return { id, name, path, provider, remote };
  });

  const seen = new Set<string>();
  for (const folder of folders) {
    if (seen.has(folder.id)) throw new Error(`id de pasta duplicado: ${folder.id}.`);
    seen.add(folder.id);
  }

  return {
    version: FLUENT_WORKSPACE_VERSION,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : workspaceNameFromFilePath(workspaceFilePath),
    folders,
    gitMode: "perFolder",
    settings: isObject(value.settings) ? value.settings : {},
  };
}

export function parseWorkspaceFile(
  contents: string,
  workspaceFilePath?: string | null
): NormalizedWorkspace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Workspace JSON invalido: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeWorkspaceFile(parsed, workspaceFilePath);
}

export function serializeWorkspaceFile(workspace: NormalizedWorkspace): string {
  const file: FluentWorkspaceFile = {
    fluentWorkspace: FLUENT_WORKSPACE_VERSION,
    name: workspace.name,
    folders: workspace.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      path: folder.path,
      remote: folder.remote,
    })),
    git: { mode: workspace.gitMode },
    settings: workspace.settings,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function isFluentWorkspaceFile(path: string): boolean {
  return path.toLocaleLowerCase().endsWith(FLUENT_WORKSPACE_EXTENSION);
}

export function fluentWorkspaceFromCodeWorkspace(
  value: CodeWorkspaceFile,
  name = "Workspace"
): FluentWorkspaceFile {
  return {
    fluentWorkspace: FLUENT_WORKSPACE_VERSION,
    name,
    folders: (value.folders ?? [])
      .map((folder) => ({
        name: folder.name,
        path: folder.path ?? folder.uri ?? "",
      }))
      .filter((folder) => folder.path.trim() !== ""),
    git: { mode: "perFolder" },
    settings: value.settings ?? {},
  };
}
