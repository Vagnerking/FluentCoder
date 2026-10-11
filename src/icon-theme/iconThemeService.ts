/**
 * Temas de ícones de ARQUIVO no `themeRegistry` (kind `fileIcon`, setting
 * `workbench.iconTheme`): o Material Icon Theme embutido (padrão), "Nenhum" e
 * os `contributes.iconThemes` das extensões (modo somente contribuições).
 *
 * Ícones de extensão: SVG/PNG da pasta da extensão pelo protocolo `fcext`
 * (Rust: realpath, tetos, SVG sanitizado) e SEMPRE via `<img>` — nunca SVG
 * inline no DOM. Ícones por fonte (`fonts` + `fontCharacter`, ex.: Seti):
 * `@font-face` gerado com a fonte da extensão (woff/woff2/ttf ≤ 2 MB).
 *
 * Explorer, abas, breadcrumbs, Quick Open, busca e Git usam `<FileIcon>`, que
 * lê daqui (`useFileIconTheme`).
 */
import { useSyncExternalStore } from "react";
import { materialConfig } from "./material/material-config";
import { iconUrl as materialIconUrl } from "./material/icon-assets";
import { normalizeIconTheme, decodeFontCharacter, resolveFileIcon, resolveFolderIcon, type IconRender, type IconThemeDocument, type IconVariant } from "./engine";
import { getContributingExtensions, onDidChangeContributions, readExtensionFile, extensionAsset, contributionsLog, type ContributingExtension } from "../extensions/contributions/source";
import { normalizeInside, resolveFrom } from "../extensions/contributions/paths";
import { parseJsonc } from "../extensions/contributions/jsonc";
import { normalizeColor } from "../theme/colors";
import { notifyThemeListChanged, registerThemeProvider, type ThemeEntry } from "../theme/registry";
import { getActiveColorTheme, onDidChangeActiveColorTheme } from "../theme/activeTheme";
import { languageForFile } from "../language";

export const MATERIAL_ID = "material-icon-theme";
export const NONE_ID = "Nenhum";

export interface ActiveFileIconTheme {
  id: string;
  /** `null` = sem ícones ("Nenhum"). */
  doc: IconThemeDocument | null;
  render(defId: string): IconRender | null;
  hidesExplorerArrows: boolean;
}

