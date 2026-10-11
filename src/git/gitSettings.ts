/**
 * Configurações do Git (idioma `localStorage` do projeto, ver
 * `src/settings/filesExclude.ts`). Leitura sempre tolerante a storage
 * indisponível.
 */

export const GIT_SCAN_DEPTH_KEY = "git.repositoryScanMaxDepth";
export const GIT_SCAN_DEPTH_DEFAULT = 1;
export const GIT_SCAN_DEPTH_MAX = 5;

export const GIT_AVATARS_KEY = "git.avatars";
/**
 * - `github` (padrão): só e-mails `@users.noreply.github.com` viram avatar do
 *   GitHub (o usuário já é público no próprio e-mail); o resto usa iniciais.
 * - `gravatar`: além do GitHub noreply, consulta o Gravatar enviando SÓ o
 *   SHA-256 do e-mail normalizado (opt-in explícito).
 * - `off`: nenhuma requisição externa; sempre iniciais.
 */
export type GitAvatarMode = "github" | "gravatar" | "off";
export const GIT_AVATAR_MODES: readonly GitAvatarMode[] = ["github", "gravatar", "off"];

type Store = Pick<Storage, "getItem" | "setItem">;

function storage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

export function onGitSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function write(key: string, value: string) {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Só preferência.
  }
  listeners.forEach((listener) => listener());
}

export function getGitScanDepth(store: Store | null = storage()): number {
  try {
    const raw = store?.getItem(GIT_SCAN_DEPTH_KEY);
    if (raw == null || raw === "") return GIT_SCAN_DEPTH_DEFAULT;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return GIT_SCAN_DEPTH_DEFAULT;
    return Math.min(GIT_SCAN_DEPTH_MAX, n);
  } catch {
    return GIT_SCAN_DEPTH_DEFAULT;
  }
}

export function setGitScanDepth(depth: number): void {
  write(GIT_SCAN_DEPTH_KEY, String(Math.max(0, Math.min(GIT_SCAN_DEPTH_MAX, Math.round(depth)))));
}

export function getGitAvatarMode(store: Store | null = storage()): GitAvatarMode {
  try {
    const raw = store?.getItem(GIT_AVATARS_KEY);
    return GIT_AVATAR_MODES.includes(raw as GitAvatarMode) ? (raw as GitAvatarMode) : "github";
  } catch {
    return "github";
  }
}

export function setGitAvatarMode(mode: GitAvatarMode): void {
  write(GIT_AVATARS_KEY, mode);
}
