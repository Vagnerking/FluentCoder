/**
 * Busca e organização da tela de Configurações (puro, testável):
 * filtros `@modified`, `@ext:<id>`, `@lang:<id>`, `@tag:<tag>`, `@id:<chave>`
 * e texto livre (todas as palavras precisam aparecer na chave, título,
 * descrição, rótulos do enum ou tags), com faixas para destacar.
 */
import { SETTING_CATEGORIES, groupFromKey, titleFromKey, type SettingCategory, type SettingSchema } from "./registry.ts";

export interface SettingsQuery {
  words: string[];
  modified: boolean;
  ext: string | null;
  lang: string | null;
  tags: string[];
  id: string | null;
}

export function parseSettingsQuery(raw: string): SettingsQuery {
  const q: SettingsQuery = { words: [], modified: false, ext: null, lang: null, tags: [], id: null };
  for (const part of raw.trim().split(/\s+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    if (lower === "@modified") q.modified = true;
    else if (lower.startsWith("@ext:")) q.ext = lower.slice(5) || null;
    else if (lower.startsWith("@lang:")) q.lang = part.slice(6) || null;
    else if (lower.startsWith("@tag:")) q.tags.push(lower.slice(5));
    else if (lower.startsWith("@id:")) q.id = part.slice(4) || null;
    else q.words.push(lower);
  }
  return q;
}

export function settingTitle(s: SettingSchema): string {
  return s.title ?? titleFromKey(s.key);
}

/** Texto pesquisável de uma setting. */
function haystack(s: SettingSchema): string {
  return [s.key, settingTitle(s), s.description, ...(s.enumLabels ?? []), ...(s.enumDescriptions ?? []), ...(s.tags ?? []), s.sourceLabel ?? ""]
    .join("\n")
    .toLowerCase();
}

export function matchesQuery(s: SettingSchema, q: SettingsQuery, isModified: (key: string) => boolean): boolean {
  if (q.modified && !isModified(s.key)) return false;
  if (q.ext && s.source.toLowerCase() !== q.ext) return false;
  if (q.lang && s.scope !== "language-overridable") return false;
  if (q.id && s.key !== q.id) return false;
  if (q.tags.length && !q.tags.every((t) => (s.tags ?? []).some((x) => x.toLowerCase() === t))) return false;
  if (q.words.length) {
    const h = haystack(s);
    return q.words.every((w) => h.includes(w));
  }
  return true;
}

/** Faixas [início, fim) das palavras buscadas num texto (para `<mark>`). */
export function highlightRanges(text: string, words: readonly string[]): [number, number][] {
  if (!words.length || !text) return [];
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const w of words) {
    if (!w) continue;
    let i = lower.indexOf(w);
    while (i >= 0) {
      ranges.push([i, i + w.length]);
      i = lower.indexOf(w, i + w.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

export interface SettingsSection {
  id: string;
  label: string;
  /** Subgrupos (ex.: "Editor › Minimap", ou o nome da extensão). */
  groups: { id: string; label: string; settings: SettingSchema[] }[];
  count: number;
}

/** Organiza as settings (já filtradas) pela árvore de categorias. */
export function buildSections(list: readonly SettingSchema[]): SettingsSection[] {
  const out: SettingsSection[] = [];
  for (const cat of SETTING_CATEGORIES) {
    const inCat = list.filter((s) => s.category === cat.id);
    if (!inCat.length) continue;
    const groups = new Map<string, SettingSchema[]>();
    for (const s of [...inCat].sort((a, b) => (a.source === "core" ? 0 : 1) - (b.source === "core" ? 0 : 1) || (a.sourceLabel ?? "").localeCompare(b.sourceLabel ?? "") || (a.order ?? 0) - (b.order ?? 0))) {
      const g = s.source === "core" ? cat.label : s.sourceLabel || s.source;
      groups.set(g, [...(groups.get(g) ?? []), s]);
    }
    out.push({
      id: cat.id,
      label: cat.label,
      groups: [...groups.entries()].map(([label, settings]) => ({ id: `${cat.id}:${label}`, label, settings })),
      count: inCat.length,
    });
  }
  return out;
}

export function categoryLabel(id: SettingCategory): string {
  return SETTING_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

/** "Editor › Minimap" para chaves aninhadas (prefixo exibido antes do título). */
export function settingGroupPrefix(s: SettingSchema): string {
  return s.title ? "" : groupFromKey(s.key);
}
