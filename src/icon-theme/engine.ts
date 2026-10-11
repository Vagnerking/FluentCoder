/**
 * Motor GENÉRICO de temas de ícones de arquivo (formato do VS Code,
 * `contributes.iconThemes`): o Material Icon Theme embutido é só um provedor
 * deste motor; temas de extensões (vscode-icons, Material de extensão,
 * Seti…) são outros.
 *
 * Ordem de resolução (a mesma especificidade do VS Code):
 *
 * Arquivo: `fileNames` (nome exato, minúsculo) → `fileExtensions` (extensão
 * composta mais longa primeiro: `d.ts` antes de `ts`) → `languageIds` (id da
 * linguagem do arquivo) → `file`.
 *
 * Pasta: raiz do workspace → `rootFolderNames(Expanded)` → `rootFolder(Expanded)`;
 * demais → `folderNamesExpanded` (aberta) → `folderNames` → `folderExpanded`
 * (aberta) → `folder`.
 *
 * Variantes `light`/`highContrast` sobrescrevem chave a chave (tema de cor
 * claro/alto contraste), caindo no mapa base quando não há sobrescrita.
 *
 * Puro (sem Vite/DOM): testado em engine.test.ts.
 */

export interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
}

export interface IconAssociations {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  rootFolder?: string;
  rootFolderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  rootFolderNames?: Record<string, string>;
  rootFolderNamesExpanded?: Record<string, string>;
}

export interface IconFontDefinition {
  id: string;
  src: { path: string; format?: string }[];
  weight?: string;
  style?: string;
  size?: string;
}

export interface IconThemeDocument extends IconAssociations {
  iconDefinitions: Record<string, IconDefinition>;
  light?: IconAssociations;
  highContrast?: IconAssociations;
  fonts?: IconFontDefinition[];
  hidesExplorerArrows?: boolean;
}

export type IconVariant = "dark" | "light" | "highContrast";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function strMap(v: unknown, lower: boolean): Record<string, string> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string" && k !== "__proto__") out[lower ? k.toLowerCase() : k] = x;
  return out;
}

function assoc(v: unknown): IconAssociations {
  if (!isObj(v)) return {};
  const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  return {
    file: s("file"),
    folder: s("folder"),
    folderExpanded: s("folderExpanded"),
    rootFolder: s("rootFolder"),
    rootFolderExpanded: s("rootFolderExpanded"),
    fileExtensions: strMap(v.fileExtensions, true),
    fileNames: strMap(v.fileNames, true),
    languageIds: strMap(v.languageIds, false),
    folderNames: strMap(v.folderNames, true),
    folderNamesExpanded: strMap(v.folderNamesExpanded, true),
    rootFolderNames: strMap(v.rootFolderNames, true),
    rootFolderNamesExpanded: strMap(v.rootFolderNamesExpanded, true),
  };
}

/** Valida/normaliza o JSON de um tema de ícones (chaves minúsculas, só strings). */
export function normalizeIconTheme(raw: unknown): IconThemeDocument {
  if (!isObj(raw)) throw new Error("tema de ícones não é um objeto JSON");
  const defs: Record<string, IconDefinition> = {};
  if (isObj(raw.iconDefinitions)) {
    for (const [k, v] of Object.entries(raw.iconDefinitions)) {
      if (!isObj(v) || k === "__proto__") continue;
      const d: IconDefinition = {};
      for (const f of ["iconPath", "fontCharacter", "fontColor", "fontSize", "fontId"] as const) if (typeof v[f] === "string") d[f] = v[f] as string;
      if (d.iconPath || d.fontCharacter) defs[k] = d;
    }
  }
  const fonts: IconFontDefinition[] = [];
  if (Array.isArray(raw.fonts)) {
    for (const f of raw.fonts) {
      if (!isObj(f) || typeof f.id !== "string" || !Array.isArray(f.src)) continue;
      const src = f.src.filter((x): x is { path: string; format?: string } => isObj(x) && typeof x.path === "string").map((x) => ({ path: x.path, format: typeof x.format === "string" ? x.format : undefined }));
      if (src.length) fonts.push({ id: f.id, src, weight: typeof f.weight === "string" ? f.weight : undefined, style: typeof f.style === "string" ? f.style : undefined, size: typeof f.size === "string" ? f.size : undefined });
    }
  }
  return {
    ...assoc(raw),
    iconDefinitions: defs,
    light: isObj(raw.light) ? assoc(raw.light) : undefined,
    highContrast: isObj(raw.highContrast) ? assoc(raw.highContrast) : undefined,
    fonts,
    hidesExplorerArrows: raw.hidesExplorerArrows === true,
  };
}

