/**
 * Modelo em camadas das configurações (puro, sem E/S):
 *
 *   default < user < workspace < folder  (e, por cima de TODAS, as mesmas
 *   camadas com override de linguagem `"[typescript]": {…}`)
 *
 * — a mesma precedência do VS Code: um valor de linguagem em qualquer nível
 * vence um valor geral em qualquer nível. Objetos simples (ex.: `files.exclude`)
 * são mesclados camada sobre camada, como o `ConfigurationModel.merge` do VS
 * Code; arrays e escalares são substituídos.
 */
import type { SettingsRegistry } from "./registry.ts";

export type ConfigTarget = "user" | "workspace" | "folder";

export interface Layer {
  /** Chaves achatadas (`editor.tabSize`), inclusive as desconhecidas (preservadas p/ extensões). */
  settings: Record<string, unknown>;
  /** `{ languageId: { chave: valor } }` vindo de `"[lang]": {…}` (`"[a][b]"` vale para as duas). */
  overrides: Record<string, Record<string, unknown>>;
}

export const EMPTY_LAYER: Layer = Object.freeze({ settings: {}, overrides: {} }) as Layer;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const LANG_KEY = /^\[([^\]]+)\](?:\[[^\]]+\])*$/;

/** `"[a][b]"` → ["a", "b"]. */
export function languagesOfKey(key: string): string[] | null {
  if (!LANG_KEY.test(key)) return null;
  return [...key.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
}

function flattenInto(
  out: Record<string, unknown>,
  prefix: string,
  obj: Record<string, unknown>,
  registry: Pick<SettingsRegistry, "has" | "isSection"> | null,
): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    // `{ "editor": { "fontSize": 12 } }` → `editor.fontSize`, mas só quando
    // `editor` não é ele mesmo uma setting (ex.: `files.exclude` é objeto).
    if (isPlainObject(v) && registry && !registry.has(key) && registry.isSection(key)) {
      flattenInto(out, key, v, registry);
    } else out[key] = v;
  }
}

/** Converte o objeto bruto de um settings.json em camada. */
export function toLayer(
  raw: Record<string, unknown> | null | undefined,
  registry: Pick<SettingsRegistry, "has" | "isSection"> | null = null,
): Layer {
  const layer: Layer = { settings: {}, overrides: {} };
  if (!raw) return layer;
  for (const [k, v] of Object.entries(raw)) {
    const langs = languagesOfKey(k);
    if (langs && isPlainObject(v)) {
      const flat: Record<string, unknown> = {};
      flattenInto(flat, "", v, registry);
      for (const lang of langs) layer.overrides[lang] = { ...(layer.overrides[lang] ?? {}), ...flat };
    } else if (langs) {
      continue;
    } else {
      flattenInto(layer.settings, "", { [k]: v }, registry);
    }
  }
  return layer;
}

/** Mescla duas camadas (a segunda vence) — usado para `.vscode` + `.fluent`. */
export function mergeLayers(a: Layer, b: Layer): Layer {
  const overrides: Layer["overrides"] = { ...a.overrides };
  for (const [lang, vals] of Object.entries(b.overrides)) overrides[lang] = { ...(overrides[lang] ?? {}), ...vals };
  return { settings: { ...a.settings, ...b.settings }, overrides };
}

function clone<T>(v: T): T {
  return v === undefined || v === null || typeof v !== "object" ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function mergeValue(base: unknown, over: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = mergeValue(base[k], v);
    return out;
  }
  return over;
}

export interface ResolveOptions {
  /** Caminho de um arquivo/pasta: seleciona a camada da pasta (multi-root). */
  resource?: string | null;
  languageId?: string | null;
}

export interface Inspection<T = unknown> {
  key: string;
  defaultValue?: T;
  userValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  defaultLanguageValue?: T;
  userLanguageValue?: T;
  workspaceLanguageValue?: T;
  workspaceFolderLanguageValue?: T;
  value?: T;
  languageIds?: string[];
}

export interface FolderLayer {
  root: string;
  layer: Layer;
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** A raiz (mais específica) que contém `resource`. */
export function folderFor(folders: readonly FolderLayer[], resource: string | null | undefined): FolderLayer | undefined {
  if (!resource) return undefined;
  const r = normPath(resource);
  const rl = r.toLowerCase();
  let best: FolderLayer | undefined;
  for (const f of folders) {
    const root = normPath(f.root);
    const ok = /^[a-zA-Z]:\//.test(root)
      ? rl === root.toLowerCase() || rl.startsWith(root.toLowerCase() + "/")
      : r === root || r.startsWith(root + "/");
    if (ok && (!best || root.length > normPath(best.root).length)) best = f;
  }
  return best;
}

export class ConfigurationModel {
  defaults: Layer = { settings: {}, overrides: {} };
  user: Layer = { settings: {}, overrides: {} };
  workspace: Layer = { settings: {}, overrides: {} };
  folders: FolderLayer[] = [];