interface ExtIconThemeRef {
  ext: ContributingExtension;
  path: string;
  label: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

let extThemes = new Map<string, ExtIconThemeRef>();

function collect(): Map<string, ExtIconThemeRef> {
  const out = new Map<string, ExtIconThemeRef>();
  for (const ext of getContributingExtensions()) {
    const c = isObj(ext.manifest.contributes) ? ext.manifest.contributes : {};
    if (!Array.isArray(c.iconThemes)) continue;
    for (const t of c.iconThemes) {
      if (!isObj(t) || typeof t.id !== "string" || typeof t.path !== "string") continue;
      const path = normalizeInside(t.path);
      // O mesmo id do embutido (PKief.material-icon-theme instalada) SUBSTITUI o
      // embutido: vale a versão da extensão, que pode ser mais nova.
      if (!path || t.id === NONE_ID || out.has(t.id)) continue;
      const label = typeof t.label === "string" && !/^%.*%$/.test(t.label) ? t.label : t.id;
      out.set(t.id, { ext, path, label });
    }
  }
  return out;
}

function entries(): ThemeEntry[] {
  const list: ThemeEntry[] = [
    ...(extThemes.has(MATERIAL_ID) ? [] : [{ kind: "fileIcon" as const, id: MATERIAL_ID, label: "Material Icon Theme", origin: { type: "builtin" as const }, description: "embutido" }]),
    { kind: "fileIcon", id: NONE_ID, label: "Nenhum", origin: { type: "builtin" }, description: "sem ícones de arquivo" },
  ];
  for (const [id, r] of extThemes) list.push({ kind: "fileIcon", id, label: r.label, origin: { type: "extension", extensionId: r.ext.id, extensionName: r.ext.displayName } });
  return list;
}

// ------------------------------------------------------------------ provedores

let materialDoc: IconThemeDocument | null = null;

function materialTheme(): ActiveFileIconTheme {
  materialDoc = materialDoc ?? normalizeIconTheme(materialConfig);
  return {
    id: MATERIAL_ID,
    doc: materialDoc,
    render: (defId) => {
      const src = materialIconUrl(defId);
      return src ? { kind: "img", src } : null;
    },
    hidesExplorerArrows: false,
  };
}

const NONE: ActiveFileIconTheme = { id: NONE_ID, doc: null, render: () => null, hidesExplorerArrows: false };

const FONT_STYLE_ID = "fc-icon-theme-fonts";
const SIZE = /^\d+(\.\d+)?(px|%|em|rem)$/;

function setFontFaces(css: string): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(FONT_STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = FONT_STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

async function loadExtensionTheme(id: string, ref: ExtIconThemeRef): Promise<{ theme: ActiveFileIconTheme; fontCss: string }> {
  const text = await readExtensionFile(ref.ext, ref.path);
  const doc = normalizeIconTheme(parseJsonc(text, { maxDepth: 16 }));
  const families = new Map<string, string>();
  const faces: string[] = [];
  (doc.fonts ?? []).forEach((f, i) => {
    const family = `fc-icon-font-${i}-${ref.ext.id.replace(/[^a-z0-9]/gi, "")}`;
    const srcs = f.src
      .map((s) => {
        const rel = resolveFrom(ref.path, s.path);
        if (!rel || !/\.(woff2?|ttf|otf)$/i.test(rel)) return null;
        const url = extensionAsset(ref.ext.id, rel);
        const format = (s.format ?? "").replace(/[^a-z0-9-]/gi, "");
        return url ? `url("${url}")${format ? ` format("${format}")` : ""}` : null;
      })
      .filter(Boolean);
    if (!srcs.length) return;
    families.set(f.id, family);
    const weight = /^(normal|bold|\d{3})$/.test(f.weight ?? "") ? f.weight : "normal";
    const style = /^(normal|italic|oblique)$/.test(f.style ?? "") ? f.style : "normal";
    faces.push(`@font-face{font-family:"${family}";src:${srcs.join(",")};font-weight:${weight};font-style:${style};font-display:block}`);
  });
  const firstFamily = families.values().next().value as string | undefined;
  const urlCache = new Map<string, IconRender | null>();
  const theme: ActiveFileIconTheme = {
    id,
    doc,
    hidesExplorerArrows: !!doc.hidesExplorerArrows,
    render(defId) {
      if (urlCache.has(defId)) return urlCache.get(defId)!;
      const def = doc.iconDefinitions[defId];
      let out: IconRender | null = null;
      if (def?.iconPath) {
        const rel = resolveFrom(ref.path, def.iconPath);
        const src = rel && /\.(svg|png|jpe?g|gif|webp)$/i.test(rel) ? extensionAsset(ref.ext.id, rel) : null;
        out = src ? { kind: "img", src } : null;
      } else if (def?.fontCharacter) {
        const family = (def.fontId ? families.get(def.fontId) : undefined) ?? firstFamily;
        const character = decodeFontCharacter(def.fontCharacter);
        if (family && character)
          out = {
            kind: "font",
            fontFamily: family,
            character,
            color: normalizeColor(def.fontColor) ?? undefined,
            size: def.fontSize && SIZE.test(def.fontSize) ? def.fontSize : undefined,
          };
      }
      urlCache.set(defId, out);
      return out;
    },
  };
  return { theme, fontCss: faces.join("\n") };
}

const loaded = new Map<string, Promise<{ theme: ActiveFileIconTheme; fontCss: string }>>();

// ------------------------------------------------------------------ estado

let active: ActiveFileIconTheme = materialTheme();
let variant: IconVariant = variantOf(getActiveColorTheme().kind);
let version = 0;
const listeners = new Set<() => void>();
const resolved = new Map<string, IconRender | null>();

function variantOf(kind: string): IconVariant {
  return kind === "light" || kind === "high-contrast-light" ? "light" : kind === "high-contrast" ? "highContrast" : "dark";
}

function changed(): void {
  version++;
  resolved.clear();
  for (const l of [...listeners]) l();
}

onDidChangeActiveColorTheme((t) => {
  const v = variantOf(t.kind);
  if (v !== variant) {
    variant = v;
    changed();
  }
});

async function applyEntry(entry: ThemeEntry): Promise<void> {
  if (entry.id === MATERIAL_ID && !extThemes.has(MATERIAL_ID)) {
    setFontFaces("");
    active = materialTheme();
    changed();
    return;
  }
  if (entry.id === NONE_ID) {
    setFontFaces("");
    active = NONE;
    changed();
    return;
  }
  const ref = extThemes.get(entry.id);
  if (!ref) throw new Error(`tema de ícones ${entry.id} indisponível`);
  const key = `${ref.ext.id}@${ref.ext.version}:${ref.path}`;
  let p = loaded.get(key);
  if (!p) {
    p = loadExtensionTheme(entry.id, ref);
    loaded.set(key, p);
    p.catch((err) => {
      loaded.delete(key);
      contributionsLog(`tema de ícones "${entry.label}" (${ref.ext.id}) não pôde ser carregado: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  const { theme, fontCss } = await p;
  setFontFaces(fontCss);
  active = theme;
  changed();
}

let started = false;

export function startFileIconThemes(): void {
  if (started) return;
  started = true;
  extThemes = collect();
  void registerThemeProvider({ kind: "fileIcon", defaultId: MATERIAL_ID, entries, applyEntry }, { initialApply: false });
  onDidChangeContributions(() => {
    extThemes = collect();
    changed(); // linguagens contribuídas mudam o `languageIds`
    notifyThemeListChanged("fileIcon");
  });
}

// ------------------------------------------------------------------ consumo

export interface FileIconQuery {
  path: string;
  isDir?: boolean;
  expanded?: boolean;
  isRoot?: boolean;
  /** Força a variante (senão segue o tema de cor ativo). */
  variant?: IconVariant;
}

/** Ícone para um arquivo/pasta no tema ativo (cache até trocar de tema). */
export function resolveIconRender(q: FileIconQuery): IconRender | null {
  const doc = active.doc;
  if (!doc) return null;
  const v = q.variant ?? variant;
  const name = (q.path.split(/[\\/]/).pop() || q.path).toLowerCase();
  const k = `${v}|${q.isDir ? (q.isRoot ? "r" : "d") : "f"}|${q.expanded ? 1 : 0}|${name}`;
  if (resolved.has(k)) return resolved.get(k)!;
  const id = q.isDir
    ? resolveFolderIcon(doc, q.path, { variant: v, expanded: q.expanded, root: q.isRoot })
    : resolveFileIcon(doc, name, { variant: v, languageId: languageForFile(name) });
  const out = id ? active.render(id) : null;
  if (resolved.size > 5000) resolved.clear();
  resolved.set(k, out);
  return out;
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const snapshot = () => version;

/** Re-renderiza quando o tema de ícones (ou a variante clara/escura) muda. */
export function useFileIconTheme(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function getActiveFileIconTheme(): ActiveFileIconTheme {
  return active;
}
