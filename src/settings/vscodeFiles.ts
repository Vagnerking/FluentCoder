/**
 * Leitura dos `.vscode/{tasks,launch,extensions}.json` de uma raiz local (e do
 * arquivo de workspace) pelos comandos de configuração do Rust, já
 * convertidos por `vscodeCompat.ts`. Remoto (SSH) fica de fora nesta fase.
 */
import { invoke } from "@tauri-apps/api/core";
import { getPlatform } from "../platform/os";
import { parseJsoncObject } from "./jsonc";
import { settings } from "./instance";
import {
  parseExtensionRecommendations,
  parseLaunch,
  parseTasks,
  type ExtensionRecommendations,
  type VscodeLaunch,
  type VscodeTask,
} from "./vscodeCompat";

function join(root: string, ...parts: string[]): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

function osTag(): "windows" | "linux" | "osx" {
  const os = getPlatform().os;
  return os === "windows" ? "windows" : os === "macos" ? "osx" : "linux";
}

async function readMany(paths: string[]): Promise<Record<string, string | null>> {
  try {
    return await invoke<Record<string, string | null>>("settings_read_files", { paths });
  } catch {
    return {};
  }
}

export interface VscodeRunEntries {
  tasks: VscodeTask[];
  launches: VscodeLaunch[];
  /** Os arquivos existem? (para a UI dizer "nada encontrado" vs. esconder). */
  hasTasks: boolean;
  hasLaunch: boolean;
}

/** `tasks.json` + `launch.json` (da pasta e do arquivo de workspace) de uma raiz. */
export async function loadVscodeRunEntries(root: string, activeFile?: string | null): Promise<VscodeRunEntries> {
  const tasksPath = join(root, ".vscode", "tasks.json");
  const launchPath = join(root, ".vscode", "launch.json");
  const wsFile = settings.workspaceDescriptor.workspaceFile ?? null;
  const read = await readMany(wsFile ? [tasksPath, launchPath, wsFile] : [tasksPath, launchPath]);
  const ctx = { workspaceFolder: root, file: activeFile ?? null, config: (k: string) => settings.get(k, { resource: root }) };
  const os = osTag();
  const ws = wsFile ? parseJsoncObject(read[wsFile]) : {};
  const wsTasks = ws.tasks && typeof ws.tasks === "object" ? JSON.stringify(ws.tasks) : null;
  const wsLaunch = ws.launch && typeof ws.launch === "object" ? JSON.stringify(ws.launch) : null;
  return {
    tasks: [...parseTasks(read[tasksPath], ctx, os), ...parseTasks(wsTasks, ctx, os)],
    launches: [...parseLaunch(read[launchPath], ctx, os), ...parseLaunch(wsLaunch, ctx, os)],
    hasTasks: read[tasksPath] != null || !!wsTasks,
    hasLaunch: read[launchPath] != null || !!wsLaunch,
  };
}

/** Recomendações de `.vscode/extensions.json` das raízes + `extensions` do arquivo de workspace. */
export async function loadWorkspaceRecommendations(roots: readonly string[]): Promise<ExtensionRecommendations> {
  const files = roots.map((r) => join(r, ".vscode", "extensions.json"));
  const wsFile = settings.workspaceDescriptor.workspaceFile ?? null;
  const read = await readMany(wsFile ? [...files, wsFile] : files);
  const sources: (string | Record<string, unknown> | null)[] = files.map((f) => read[f] ?? null);
  if (wsFile) {
    const ext = parseJsoncObject(read[wsFile]).extensions;
    if (ext && typeof ext === "object" && !Array.isArray(ext)) sources.push(ext as Record<string, unknown>);
  }
  return parseExtensionRecommendations(sources);
}
