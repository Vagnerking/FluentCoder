/**
 * Rótulo legível de um atalho, por SO.
 *
 * Aceita o formato das extensões VS Code (`ctrl+shift+escape`, acordes
 * separados por espaço) e os aceleradores dos menus do app (`Ctrl+K Ctrl+O`).
 *
 * Modificadores:
 * - `Ctrl` dos aceleradores do app é **CtrlCmd**: o handler de teclado aceita
 *   `ctrlKey || metaKey`, então no macOS o atalho real é ⌘ — e o rótulo diz ⌘.
 *   Tokens explícitos `mod`, `ctrlcmd` e `cmdorctrl` também são CtrlCmd.
 * - `winctrl`/`rawctrl` é sempre o Control físico (⌃ no macOS).
 * - Nos atalhos das extensões (formato VS Code) `ctrl` é o Control físico; o
 *   macOS usa o campo `mac` da contribuição (ver `keybindingFor`).
 *
 * Saída: `Ctrl+Shift+P` no Windows/Linux; `⇧⌘P` no macOS (ordem da Apple:
 * ⌃ ⌥ ⇧ ⌘, sem separador).
 */

import { getPlatform, type OsKind } from "./os.ts";

type Mod = "ctrlcmd" | "ctrl" | "alt" | "shift" | "meta";

const MOD_TOKENS: Record<string, Mod> = {
  ctrl: "ctrlcmd",
  control: "ctrlcmd",
  mod: "ctrlcmd",
  ctrlcmd: "ctrlcmd",
  cmdorctrl: "ctrlcmd",
  commandorcontrol: "ctrlcmd",
  winctrl: "ctrl",
  rawctrl: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  super: "meta",
};

const KEY_NAMES: Record<string, string> = {
  escape: "Esc",
  esc: "Esc",
  enter: "Enter",
  return: "Enter",
  space: "Espaço",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  uparrow: "↑",
  downarrow: "↓",
  leftarrow: "←",
  rightarrow: "→",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  insert: "Insert",
  backquote: "`",
};

const MAC_ORDER: Mod[] = ["ctrl", "alt", "shift", "meta"];
const MAC_SYMBOL: Record<Mod, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘", ctrlcmd: "⌘" };
const PC_ORDER: Mod[] = ["ctrl", "shift", "alt", "meta"];

function keyName(k: string): string {
  const low = k.toLowerCase();
  if (KEY_NAMES[low]) return KEY_NAMES[low];
  if (/^f\d{1,2}$/.test(low)) return low.toUpperCase();
  return k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1);
}

export interface FormatOptions {
  /**
   * `ctrl` significa CtrlCmd (padrão: `true`, o contrato dos aceleradores do
   * app). Use `false` para atalhos no formato VS Code das extensões.
   */
  ctrlIsCmd?: boolean;
}

function resolveOs(target: boolean | OsKind | undefined): OsKind {
  if (target === true) return "macos";
  if (target === false) return "windows";
  return target ?? getPlatform().os;
}

function formatChord(chord: string, os: OsKind, ctrlIsCmd: boolean): string {
  // "ctrl++" → a tecla é "+".
  const parts = chord.endsWith("++") ? [...chord.slice(0, -2).split("+"), "+"] : chord.split("+");
  const mods = new Set<Mod>();
  const keys: string[] = [];
  for (const raw of parts.filter(Boolean)) {
    let mod = MOD_TOKENS[raw.toLowerCase()];
    if (mod === "ctrlcmd" && !ctrlIsCmd && /^(ctrl|control)$/i.test(raw)) mod = "ctrl";
    if (mod) {
      // CtrlCmd fora do macOS é o próprio Ctrl.
      mods.add(mod === "ctrlcmd" ? (os === "macos" ? "meta" : "ctrl") : mod);
    } else {
      keys.push(keyName(raw));
    }
  }
  if (os === "macos") {
    return MAC_ORDER.filter((m) => mods.has(m)).map((m) => MAC_SYMBOL[m]).join("") + keys.join("");
  }
  const metaName = os === "windows" ? "Win" : "Super";
  const names: Record<Mod, string> = { ctrl: "Ctrl", ctrlcmd: "Ctrl", shift: "Shift", alt: "Alt", meta: metaName };
  return [...PC_ORDER.filter((m) => mods.has(m)).map((m) => names[m]), ...keys].join("+");
}

/**
 * Formata um atalho para o SO. `target`: `true` = macOS (compatibilidade com a
 * assinatura antiga), um `OsKind`, ou omitido = SO atual.
 */
export function formatKeybinding(
  raw: string | undefined | null,
  target?: boolean | OsKind,
  opts: FormatOptions = {},
): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const chords = raw.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (chords.length === 0) return undefined;
  const os = resolveOs(target);
  const ctrlIsCmd = opts.ctrlIsCmd ?? true;
  return chords.map((c) => formatChord(c, os, ctrlIsCmd)).join(" ");
}

/**
 * Formata todos os atalhos embutidos num texto livre (`"Mensagem (Ctrl+Enter
 * para …)"`, `"Abra uma pasta (ou Ctrl+K Ctrl+O)"`). Só mexe em sequências
 * que começam por um modificador.
 */
export function formatShortcutsInText(text: string, target?: boolean | OsKind): string {
  const os = resolveOs(target);
  if (os !== "macos") return text;
  const mod = "(?:Ctrl|Shift|Alt|Cmd|Meta)";
  const key = "(?:F\\d{1,2}|Enter|Esc|Tab|Delete|Backspace|PageUp|PageDown|Home|End|[A-Za-z0-9`,.;/\\\\\\[\\]=+-])";
  const chord = `${mod}(?:\\+${mod})*\\+${key}`;
  const re = new RegExp(`\\b${chord}(?:\\s${chord})?`, "g");
  return text.replace(re, (m) => formatKeybinding(m, os) ?? m);
}

export interface ContributedKeybinding {
  command: string;
  key: string;
  mac?: string;
  linux?: string;
  win?: string;
  when?: string;
}

/** Primeiro atalho contribuído (formato VS Code) para um comando, no SO atual. */
export function keybindingFor(
  command: string,
  list: ContributedKeybinding[] | undefined,
  target?: boolean | OsKind,
): string | undefined {
  const kb = list?.find((k) => k.command === command && !/^\s*false\s*$/.test(k.when ?? ""));
  if (!kb) return undefined;
  const os = resolveOs(target);
  const raw = (os === "macos" ? kb.mac : os === "linux" ? kb.linux : kb.win) ?? kb.key;
  return formatKeybinding(raw, os, { ctrlIsCmd: false });
}
