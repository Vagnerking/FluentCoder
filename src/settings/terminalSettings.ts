/**
 * Settings do terminal integrado (`terminal.integrated.*`, `fluent.terminal.*`).
 * Puro: o TerminalView aplica as opções do xterm e o shell padrão por SO.
 */
import type { OsKind } from "../platform/os.ts";

type Get = (key: string) => unknown;

export interface TerminalOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
}

export function terminalOptionsFromSettings(get: Get, fallbackFont: string): TerminalOptions {
  const fam = String(get("terminal.integrated.fontFamily") ?? "").trim() || String(get("editor.fontFamily") ?? "").trim();
  const size = Number(get("terminal.integrated.fontSize"));
  const lh = Number(get("terminal.integrated.lineHeight"));
  const style = get("terminal.integrated.cursorStyle");
  const sb = Number(get("terminal.integrated.scrollback"));
  return {
    fontFamily: fam || fallbackFont,
    fontSize: Number.isFinite(size) && size >= 6 && size <= 100 ? size : 13,
    lineHeight: Number.isFinite(lh) && lh >= 1 && lh <= 3 ? lh : 1.2,
    // VS Code chama de "line" o que o xterm chama de "bar".
    cursorStyle: style === "line" ? "bar" : style === "underline" ? "underline" : "block",
    cursorBlink: get("terminal.integrated.cursorBlinking") !== false,
    scrollback: Number.isFinite(sb) && sb >= 0 ? Math.min(1_000_000, Math.floor(sb)) : 1000,
  };
}

const OS_KEY: Record<OsKind, string> = { linux: "linux", macos: "osx", windows: "windows" };

/**
 * Shell padrão: `fluent.terminal.shellPath` (+ args) ou o perfil nomeado em
 * `terminal.integrated.defaultProfile.<so>` dentro de
 * `terminal.integrated.profiles.<so>` (`{ path, args }`, `path` pode ser lista).
 * `null` = o padrão do backend ($SHELL / PowerShell).
 */
export function defaultShellFromSettings(get: Get, os: OsKind): { shellPath: string; shellArgs?: string[] } | null {
  const direct = String(get("fluent.terminal.shellPath") ?? "").trim();
  const directArgs = get("fluent.terminal.shellArgs");
  if (direct) {
    return { shellPath: direct, shellArgs: Array.isArray(directArgs) ? directArgs.map(String) : undefined };
  }
  const name = get(`terminal.integrated.defaultProfile.${OS_KEY[os]}`);
  const profiles = get(`terminal.integrated.profiles.${OS_KEY[os]}`);
  if (typeof name !== "string" || !name || !profiles || typeof profiles !== "object") return null;
  const p = (profiles as Record<string, unknown>)[name];
  if (!p || typeof p !== "object") return null;
  const raw = (p as { path?: unknown }).path;
  const path = Array.isArray(raw) ? raw.find((x) => typeof x === "string" && x) : raw;
  if (typeof path !== "string" || !path) return null;
  const args = (p as { args?: unknown }).args;
  return { shellPath: path, shellArgs: Array.isArray(args) ? args.map(String) : typeof args === "string" ? [args] : undefined };
}
