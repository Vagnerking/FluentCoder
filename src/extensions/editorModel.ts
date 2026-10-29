/**
 * Conversões puras Monaco ↔ protocolo do host de extensões (0-based, como a
 * API `vscode`). Sem dependência do Monaco/DOM para rodar no `node --test`.
 */
import type { PlainPosition, PlainRange, PlainSelection } from "./protocol";

/** `IRange` do Monaco (1-based). */
export interface MonacoRangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** `ISelection` do Monaco (âncora = selectionStart, ativo = position). */
export interface MonacoSelectionLike {
  selectionStartLineNumber: number;
  selectionStartColumn: number;
  positionLineNumber: number;
  positionColumn: number;
}

export function toPlainRange(r: MonacoRangeLike): PlainRange {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
  };
}

export function toMonacoRange(r: PlainRange): MonacoRangeLike {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

export function toPlainSelection(s: MonacoSelectionLike): PlainSelection {
  return {
    anchor: { line: s.selectionStartLineNumber - 1, character: s.selectionStartColumn - 1 },
    active: { line: s.positionLineNumber - 1, character: s.positionColumn - 1 },
  };
}

export function toMonacoSelection(s: PlainSelection): MonacoSelectionLike {
  return {
    selectionStartLineNumber: s.anchor.line + 1,
    selectionStartColumn: s.anchor.character + 1,
    positionLineNumber: s.active.line + 1,
    positionColumn: s.active.character + 1,
  };
}

/** Mudanças do `onDidChangeContent` do Monaco → `documentChanged.changes`. */
export function toPlainChanges(
  changes: readonly { range: MonacoRangeLike; text: string; rangeOffset?: number; rangeLength?: number }[],
): { range: PlainRange; text: string; rangeOffset?: number; rangeLength?: number }[] {
  return changes.map((c) => ({ range: toPlainRange(c.range), text: c.text, rangeOffset: c.rangeOffset, rangeLength: c.rangeLength }));
}

/** `monaco.MarkerSeverity` (Hint=1, Info=2, Warning=4, Error=8) → `vscode.DiagnosticSeverity`. */
export function markerSeverityToVscode(sev: number): number {
  if (sev >= 8) return 0;
  if (sev >= 4) return 1;
  if (sev >= 2) return 2;
  return 3;
}

/** `vscode.DiagnosticSeverity` → `monaco.MarkerSeverity`. */
export function vscodeSeverityToMarker(sev: number): number {
  return sev === 0 ? 8 : sev === 1 ? 4 : sev === 2 ? 2 : 1;
}

export interface MarkerLike extends MonacoRangeLike {
  message: string;
  severity: number;
  source?: string;
  code?: string | { value: string };
  owner?: string;
}

export function markersToDiagnostics(markers: readonly MarkerLike[]) {
  return markers.map((m) => ({
    range: toPlainRange(m),
    message: m.message,
    severity: markerSeverityToVscode(m.severity),
    source: m.source ?? m.owner,
    code: typeof m.code === "object" && m.code ? m.code.value : m.code,
  }));
}

// ------------------------------------------------------------ atalhos

const MOD_ORDER = ["ctrl", "shift", "alt", "meta"] as const;
const KEY_ALIASES: Record<string, string> = {
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  " ": "space",
  esc: "escape",
  return: "enter",
  del: "delete",
  ins: "insert",
};

/** Normaliza "Cmd+Alt+K" / "ctrl+shift+escape" para comparação. */
export function normalizeChord(chord: string): string {
  const parts = chord.toLowerCase().split("+").map((p) => p.trim());
  // "ctrl++" → a tecla é "+"
  let key = parts.pop() ?? "";
  if (key === "" && parts.length) {
    parts.pop();
    key = "+";
  }
  const mods = new Set(parts.map((p) => (p === "cmd" || p === "win" || p === "super" ? "meta" : p === "control" ? "ctrl" : p === "option" ? "alt" : p)));
  key = KEY_ALIASES[key] ?? key;
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join("+");
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/** Tecla de um KeyboardEvent → acorde normalizado ("ctrl+shift+p"). */
export function chordFromKey(e: KeyLike): string {
  let key = e.key.toLowerCase();
  // Letras/dígitos pelo `code` (independe do layout e do Shift/Alt).
  if (e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (e.code && /^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  key = KEY_ALIASES[key] ?? key;
  const mods = [e.ctrl && "ctrl", e.shift && "shift", e.alt && "alt", e.meta && "meta"].filter(Boolean);
  return [...mods, key].join("+");
}

// ------------------------------------------------------------ decorações

export type ThemeColorResolver = (id: string) => string | undefined;

type ColorValue = string | { themeColor: string } | undefined;

function color(v: unknown, resolve: ThemeColorResolver): string | undefined {
  if (!v) return undefined;
  if (typeof v === "object" && v && "themeColor" in (v as Record<string, unknown>)) return resolve(String((v as { themeColor: string }).themeColor));
  return typeof v === "string" ? v : undefined;
}

const CSS_PROPS: Record<string, string> = {
  backgroundColor: "background-color",
  border: "border",
  borderColor: "border-color",
  borderRadius: "border-radius",
  borderStyle: "border-style",
  borderWidth: "border-width",
  color: "color",
  fontStyle: "font-style",
  fontWeight: "font-weight",
  opacity: "opacity",
  outline: "outline",
  outlineColor: "outline-color",
  textDecoration: "text-decoration",
  cursor: "cursor",
  letterSpacing: "letter-spacing",
  margin: "margin",
};

function safeCss(v: string): boolean {
  return !/[;{}<>\\]/.test(v);
}

function declarations(o: Record<string, unknown>, resolve: ThemeColorResolver): string {
  const out: string[] = [];
  for (const [k, prop] of Object.entries(CSS_PROPS)) {
    const raw = o[k] as ColorValue;
    const v = /color/i.test(k) ? color(raw, resolve) : typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
    if (v !== undefined && safeCss(v)) out.push(`${prop}:${v}`);
  }
  return out.join(";");
}

/** `content: "…"` seguro para CSS. */
function cssString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"`;
}

export interface DecorationRender {
  css: string;
  /** Opções do `IModelDecorationOptions` (sem hover/range). */
  options: {
    className?: string;
    inlineClassName?: string;
    isWholeLine?: boolean;
    beforeContentClassName?: string;
    afterContentClassName?: string;
    glyphMarginClassName?: string;
    overviewRulerColor?: string;
    /** `vscode.OverviewRulerLane` (Left=1, Center=2, Right=4, Full=7 — iguais aos do Monaco). */
    overviewRulerLane?: number;
    /** `vscode.DecorationRangeBehavior` = `monaco.TrackedRangeStickiness` (mesmos números). */
    stickiness?: number;
  };
}

const DATA_URI_RE = /^data:image\/(svg\+xml|png|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** `{dataUri}` vindo do host (ícone já embutido e validado lá) → `url("…")` seguro. */
function iconUrl(v: unknown): string | undefined {
  const d = v && typeof v === "object" ? (v as { dataUri?: unknown }).dataUri : undefined;
  return typeof d === "string" && d.length <= 128 * 1024 && DATA_URI_RE.test(d) ? `url("${d}")` : undefined;
}

/** `gutterIconSize` do VS Code → `background-size`. */
export function gutterIconSize(v: unknown): string {
  if (v === "auto" || v === "cover" || v === "contain") return v;
  if (typeof v === "string" && /^\d{1,3}(\.\d+)?%$/.test(v)) return v;
  return "contain";
}

/** Regras `::before`/`::after` (texto, ícone, cores, tamanho) de uma decoração. */
function attachmentRules(cls: string, side: "before" | "after", s: Record<string, unknown>, resolve: ThemeColorResolver): string | null {
  const parts = [declarations(s, resolve)];
  if (typeof s.contentText === "string") parts.push(`content:${cssString(s.contentText)}`);
  const icon = iconUrl(s.contentIconPath);
  if (icon) {
    if (typeof s.contentText !== "string") parts.push(`content:""`);
    parts.push(`display:inline-block;background:${icon} center center no-repeat;background-size:contain`);
  }
  for (const k of ["width", "height"] as const) {
    const v = s[k];
    if (typeof v === "string" && safeCss(v)) parts.push(`${k}:${v}`);
  }
  const decl = parts.filter(Boolean).join(";");
  return decl ? `.${cls}::${side}{${decl}}` : null;
}

/**
 * `createTextEditorDecorationType(options)` → CSS (classes `.extd-<key>`) e as
 * opções de decoração do Monaco. Só propriedades conhecidas; valores com
 * `; { } < > \` são descartados (viram CSS injetado no app). Ícones de
 * gutter/anexos chegam do host como `data:` URI de imagem (validados aqui de
 * novo) → glyph margin / `::before`/`::after`.
 */
export function renderDecorationType(key: string, raw: Record<string, unknown>, resolve: ThemeColorResolver): DecorationRender {
  const safeKey = key.replace(/[^\w-]/g, "");
  // Tema escuro: as opções específicas sobrepõem as gerais.
  const o = { ...raw, ...((raw.dark as Record<string, unknown>) ?? {}) };
  const rules: string[] = [];
  const options: DecorationRender["options"] = {};
  const main = declarations(o, resolve);
  const wholeLine = o.isWholeLine === true;
  if (main) {
    const cls = `extd-${safeKey}`;
    rules.push(`.${cls}{${main}}`);
    if (wholeLine) {
      options.className = cls;
      options.isWholeLine = true;
    } else options.inlineClassName = cls;
  } else if (wholeLine) options.isWholeLine = true;
  for (const side of ["before", "after"] as const) {
    const s = o[side] as Record<string, unknown> | undefined;
    if (!s || typeof s !== "object") continue;
    const cls = `extd-${safeKey}-${side}`;
    const rule = attachmentRules(cls, side, s, resolve);
    if (!rule) continue;
    rules.push(rule);
    if (side === "before") options.beforeContentClassName = cls;
    else options.afterContentClassName = cls;
  }
  const gutter = iconUrl(o.gutterIconPath);
  if (gutter) {
    const cls = `extd-${safeKey}-gutter`;
    rules.push(`.${cls}{background:${gutter} center center no-repeat;background-size:${gutterIconSize(o.gutterIconSize)}}`);
    options.glyphMarginClassName = cls;
  }
  const ruler = color(o.overviewRulerColor, resolve);
  if (ruler && safeCss(ruler)) {
    options.overviewRulerColor = ruler;
    const lane = o.overviewRulerLane;
    options.overviewRulerLane = lane === 1 || lane === 2 || lane === 4 || lane === 7 ? lane : 2;
  }
  const rb = o.rangeBehavior;
  if (rb === 0 || rb === 1 || rb === 2 || rb === 3) options.stickiness = rb;
  return { css: rules.join("\n"), options };
}

/** Hash curto e estável (FNV-1a) para nomear classes por instância. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * `renderOptions` de UMA faixa (`DecorationOptions.renderOptions`: before/after
 * com texto/ícone próprios — ex.: blame inline) → classes `extd-<key>-i<hash>`.
 * Sobrepõem o before/after do tipo naquela faixa.
 */
export function renderDecorationInstance(key: string, raw: Record<string, unknown> | undefined, resolve: ThemeColorResolver): DecorationRender | null {
  if (!raw || typeof raw !== "object") return null;
  const o = { ...raw, ...((raw.dark as Record<string, unknown>) ?? {}) };
  const id = `extd-${key.replace(/[^\w-]/g, "")}-i${shortHash(JSON.stringify(o))}`;
  const rules: string[] = [];
  const options: DecorationRender["options"] = {};
  for (const side of ["before", "after"] as const) {
    const s = o[side] as Record<string, unknown> | undefined;
    if (!s || typeof s !== "object") continue;
    const cls = `${id}-${side}`;
    const rule = attachmentRules(cls, side, s, resolve);
    if (!rule) continue;
    rules.push(rule);
    if (side === "before") options.beforeContentClassName = cls;
    else options.afterContentClassName = cls;
  }
  return rules.length ? { css: rules.join("\n"), options } : null;
}

/** Opções finais do Monaco para uma faixa (tipo + instância + hover). */
export function monacoDecorationOptions(type: DecorationRender, instance?: DecorationRender | null, hoverMessage?: string): Record<string, unknown> {
  const { overviewRulerColor, overviewRulerLane, ...rest } = type.options;
  const out: Record<string, unknown> = { ...rest, ...(instance?.options ?? {}) };
  if (overviewRulerColor) out.overviewRuler = { color: overviewRulerColor, position: overviewRulerLane ?? 2 };
  if (hoverMessage) out.hoverMessage = { value: hoverMessage };
  return out;
}

/** ThemeColor do VS Code ("editor.findMatchBackground") → variável `--vscode-*`. */
export function themeColorVar(id: string): string {
  return `--vscode-${id.replace(/\./g, "-")}`;
}

export function samePosition(a: PlainPosition, b: PlainPosition): boolean {
  return a.line === b.line && a.character === b.character;
}