/** Último segmento do caminho (aceita `/` e `\`). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Extensões candidatas, da mais longa à mais curta (`a.d.ts` → `d.ts`, `ts`). */
export function extensionCandidates(name: string): string[] {
  const lower = name.toLowerCase();
  const out: string[] = [];
  let from = lower.indexOf(".");
  while (from !== -1) {
    out.push(lower.slice(from + 1));
    from = lower.indexOf(".", from + 1);
  }
  return out.filter(Boolean);
}

type MapKey = "fileExtensions" | "fileNames" | "languageIds" | "folderNames" | "folderNamesExpanded" | "rootFolderNames" | "rootFolderNamesExpanded";
type DefaultKey = "file" | "folder" | "folderExpanded" | "rootFolder" | "rootFolderExpanded";

function overlay(doc: IconThemeDocument, variant: IconVariant): IconAssociations | undefined {
  return variant === "light" ? doc.light : variant === "highContrast" ? doc.highContrast : undefined;
}

const valid = (doc: IconThemeDocument, id: string | undefined) => (id && doc.iconDefinitions[id] ? id : undefined);

function lookup(doc: IconThemeDocument, variant: IconVariant, map: MapKey, key: string): string | undefined {
  return valid(doc, overlay(doc, variant)?.[map]?.[key]) ?? valid(doc, doc[map]?.[key]);
}

function dflt(doc: IconThemeDocument, variant: IconVariant, key: DefaultKey): string | undefined {
  return valid(doc, overlay(doc, variant)?.[key]) ?? valid(doc, doc[key]);
}

/** Ids de linguagem do app que o VS Code chama de outro jeito (para `languageIds`). */
const LANGUAGE_ALIASES: Record<string, string[]> = {
  shell: ["shellscript"],
  cshtml: ["razor", "aspnetcorerazor"],
  aspnetcorerazor: ["razor"],
  plaintext: [],
};

/** Ícone (id de `iconDefinitions`) de um arquivo, ou `undefined` = sem ícone. */
export function resolveFileIcon(doc: IconThemeDocument, pathOrName: string, opts: { variant?: IconVariant; languageId?: string } = {}): string | undefined {
  const variant = opts.variant ?? "dark";
  const name = baseName(pathOrName).toLowerCase();
  const byName = lookup(doc, variant, "fileNames", name);
  if (byName) return byName;
  for (const ext of extensionCandidates(name)) {
    const byExt = lookup(doc, variant, "fileExtensions", ext);
    if (byExt) return byExt;
  }
  if (opts.languageId && opts.languageId !== "plaintext") {
    for (const lang of [opts.languageId, ...(LANGUAGE_ALIASES[opts.languageId] ?? [])]) {
      const byLang = lookup(doc, variant, "languageIds", lang);
      if (byLang) return byLang;
    }
  }
  return dflt(doc, variant, "file");
}

/** Ícone de uma pasta (`root` = raiz do workspace). */
export function resolveFolderIcon(doc: IconThemeDocument, pathOrName: string, opts: { variant?: IconVariant; expanded?: boolean; root?: boolean } = {}): string | undefined {
  const variant = opts.variant ?? "dark";
  const name = baseName(pathOrName).toLowerCase();
  const expanded = !!opts.expanded;
  if (opts.root) {
    const r =
      (expanded ? lookup(doc, variant, "rootFolderNamesExpanded", name) : undefined) ??
      lookup(doc, variant, "rootFolderNames", name) ??
      (expanded ? dflt(doc, variant, "rootFolderExpanded") : undefined) ??
      dflt(doc, variant, "rootFolder");
    if (r) return r;
  }
  return (
    (expanded ? lookup(doc, variant, "folderNamesExpanded", name) : undefined) ??
    lookup(doc, variant, "folderNames", name) ??
    (expanded ? dflt(doc, variant, "folderExpanded") : undefined) ??
    dflt(doc, variant, "folder")
  );
}

/** Como desenhar um ícone resolvido. */
export type IconRender =
  | { kind: "img"; src: string }
  | { kind: "font"; fontFamily: string; character: string; color?: string; size?: string };

/** `\e001` / `\E001` / literal → o caractere (só um code point; nada de CSS cru). */
export function decodeFontCharacter(v: string): string | null {
  const m = /^\\([0-9a-f]{1,6})$/i.exec(v.trim());
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  const chars = [...v];
  return chars.length === 1 ? chars[0] : null;
}
