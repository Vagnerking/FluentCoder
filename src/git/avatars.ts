/**
 * Avatares de autores no frontend. Nunca põe URL externa no DOM e nunca
 * bloqueia a renderização: quem desenha mostra iniciais na hora e troca pela
 * imagem (`data:` URL vinda do backend, com cache em disco e política de
 * privacidade `git.avatars`) quando ela chega. Ver `src-tauri/src/git/avatar.rs`.
 */
import { getGitAvatarMode, onGitSettingsChange, type GitAvatarMode } from "./gitSettings.ts";

type Resolver = (email: string, mode: GitAvatarMode, size: number) => Promise<string | null>;

let resolver: Resolver = async (email, mode, size) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("git_avatar", { email, mode, size });
};

const memory = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();

onGitSettingsChange(() => {
  memory.clear();
  pending.clear();
  listeners.forEach((listener) => listener());
});

function keyOf(email: string, mode: GitAvatarMode, size: number) {
  return `${mode}|${size}|${email.trim().toLowerCase()}`;
}

/** Resolve (com cache em memória e deduplicação) — `null` = usar iniciais. */
export function resolveGitAvatar(email: string | undefined | null, size = 64): Promise<string | null> {
  const mode = getGitAvatarMode();
  if (!email || mode === "off") return Promise.resolve(null);
  const key = keyOf(email, mode, size);
  if (memory.has(key)) return Promise.resolve(memory.get(key) ?? null);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const promise = resolver(email, mode, size)
    .catch(() => null)
    .then((url) => {
      memory.set(key, url);
      pending.delete(key);
      listeners.forEach((listener) => listener());
      return url;
    });
  pending.set(key, promise);
  return promise;
}

/**
 * Leitura síncrona para quem não pode esperar (hover do Monaco, menu da
 * status bar): devolve o `data:` URL se já resolvido; senão dispara a busca
 * em segundo plano e devolve `null` (iniciais) agora.
 */
export function peekGitAvatar(email: string | undefined | null, size = 64): string | null {
  const mode = getGitAvatarMode();
  if (!email || mode === "off") return null;
  const key = keyOf(email, mode, size);
  if (memory.has(key)) return memory.get(key) ?? null;
  void resolveGitAvatar(email, size);
  return null;
}

/** Notifica quando qualquer avatar resolve (para re-render). */
export function onGitAvatarResolved(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Iniciais (até 2 letras) e cor determinística para o fallback. */
export function gitAvatarInitials(name: string | undefined | null): string {
  const parts = (name || "?").trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : (parts[0] ?? "?").slice(0, 1);
  return letters.toUpperCase();
}

export function gitAvatarHue(seed: string | undefined | null): number {
  let hash = 0;
  for (const ch of seed || "?") hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

/** Só para testes. */
export function setGitAvatarResolverForTests(next: Resolver): void {
  resolver = next;
  memory.clear();
  pending.clear();
}
