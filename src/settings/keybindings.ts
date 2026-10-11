/**
 * Atalhos de teclado configuráveis — `User/keybindings.json` no formato do VS
 * Code (`[{ key, command, when?, args? }]`, `-command` remove um padrão).
 * Puro: normalização de teclas, cláusulas `when`, resolução (padrões + usuário)
 * e conflitos. O listener de teclado fica em `keybindingRuntime.ts`.
 */
import { parseJsonc } from "./jsonc.ts";

// ------------------------------------------------------------------- teclas

const MODS = ["ctrl", "shift", "alt", "meta"] as const;
const MOD_ALIASES: Record<string, (typeof MODS)[number]> = {
  ctrl: "ctrl",
  control: "ctrl",
  ctrlcmd: "ctrl",
  mod: "ctrl",
  cmdorctrl: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  meta: "ctrl",
  cmd: "ctrl",
  command: "ctrl",
  win: "ctrl",
  super: "ctrl",
};
const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  del: "delete",
  up: "uparrow",
  down: "downarrow",
  left: "leftarrow",
  right: "rightarrow",
  arrowup: "uparrow",
  arrowdown: "downarrow",
  arrowleft: "leftarrow",
  arrowright: "rightarrow",
  " ": "space",
  plus: "=",
  "+": "=",
  "`": "`",
  backquote: "`",
  oem_3: "`",
  numpad_add: "=",
  pgup: "pageup",
  pgdn: "pagedown",
};

/**
 * Forma canônica de um acorde: `ctrl+shift+alt+meta+tecla` (minúsculas). No
 * keybindings.json do usuário `ctrl` é o Ctrl físico (no macOS use `cmd`); o
 * app trata Ctrl e ⌘ como equivalentes (CtrlCmd), como os aceleradores dos menus.
 */
export function normalizeChord(chord: string): string {
  const raw = chord.trim().toLowerCase();
  if (!raw) return "";
  const parts = raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const clean = parts.filter(Boolean);
  const last = clean.pop() ?? "";
  const mods = new Set<string>();
  for (const p of clean) {
    const m = MOD_ALIASES[p];
    if (m) mods.add(m);
  }
  const key = KEY_ALIASES[last] ?? last;
  return [...MODS.filter((m) => mods.has(m)), key].join("+");
}