  /** Defaults (com `[lang]` dos `configurationDefaults`) a partir do registro. */
  setDefaults(defaults: Record<string, unknown>): void {
    this.defaults = toLayer(defaults, null);
  }

  private chain(opts: ResolveOptions): { general: Layer[]; folder?: FolderLayer } {
    const folder = folderFor(this.folders, opts.resource);
    const general = [this.defaults, this.user, this.workspace];
    if (folder) general.push(folder.layer);
    return { general, folder };
  }

  /** Valor efetivo. */
  get<T = unknown>(key: string, opts: ResolveOptions = {}): T | undefined {
    const { general } = this.chain(opts);
    let value: unknown = undefined;
    let found = false;
    const apply = (v: unknown) => {
      value = found ? mergeValue(value, v) : clone(v);
      found = true;
    };
    for (const layer of general) {
      if (Object.prototype.hasOwnProperty.call(layer.settings, key)) apply(layer.settings[key]);
    }
    if (opts.languageId) {
      for (const layer of general) {
        const o = layer.overrides[opts.languageId];
        if (o && Object.prototype.hasOwnProperty.call(o, key)) apply(o[key]);
      }
    }
    return value as T | undefined;
  }

  inspect<T = unknown>(key: string, opts: ResolveOptions = {}): Inspection<T> {
    const { folder } = this.chain(opts);
    const own = (l: Layer | undefined) =>
      l && Object.prototype.hasOwnProperty.call(l.settings, key) ? (clone(l.settings[key]) as T) : undefined;
    const lang = (l: Layer | undefined) => {
      if (!l || !opts.languageId) return undefined;
      const o = l.overrides[opts.languageId];
      return o && Object.prototype.hasOwnProperty.call(o, key) ? (clone(o[key]) as T) : undefined;
    };
    const ids = new Set<string>();
    for (const l of [this.defaults, this.user, this.workspace, folder?.layer]) {
      if (!l) continue;
      for (const [id, o] of Object.entries(l.overrides)) if (Object.prototype.hasOwnProperty.call(o, key)) ids.add(id);
    }
    return {
      key,
      defaultValue: own(this.defaults),
      userValue: own(this.user),
      workspaceValue: own(this.workspace),
      workspaceFolderValue: own(folder?.layer),
      defaultLanguageValue: lang(this.defaults),
      userLanguageValue: lang(this.user),
      workspaceLanguageValue: lang(this.workspace),
      workspaceFolderLanguageValue: lang(folder?.layer),
      value: this.get<T>(key, opts),
      languageIds: ids.size ? [...ids] : undefined,
    };
  }

  /** Todas as chaves conhecidas em qualquer camada (para snapshots/diffs). */
  allKeys(): Set<string> {
    const out = new Set<string>();
    for (const l of [this.defaults, this.user, this.workspace, ...this.folders.map((f) => f.layer)]) {
      for (const k of Object.keys(l.settings)) out.add(k);
      for (const o of Object.values(l.overrides)) for (const k of Object.keys(o)) out.add(k);
    }
    return out;
  }

  /** Cópia serializável (ext-host / testes). */
  snapshot(): { defaults: Layer; user: Layer; workspace: Layer; folders: FolderLayer[] } {
    return clone({ defaults: this.defaults, user: this.user, workspace: this.workspace, folders: this.folders });
  }
}

function layerKeys(l: Layer): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(l.settings)) out.set(k, JSON.stringify(v));
  for (const [lang, o] of Object.entries(l.overrides)) for (const [k, v] of Object.entries(o)) out.set(`[${lang}]${k}`, JSON.stringify(v));
  return out;
}

/** Chaves (sem o prefixo de linguagem) que mudaram entre duas camadas. */
export function changedKeys(before: Layer, after: Layer): Set<string> {
  const a = layerKeys(before);
  const b = layerKeys(after);
  const out = new Set<string>();
  const strip = (k: string) => k.replace(/^\[[^\]]+\]/, "");
  for (const [k, v] of a) if (b.get(k) !== v) out.add(strip(k));
  for (const k of b.keys()) if (!a.has(k)) out.add(strip(k));
  return out;
}

/** `affectsConfiguration(section)`: a seção é a chave, um prefixo dela ou uma subchave. */
export function affects(keys: ReadonlySet<string>, section: string): boolean {
  for (const k of keys) {
    if (k === section || k.startsWith(section + ".") || section.startsWith(k + ".")) return true;
  }
  return false;
}
