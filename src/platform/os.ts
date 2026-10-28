/**
 * SO e capacidades da plataforma, detectados UMA vez.
 *
 * Fonte primária: `window.__FLUENT_PLATFORM__`, injetado pelo Rust
 * (`src-tauri/src/platform/mod.rs`, `init_script`) antes do primeiro paint.
 * Fora do Tauri (testes, `vite` no navegador) cai para o `userAgent` — nunca
 * `navigator.platform` (deprecado; `userAgentData` nem existe no WebKit).
 */

export type OsKind = "windows" | "macos" | "linux";

export interface PlatformCapabilities {
  /** O app desenha minimizar/maximizar/fechar (falso no macOS: semáforos nativos). */
  customCaptionButtons: boolean;
  /** Snap Layouts do Windows 11. */
  snapLayouts: boolean;
  mica: boolean;
  /** Convenção padrão do SO; não determina identidade de arquivos por volume. */
  pathsCaseInsensitive: boolean;
  /** Menu nativo do app (macOS). */
  nativeMenu: boolean;
}

export interface PlatformInfo {
  os: OsKind;
  arch: string;
  family: string;
  desktop: string | null;
  wayland: boolean;
  capabilities: PlatformCapabilities;
}

export function capabilitiesFor(os: OsKind): PlatformCapabilities {
  return {
    customCaptionButtons: os !== "macos",
    snapLayouts: os === "windows",
    mica: os === "windows",
    pathsCaseInsensitive: os !== "linux",
    nativeMenu: os === "macos",
  };
}

/** SO a partir de um user agent (fallback fora do Tauri). Padrão: Windows. */
export function osFromUserAgent(ua: string | undefined | null): OsKind {
  const s = ua ?? "";
  if (/Mac OS X|Macintosh|iPhone|iPad/i.test(s)) return "macos";
  if (/Windows/i.test(s)) return "windows";
  if (/Linux|X11|CrOS|FreeBSD|OpenBSD/i.test(s)) return "linux";
  return "windows";
}

function isOsKind(v: unknown): v is OsKind {
  return v === "windows" || v === "macos" || v === "linux";
}

/** Monta o `PlatformInfo` a partir do que estiver disponível (puro). */
export function detectPlatform(sources: { injected?: unknown; userAgent?: string | null }): PlatformInfo {
  const inj = sources.injected as Partial<PlatformInfo> | null | undefined;
  if (inj && typeof inj === "object" && isOsKind(inj.os)) {
    return {
      os: inj.os,
      arch: typeof inj.arch === "string" ? inj.arch : "",
      family: typeof inj.family === "string" ? inj.family : inj.os === "windows" ? "windows" : "unix",
      desktop: typeof inj.desktop === "string" ? inj.desktop : null,
      wayland: inj.wayland === true,
      capabilities: { ...capabilitiesFor(inj.os), ...(inj.capabilities ?? {}) },
    };
  }
  const os = osFromUserAgent(sources.userAgent);
  return {
    os,
    arch: "",
    family: os === "windows" ? "windows" : "unix",
    desktop: null,
    wayland: false,
    capabilities: capabilitiesFor(os),
  };
}

let cached: PlatformInfo | null = null;

/** Plataforma atual (cacheada; síncrona). */
export function getPlatform(): PlatformInfo {
  if (!cached) {
    const g = globalThis as { __FLUENT_PLATFORM__?: unknown; navigator?: { userAgent?: string } };
    cached = detectPlatform({ injected: g.__FLUENT_PLATFORM__, userAgent: g.navigator?.userAgent });
  }
  return cached;
}

/** Só para testes: força uma plataforma (ou `null` para redetectar). */
export function setPlatformForTests(info: PlatformInfo | OsKind | null): void {
  cached = info == null ? null : typeof info === "string" ? detectPlatform({ injected: { os: info } }) : info;
}

export const isMac = (): boolean => getPlatform().os === "macos";
export const isWindows = (): boolean => getPlatform().os === "windows";
export const isLinux = (): boolean => getPlatform().os === "linux";
