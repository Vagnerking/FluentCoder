/**
 * `language-configuration.json` (JSONC) de uma extensão → configuração de
 * linguagem do Monaco: comentários, brackets, autoClosingPairs,
 * surroundingPairs, folding (markers/offSide), wordPattern, indentationRules e
 * onEnterRules. Toda regex passa por `timedRegex` (tamanho, estrutura,
 * compilação e orçamento de tempo); a que falhar é descartada com aviso.
 * Puro (sem Monaco): os valores de `indentAction` são os números do enum
 * `IndentAction` (None=0, Indent=1, IndentOutdent=2, Outdent=3).
 */
import { timedRegex } from "./redos.ts";

export interface MonacoLanguageConfiguration {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  autoClosingPairs?: { open: string; close: string; notIn?: string[] }[];
  surroundingPairs?: { open: string; close: string }[];
  folding?: { markers?: { start: RegExp; end: RegExp }; offSide?: boolean };
  wordPattern?: RegExp;
  indentationRules?: { increaseIndentPattern: RegExp; decreaseIndentPattern: RegExp; indentNextLinePattern?: RegExp; unIndentedLinePattern?: RegExp };
  onEnterRules?: { beforeText: RegExp; afterText?: RegExp; previousLineText?: RegExp; action: { indentAction: number; appendText?: string; removeText?: number } }[];
  autoCloseBefore?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const short = (v: unknown, max = 16): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

function pair(v: unknown): [string, string] | null {
  return Array.isArray(v) && v.length === 2 && short(v[0]) && short(v[1]) ? [v[0], v[1]] : null;
}

function openClose(v: unknown): { open: string; close: string; notIn?: string[] } | null {
  const p = pair(v);
  if (p) return { open: p[0], close: p[1] };
  if (isObj(v) && short(v.open) && short(v.close)) {
    const notIn = Array.isArray(v.notIn) ? v.notIn.filter((x): x is string => x === "string" || x === "comment") : undefined;
    return { open: v.open, close: v.close, ...(notIn?.length ? { notIn } : {}) };
  }
  return null;
}

const INDENT_ACTIONS: Record<string, number> = { none: 0, indent: 1, indentOutdent: 2, outdent: 3 };

export function convertLanguageConfiguration(raw: unknown, warn: (msg: string) => void = () => {}): MonacoLanguageConfiguration {
  const out: MonacoLanguageConfiguration = {};
  if (!isObj(raw)) return out;
  const re = (v: unknown, where: string) => {
    if (v === undefined) return undefined;
    const r = timedRegex(v);
    if (!r.regex) warn(`${where}: ${r.problem}`);
    return r.regex ?? undefined;
  };
  if (isObj(raw.comments)) {
    const c: MonacoLanguageConfiguration["comments"] = {};
    if (short(raw.comments.lineComment)) c.lineComment = raw.comments.lineComment;
    const b = pair(raw.comments.blockComment);
    if (b) c.blockComment = b;
    out.comments = c;
  }
  if (Array.isArray(raw.brackets)) out.brackets = raw.brackets.map(pair).filter((x): x is [string, string] => !!x).slice(0, 64);
  if (Array.isArray(raw.autoClosingPairs)) out.autoClosingPairs = raw.autoClosingPairs.map(openClose).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 64);
  if (Array.isArray(raw.surroundingPairs))
    out.surroundingPairs = raw.surroundingPairs.map(openClose).filter((x): x is NonNullable<typeof x> => !!x).map(({ open, close }) => ({ open, close })).slice(0, 64);
  if (typeof raw.autoCloseBefore === "string" && raw.autoCloseBefore.length <= 64) out.autoCloseBefore = raw.autoCloseBefore;
  if (isObj(raw.folding)) {
    const f: NonNullable<MonacoLanguageConfiguration["folding"]> = {};
    if (typeof raw.folding.offSide === "boolean") f.offSide = raw.folding.offSide;
    if (isObj(raw.folding.markers)) {
      const start = re(raw.folding.markers.start, "folding.markers.start");
      const end = re(raw.folding.markers.end, "folding.markers.end");
      if (start && end) f.markers = { start, end };
    }
    out.folding = f;
  }
  const wp = re(raw.wordPattern, "wordPattern");
  if (wp) out.wordPattern = wp.flags.includes("g") ? wp : new RegExp(wp.source, wp.flags + "g");
  if (isObj(raw.indentationRules)) {
    const r = raw.indentationRules;
    const inc = re(r.increaseIndentPattern, "indentationRules.increaseIndentPattern");
    const dec = re(r.decreaseIndentPattern, "indentationRules.decreaseIndentPattern");
    if (inc && dec) {
      out.indentationRules = { increaseIndentPattern: inc, decreaseIndentPattern: dec };
      const next = re(r.indentNextLinePattern, "indentationRules.indentNextLinePattern");
      const un = re(r.unIndentedLinePattern, "indentationRules.unIndentedLinePattern");
      if (next) out.indentationRules.indentNextLinePattern = next;
      if (un) out.indentationRules.unIndentedLinePattern = un;
    }
  }
  if (Array.isArray(raw.onEnterRules)) {
    const rules: NonNullable<MonacoLanguageConfiguration["onEnterRules"]> = [];
    raw.onEnterRules.slice(0, 32).forEach((r, i) => {
      if (!isObj(r) || !isObj(r.action)) return;
      const beforeText = re(r.beforeText, `onEnterRules[${i}].beforeText`);
      if (!beforeText) return;
      const action = r.action;
      const indentAction = typeof action.indent === "string" ? INDENT_ACTIONS[action.indent] : undefined;
      if (indentAction === undefined) return;
      const rule: (typeof rules)[number] = { beforeText, action: { indentAction } };
      const after = re(r.afterText, `onEnterRules[${i}].afterText`);
      const prev = re(r.previousLineText, `onEnterRules[${i}].previousLineText`);
      if (after) rule.afterText = after;
      if (prev) rule.previousLineText = prev;
      if (typeof action.appendText === "string" && action.appendText.length <= 32) rule.action.appendText = action.appendText;
      if (typeof action.removeText === "number" && action.removeText >= 0 && action.removeText <= 32) rule.action.removeText = action.removeText;
      rules.push(rule);
    });
    out.onEnterRules = rules;
  }
  return out;
}