/** Normaliza uma sequência (`ctrl+k ctrl+s` → 2 acordes). */
export function normalizeKey(key: string): string {
  return key
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(normalizeChord)
    .join(" ");
}

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Acorde de um evento de teclado (`null` para só modificador). */
export function chordFromEvent(e: KeyEventLike, ctrlIsCmd = true): string | null {
  const k = e.key;
  if (!k || ["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "Dead", "Unidentified"].includes(k)) return null;
  let key: string;
  // `code` é estável entre layouts para letras/dígitos (Shift+2 continua "2").
  if (e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (e.code && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (e.code && /^Numpad\d$/.test(e.code)) key = `numpad${e.code.slice(6)}`;
  else if (e.code === "Backquote") key = "`";
  else if (e.code === "Equal" || e.code === "NumpadAdd") key = "=";
  else if (e.code === "Minus" || e.code === "NumpadSubtract") key = "-";
  else if (e.code === "Comma") key = ",";
  else if (e.code === "Period") key = ".";
  else if (e.code === "Slash") key = "/";
  else if (e.code === "Backslash") key = "\\";
  else if (e.code === "Semicolon") key = ";";
  else if (e.code === "Quote") key = "'";
  else if (e.code === "BracketLeft") key = "[";
  else if (e.code === "BracketRight") key = "]";
  else key = KEY_ALIASES[k.toLowerCase()] ?? k.toLowerCase();
  const mods: string[] = [];
  if (e.ctrlKey || (ctrlIsCmd && e.metaKey)) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.metaKey && !ctrlIsCmd) mods.push("meta");
  return [...mods, key].join("+");
}

// ---------------------------------------------------------------------- when

type Tok = { t: "id" | "str" | "re" | "op" | "(" | ")"; v: string };

function tokenizeWhen(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["&&", "||", "==", "!=", "=~", "<=", ">="].includes(two)) {
      // `==` pode vir como `===`.
      if ((two === "==" || two === "!=") && src[i + 2] === "=") i++;
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (c === "!" || c === "<" || c === ">") {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ t: c, v: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      const v = end < 0 ? src.slice(i + 1) : src.slice(i + 1, end);
      out.push({ t: "str", v });
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === "/" && out.length && out[out.length - 1].t === "op" && out[out.length - 1].v === "=~") {
      let j = i + 1;
      while (j < src.length && src[j] !== "/") j += src[j] === "\\" ? 2 : 1;
      let flags = "";
      let k = j + 1;
      while (k < src.length && /[gimsuy]/.test(src[k])) flags += src[k++];
      out.push({ t: "re", v: `${src.slice(i + 1, j)}\u0000${flags}` });
      i = k;
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s()!=<>&|'"]/.test(src[j])) j++;
    if (j === i) j = i + 1;
    out.push({ t: "id", v: src.slice(i, j) });
    i = j;
  }
  return out;
}

export type WhenContext = (key: string) => unknown;

/**
 * Avalia uma cláusula `when` do VS Code: `!`, `&&`, `||`, parênteses, `==`,
 * `!=`, `=~ /re/`, `<`, `<=`, `>`, `>=`, `in`, `not in`, `true`/`false`.
 * Chave ausente = falsa. Expressão vazia = verdadeira.
 */
export function evaluateWhen(expr: string | null | undefined, ctx: WhenContext): boolean {
  if (!expr || !expr.trim()) return true;
  const toks = tokenizeWhen(expr);
  let pos = 0;
  const peek = () => toks[pos];
  const value = (tok: Tok | undefined): unknown => {
    if (!tok) return undefined;
    if (tok.t === "str") return tok.v;
    if (tok.v === "true") return true;
    if (tok.v === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(tok.v)) return Number(tok.v);
    return tok.v;
  };
  function primary(): boolean {
    const tok = toks[pos++];
    if (!tok) return false;
    if (tok.t === "op" && tok.v === "!") return !primary();
    if (tok.t === "(") {
      const v = or();
      if (peek()?.t === ")") pos++;
      return v;
    }
    if (tok.t !== "id") return Boolean(value(tok));
    if (tok.v === "true") return true;
    if (tok.v === "false") return false;
    const left = ctx(tok.v);
    const op = peek();
    if (op?.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(op.v)) {
      pos++;
      const right = value(toks[pos++]);
      // eslint-disable-next-line eqeqeq
      if (op.v === "==") return left == right || String(left) === String(right);
      // eslint-disable-next-line eqeqeq
      if (op.v === "!=") return !(left == right || String(left) === String(right));
      const a = Number(left);
      const b = Number(right);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return op.v === "<" ? a < b : op.v === "<=" ? a <= b : op.v === ">" ? a > b : a >= b;
    }
    if (op?.t === "op" && op.v === "=~") {
      pos++;
      const re = toks[pos++];
      if (!re || re.t !== "re") return false;
      const [src, flags] = re.v.split("\u0000");
      try {
        return new RegExp(src, flags).test(String(left ?? ""));
      } catch {
        return false;
      }
    }
    if (op?.t === "id" && (op.v === "in" || (op.v === "not" && toks[pos + 1]?.v === "in"))) {
      const negate = op.v === "not";
      pos += negate ? 2 : 1;
      const container = ctx(toks[pos++]?.v ?? "");
      const has = Array.isArray(container)
        ? container.includes(left)
        : container && typeof container === "object"
          ? Object.prototype.hasOwnProperty.call(container, String(left))
          : false;
      return negate ? !has : has;
    }
    return Boolean(left);
  }
  function and(): boolean {
    let v = primary();
    while (peek()?.t === "op" && peek()!.v === "&&") {
      pos++;
      const r = primary();
      v = v && r;
    }
    return v;
  }
  function or(): boolean {
    let v = and();
    while (peek()?.t === "op" && peek()!.v === "||") {
      pos++;
      const r = and();
      v = v || r;
    }
    return v;
  }
  try {
    return or();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ resolução

export type KeybindingSource = "default" | "user" | "extension";

export interface KeybindingRule {
  key: string;
  command: string;
  when?: string;
  args?: unknown;
  source: KeybindingSource;
}

export interface ParsedKeybindings {
  rules: KeybindingRule[];
  errors: string[];
}

/** Lê o `keybindings.json` do usuário (JSONC). */
export function parseKeybindingsJson(text: string | null | undefined): ParsedKeybindings {
  if (!text || !text.trim()) return { rules: [], errors: [] };
  const { value, errors } = parseJsonc(text);
  const out: KeybindingRule[] = [];
  const errs = errors.map((e) => `${e.message} (posição ${e.offset})`);
  if (!Array.isArray(value)) return { rules: [], errors: [...errs, "keybindings.json deve ser uma lista ([ … ])."] };
  value.forEach((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return void errs.push(`Item ${i + 1}: deve ser um objeto.`);
    const o = item as Record<string, unknown>;
    if (typeof o.command !== "string" || !o.command) return void errs.push(`Item ${i + 1}: "command" ausente.`);
    const key = typeof o.key === "string" ? normalizeKey(o.key) : "";
    if (!key && !o.command.startsWith("-")) return void errs.push(`Item ${i + 1}: "key" ausente.`);
    out.push({ key, command: o.command, when: typeof o.when === "string" ? o.when : undefined, args: o.args, source: "user" });
  });
  return { rules: out, errors: errs };
}

/**
 * Regras efetivas: padrões (app + extensões) e depois as do usuário. Uma regra
 * `-command` (com `key` opcional e `when` opcional) remove os padrões
 * correspondentes, como no VS Code.
 */
export function resolveKeybindings(defaults: readonly KeybindingRule[], user: readonly KeybindingRule[]): KeybindingRule[] {
  const removals = user.filter((r) => r.command.startsWith("-"));
  const kept = defaults.filter(
    (d) =>
      !removals.some(
        (r) =>
          r.command.slice(1) === d.command &&
          (!r.key || normalizeKey(r.key) === normalizeKey(d.key)) &&
          (r.when === undefined || (r.when ?? "") === (d.when ?? "")),
      ),
  );
  return [...kept.map((d) => ({ ...d, key: normalizeKey(d.key) })), ...user.filter((r) => !r.command.startsWith("-"))];
}

export type MatchResult =
  | { kind: "none" }
  /** Primeiro acorde de uma sequência: esperar o segundo. */
  | { kind: "chord" }
  | { kind: "match"; rule: KeybindingRule };

/** Resolve uma tecla (com o 1º acorde pendente, se houver). A ÚLTIMA regra que casa vence. */
export function matchKeybinding(rules: readonly KeybindingRule[], pending: string | null, chord: string, ctx: WhenContext): MatchResult {
  const seq = pending ? `${pending} ${chord}` : chord;
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r.key === seq && evaluateWhen(r.when, ctx)) return { kind: "match", rule: r };
  }
  if (!pending && rules.some((r) => r.key.startsWith(chord + " ") && evaluateWhen(r.when, ctx))) return { kind: "chord" };
  return { kind: "none" };
}

export interface KeybindingConflict {
  key: string;
  commands: string[];
}

/** Teclas com mais de um comando cujo `when` pode valer ao mesmo tempo (heurística: mesmo `when` ou algum vazio). */
export function findConflicts(rules: readonly KeybindingRule[]): KeybindingConflict[] {
  const byKey = new Map<string, KeybindingRule[]>();
  for (const r of rules) {
    if (!r.key) continue;
    byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  }
  const out: KeybindingConflict[] = [];
  for (const [key, list] of byKey) {
    const cmds = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.command === b.command) continue;
        const wa = (a.when ?? "").trim();
        const wb = (b.when ?? "").trim();
        if (!wa || !wb || wa === wb) {
          cmds.add(a.command);
          cmds.add(b.command);
        }
      }
    }
    if (cmds.size > 1) out.push({ key, commands: [...cmds] });
  }
  return out;
}

