/**
 * `workbench.colorTheme` / `workbench.iconTheme` → registro de temas
 * (`src/theme/registry.ts`). Reaplica quando a setting muda e quando um
 * provedor novo aparece (ex.: tema de extensão instalado depois do boot).
 * Tema desconhecido cai no padrão sem apagar a setting (a extensão pode só
 * não ter carregado ainda).
 */
import { DEFAULT_COLOR_THEME, DEFAULT_ICON_THEME, themeRegistry } from "../theme/registry";
import { settings } from "./instance";

let installed = false;

export function installThemeSettings(): void {
  if (installed) return;
  installed = true;
  let lastColor: string | null = null;
  let lastIcon: string | null | undefined;
  const apply = (force = false) => {
    const color = String(settings.get("workbench.colorTheme") || DEFAULT_COLOR_THEME);
    if (force || color !== lastColor) {
      lastColor = color;
      void themeRegistry.applyColorTheme(color).then((ok) => {
        if (!ok && color !== DEFAULT_COLOR_THEME) void themeRegistry.applyColorTheme(DEFAULT_COLOR_THEME);
      });
    }
    const rawIcon = settings.get<string | null>("workbench.iconTheme");
    const icon = rawIcon === null ? null : String(rawIcon || DEFAULT_ICON_THEME);
    if (force || icon !== lastIcon) {
      lastIcon = icon;
      void themeRegistry.applyIconTheme(icon).then((ok) => {
        if (!ok && icon !== DEFAULT_ICON_THEME) void themeRegistry.applyIconTheme(DEFAULT_ICON_THEME);
      });
    }
  };
  apply(true);
  settings.onDidChange((e) => {
    if (e.affectsConfiguration("workbench.colorTheme") || e.affectsConfiguration("workbench.iconTheme")) apply();
  });
  themeRegistry.onDidChange(() => apply(true));
}
