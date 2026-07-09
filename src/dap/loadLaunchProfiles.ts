/**
 * Carrega os profiles de `Properties/launchSettings.json` ao lado de um `.csproj`
 * (milestone #9). Separado do parser puro (`launchSettings.ts`) por fazer I/O.
 */
import { readFile } from "../api";
import { parseLaunchSettings, type LaunchProfile } from "./launchSettings";

/** Diretório de um caminho de arquivo (barras normais ou invertidas). */
function dirOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

/**
 * Lê e parseia o launchSettings.json do projeto de `csprojPath`, se existir.
 * Convenção: `<dir do csproj>/Properties/launchSettings.json`. Retorna [] quando
 * ausente ou ilegível (projeto sem perfis é o caso comum de libraries/console).
 */
export async function loadLaunchProfiles(csprojPath: string): Promise<LaunchProfile[]> {
  const path = `${dirOf(csprojPath)}/Properties/launchSettings.json`;
  try {
    const { content } = await readFile(path);
    return parseLaunchSettings(content);
  } catch {
    return [];
  }
}
