/**
 * Aplica as settings de aparência/acessibilidade/abas do workbench no `<html>`
 * (atributos `data-*` + variáveis CSS), consumidos por `styles/settings.css`.
 * Uma assinatura só, fora do React: mudar o tamanho da fonte da UI não
 * re-renderiza o App.
 */
import { fontStacks } from "../platform/fonts.ts";
import { settings } from "./instance.ts";

/** Atributos/variáveis a aplicar (puro, para teste). */
export function workbenchAttributes(
  get: (key: string) => unknown,
  env: { prefersReducedMotion: boolean; prefersContrast: boolean },
): { attrs: Record<string, string | null>; vars: Record<string, string | null> } {
  const tri = (key: string, sys: boolean) => {
    const v = get(key);
    return v === "on" || (v !== "off" && sys);
  };
  const uiSize = Number(get("fluent.ui.fontSize"));
  const size = Number.isFinite(uiSize) && uiSize >= 10 && uiSize <= 20 ? uiSize : 13;
  const uiFont = String(get("fluent.ui.fontFamily") ?? "").trim();
  return {
    attrs: {
      "data-reduce-motion": tri("workbench.reduceMotion", env.prefersReducedMotion) ? "on" : null,
      "data-high-contrast": tri("fluent.accessibility.highContrast", env.prefersContrast) ? "on" : null,
      "data-focus-outline": get("fluent.accessibility.focusOutline") === true ? "strong" : null,
      "data-reduce-transparency": get("fluent.ui.reduceTransparency") === true ? "on" : null,
      "data-density": get("fluent.ui.density") === "compact" || get("fluent.ui.density") === "spacious" ? String(get("fluent.ui.density")) : null,
      "data-statusbar": get("workbench.statusBar.visible") === false ? "hidden" : null,
      "data-show-tabs": get("workbench.editor.showTabs") === "multiple" ? null : String(get("workbench.editor.showTabs")),
      "data-tab-close": get("workbench.editor.tabActionLocation") === "left" ? "left" : null,
      "data-tab-sizing": get("workbench.editor.tabSizing") === "fit" ? null : String(get("workbench.editor.tabSizing")),
      "data-tabs-wrap": get("workbench.editor.wrapTabs") === true ? "on" : null,
      "data-highlight-modified": get("workbench.editor.highlightModifiedTabs") === true ? "on" : null,
      "data-ui-font": size !== 13 || uiFont ? "custom" : null,
    },
    vars: {
      "--font-base": size === 13 ? null : `${size}px`,
      "--line-height-base": size === 13 ? null : `${Math.round(size * 1.4)}px`,
      "--font-ui": uiFont ? `${uiFont}, ${fontStacks().ui}` : null,
    },
  };
}

function media(query: string): MediaQueryList | null {
  try {
    return window.matchMedia?.(query) ?? null;
  } catch {
    return null;
  }
}

let installed = false;

export function installWorkbenchSettings(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const motion = media("(prefers-reduced-motion: reduce)");
  const contrast = media("(prefers-contrast: more)");
  const apply = () => {
    const { attrs, vars } = workbenchAttributes((k) => settings.get(k), {
      prefersReducedMotion: !!motion?.matches,
      prefersContrast: !!contrast?.matches,
    });
    const root = document.documentElement;
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) root.removeAttribute(k);
      else root.setAttribute(k, v);
    }
    for (const [k, v] of Object.entries(vars)) {
      if (v == null) root.style.removeProperty(k);
      else root.style.setProperty(k, v);
    }
  };
  apply();
  settings.onDidChange(apply);
  motion?.addEventListener?.("change", apply);
  contrast?.addEventListener?.("change", apply);
}