/** Ids do VS Code → ids do app (para keybindings.json copiados do VS Code). */
export const VSCODE_COMMAND_ALIASES: Record<string, string> = {
  "workbench.action.files.save": "menu.file.save",
  "workbench.action.files.saveAs": "menu.file.saveAs",
  "workbench.action.files.openFile": "menu.file.open",
  "workbench.action.files.openFolder": "menu.file.openFolder",
  "workbench.action.files.newUntitledFile": "menu.file.newTextFile",
  "workbench.action.closeActiveEditor": "menu.file.closeEditor",
  "workbench.action.quickOpen": "menu.view.quickOpen",
  "workbench.action.showCommands": "menu.view.commandPalette",
  "workbench.action.toggleSidebarVisibility": "menu.view.toggleSidebar",
  "workbench.action.terminal.toggleTerminal": "menu.view.toggleTerminal",
  "workbench.action.findInFiles": "menu.view.search",
  "workbench.view.search": "menu.view.search",
  "workbench.view.explorer": "menu.view.explorer",
  "workbench.view.scm": "menu.view.scm",
  "workbench.action.showAllSymbols": "editor.goToSymbolInWorkspace",
  "workbench.action.zoomIn": "view.zoomIn",
  "workbench.action.zoomOut": "view.zoomOut",
  "workbench.action.zoomReset": "view.zoomReset",
  "workbench.action.tasks.build": "tasks.runBuild",
  "workbench.action.tasks.runTask": "tasks.run",
  "workbench.action.openSettings": "settings.open",
  "workbench.action.openSettings2": "settings.open",
  "workbench.action.openSettingsJson": "settings.openJson",
  "workbench.action.openGlobalKeybindings": "keybindings.open",
  "workbench.action.openGlobalKeybindingsFile": "keybindings.openJson",
};

