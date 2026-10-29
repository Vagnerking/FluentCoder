/**
 * Mantém as camadas workspace/pasta do `SettingsService` em dia com o que o
 * App tem aberto:
 *
 * - uma pasta local → modo `folder` (`.vscode/settings.json` + `.fluent/`);
 * - Fluent Workspace (multi-root e/ou salvo em arquivo) → modo `workspace`: o
 *   `settings` do workspace (agora APLICADO — antes era salvo e ignorado) e as
 *   pastas locais como camadas de pasta;
 * - sessão SSH → só Usuário (settings remotas ficam para uma fase 2).
 */
import { useEffect, useRef } from "react";
import { settings } from "./instance";
import type { WorkspaceDescriptor } from "./service";

export interface WorkspaceLike {
  filePath: string | null;
  folders: { path: string; provider: "local" | "ssh" }[];
  settings: Record<string, unknown>;
}

export function workspaceDescriptor(
  rootPath: string | null,
  remote: boolean,
  workspace: WorkspaceLike | null,
): WorkspaceDescriptor {
  if (workspace && (workspace.filePath || workspace.folders.length > 1 || workspace.folders.some((f) => f.provider === "ssh"))) {
    return {
      mode: "workspace",
      roots: workspace.folders.filter((f) => f.provider === "local").map((f) => f.path),
      workspaceFile: workspace.filePath,
      workspaceSettings: workspace.settings,
    };
  }
  if (rootPath && !remote) return { mode: "folder", roots: [rootPath] };
  return { mode: "empty", roots: [] };
}

export function useWorkspaceSettingsSync(
  rootPath: string | null,
  remote: boolean,
  workspace: WorkspaceLike | null,
  onWorkspaceSettings: (next: Record<string, unknown>) => void,
): void {
  const cb = useRef(onWorkspaceSettings);
  cb.current = onWorkspaceSettings;
  const desc = workspaceDescriptor(rootPath, remote, workspace);
  // Chave estável: só refaz quando raízes/arquivo/settings mudam de verdade.
  const key = JSON.stringify(desc);
  useEffect(() => {
    void settings.setWorkspace(JSON.parse(key) as WorkspaceDescriptor, (next) => cb.current(next)).catch((err) =>
      console.warn("[settings] falha ao carregar as configurações do workspace", err),
    );
  }, [key]);
}
