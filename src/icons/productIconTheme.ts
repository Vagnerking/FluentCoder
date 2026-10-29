/**
 * Temas de ícones de PRODUTO (kind `productIcon`, setting
 * `workbench.productIconTheme`) — melhor esforço: troca os glifos dos codicons
 * por CSS gerado (`productIconCss.ts`) com a fonte da extensão servida pelo
 * protocolo `fcext` (woff/woff2/ttf/otf ≤ 2 MB). "Padrão" = Codicons.
 */
import { getContributingExtensions, onDidChangeContributions, readExtensionFile, extensionAsset, contributionsLog, type ContributingExtension } from "../extensions/contributions/source";
import { normalizeInside, resolveFrom } from "../extensions/contributions/paths";
import { parseJsonc } from "../extensions/contributions/jsonc";
import { notifyThemeListChanged, registerThemeProvider, type ThemeEntry } from "../theme/registry";
import { normalizeProductIconTheme, productIconCss } from "./productIconCss";

export const DEFAULT_PRODUCT_ICON_THEME = "Default";
const STYLE_ID = "fc-product-icon-theme";

interface Ref {
  ext: ContributingExtension;
  path: string;
  label: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
let refs = new Map<string, Ref>();

function collect(): Map<string, Ref> {
  const out = new Map<string, Ref>();
  for (const ext of getContributingExtensions()) {
    const c = isObj(ext.manifest.contributes) ? ext.manifest.contributes : {};
    if (!Array.isArray(c.productIconThemes)) continue;
    for (const t of c.productIconThemes) {
      if (!isObj(t) || typeof t.id !== "string" || typeof t.path !== "string") continue;
      const path = normalizeInside(t.path);
      if (!path || t.id === DEFAULT_PRODUCT_ICON_THEME || out.has(t.id)) continue;
      out.set(t.id, { ext, path, label: typeof t.label === "string" && !/^%.*%$/.test(t.label) ? t.label : t.id });
    }
  }
  return out;
}

function entries(): ThemeEntry[] {
  const list: ThemeEntry[] = [{ kind: "productIcon", id: DEFAULT_PRODUCT_ICON_THEME, label: "Padrão (Codicons)", origin: { type: "builtin" } }];
  for (const [id, r] of refs) list.push({ kind: "productIcon", id, label: r.label, origin: { type: "extension", extensionId: r.ext.id, extensionName: r.ext.displayName } });
  return list;
}

function setCss(css: string): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) return void el?.remove();
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

async function applyEntry(entry: ThemeEntry): Promise<void> {
  if (entry.id === DEFAULT_PRODUCT_ICON_THEME) return setCss("");
  const ref = refs.get(entry.id);
  if (!ref) throw new Error(`tema de ícones de produto ${entry.id} indisponível`);
  try {
    const doc = normalizeProductIconTheme(parseJsonc(await readExtensionFile(ref.ext, ref.path)));
    const { css, icons } = productIconCss(
      doc,
      (p) => {
        const rel = resolveFrom(ref.path, p);
        return rel ? extensionAsset(ref.ext.id, rel) : null;
      },
      `fc-product-${ref.ext.id.replace(/[^a-z0-9]/gi, "")}`,
    );
    setCss(css);
    contributionsLog(`ícones de produto "${entry.label}": ${icons} codicons substituídos.`);
  } catch (err) {
    contributionsLog(`ícones de produto "${entry.label}" (${ref.ext.id}) não puderam ser aplicados: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

let started = false;

export function startProductIconThemes(): void {
  if (started) return;
  started = true;
  refs = collect();
  void registerThemeProvider({ kind: "productIcon", defaultId: DEFAULT_PRODUCT_ICON_THEME, entries, applyEntry }, { initialApply: false });
  onDidChangeContributions(() => {
    refs = collect();
    notifyThemeListChanged("productIcon");
  });
}
