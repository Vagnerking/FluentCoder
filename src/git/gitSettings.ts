/**
 * Configurações do Git — fachada sobre o sistema de settings
 * (`git.repositoryScanMaxDepth`, `git.avatars`; schema em
 * `src/settings/coreSettings.ts`). A API é a mesma de antes do sistema de
 * settings; o parâmetro `store` dos getters continua aceito (testes antigos /
 * leitura de um storage legado) mas o valor vem das settings.
 */
import { settings } from "../settings/instance.ts";

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

export function onGitSettingsChange(listener: () => void): () => void {
  return settings.onDidChange((e) => {
    if (e.affectsConfiguration("git")) listener();
  });
}

function normalizeDepth(raw: unknown): number {
  if (raw == null || raw === "") return GIT_SCAN_DEPTH_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return GIT_SCAN_DEPTH_DEFAULT;
  return Math.min(GIT_SCAN_DEPTH_MAX, n);
}

export function getGitScanDepth(store?: Store | null): number {
  if (store) {
    try {
      const raw = store.getItem(GIT_SCAN_DEPTH_KEY);
      if (raw != null) return normalizeDepth(raw);
    } catch {
      /* cai para as settings */
    }
  }
  return normalizeDepth(settings.get(GIT_SCAN_DEPTH_KEY));
}

export function setGitScanDepth(depth: number): void {
  const v = Math.max(0, Math.min(GIT_SCAN_DEPTH_MAX, Math.round(depth)));
  void settings.update(GIT_SCAN_DEPTH_KEY, v, "user").catch(() => {});
}

export function getGitAvatarMode(store?: Store | null): GitAvatarMode {
  let raw: unknown;
  if (store) {
    try {
      raw = store.getItem(GIT_AVATARS_KEY);
    } catch {
      raw = null;
    }
  }
  if (raw == null) raw = settings.get(GIT_AVATARS_KEY);
  return GIT_AVATAR_MODES.includes(raw as GitAvatarMode) ? (raw as GitAvatarMode) : "github";
}

export function setGitAvatarMode(mode: GitAvatarMode): void {
  void settings.update(GIT_AVATARS_KEY, mode, "user").catch(() => {});
}