export function canonicalCommand(id: string): string {
  return VSCODE_COMMAND_ALIASES[id] ?? id;
}

/**
 * Atalhos embutidos do app (os do handler de teclado do App + os novos de
 * Configurações). São DADOS para a tela de atalhos, conflitos e para o usuário
 * poder removê-los (`-command`); o App continua tratando-os no próprio handler.
 */
export const DEFAULT_APP_KEYBINDINGS: readonly KeybindingRule[] = [
  { key: "ctrl+k ctrl+o", command: "menu.file.openFolder", source: "default" },
  { key: "ctrl+o", command: "menu.file.open", source: "default" },
  { key: "ctrl+n", command: "menu.file.newTextFile", source: "default" },
  { key: "ctrl+s", command: "menu.file.save", source: "default" },
  { key: "ctrl+shift+s", command: "menu.file.saveAs", source: "default" },
  { key: "ctrl+w", command: "menu.file.closeEditor", source: "default" },
  { key: "ctrl+shift+p", command: "menu.view.commandPalette", source: "default" },
  { key: "ctrl+p", command: "menu.view.quickOpen", source: "default" },
  { key: "ctrl+t", command: "editor.goToSymbolInWorkspace", source: "default" },
  { key: "ctrl+shift+f", command: "menu.view.search", source: "default" },
  { key: "ctrl+b", command: "menu.view.toggleSidebar", source: "default" },
  { key: "ctrl+`", command: "menu.view.toggleTerminal", source: "default" },
  { key: "ctrl+=", command: "view.zoomIn", source: "default" },
  { key: "ctrl+-", command: "view.zoomOut", source: "default" },
  { key: "ctrl+0", command: "view.zoomReset", source: "default" },
  { key: "ctrl+,", command: "settings.open", source: "default" },
  { key: "ctrl+k ctrl+s", command: "keybindings.open", source: "default" },
  { key: "ctrl+shift+b", command: "tasks.runBuild", source: "default" },
];

/** Atalhos que o handler do App trata por conta própria (o runtime só intervém se o usuário mudou). */
export const APP_HANDLED_KEYS = new Set(
  DEFAULT_APP_KEYBINDINGS.filter((k) => !["settings.open", "keybindings.open", "tasks.runBuild"].includes(k.command)).map((k) => k.key),
);
