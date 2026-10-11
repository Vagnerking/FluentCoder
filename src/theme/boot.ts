/**
 * Boot dos temas e das contribuições declarativas de extensões. Chamado uma
 * vez em `main.tsx`, ANTES do 1º render:
 *
 * 1. reaplica o tema de cor do cache (tokens da UI já no 1º paint);
 * 2. registra os motores no `themeRegistry` (sem aplicar ainda);
 * 3. lê a lista de extensões (modo somente contribuições) e então aplica os
 *    temas salvos — que podem ser de extensões.
 */
import { reloadExtensionContributions } from "../extensions/contributions/source";
import { applyCachedColorTheme, startColorThemes } from "./colorThemeService";
import { themeRegistry, type ThemeKind } from "./registry";
import { startFileIconThemes } from "../icon-theme/iconThemeService";
import { startProductIconThemes } from "../icons/productIconTheme";

let booted = false;
const kinds: ThemeKind[] = [];

/** Liga um motor; com `kind`, o tema salvo dele é aplicado depois da lista de extensões. */
function step(start: () => void, kind?: ThemeKind): void {
  try {
    start();
    if (kind) kinds.push(kind);
  } catch (err) {
    console.error("Falha ao iniciar motor de temas:", err);
  }
}

export function bootThemes(): void {
  if (booted) return;
  booted = true;
  applyCachedColorTheme();
  step(startColorThemes, "color");
  step(startFileIconThemes, "fileIcon");
  step(startProductIconThemes, "productIcon");
  void reloadExtensionContributions().finally(() => {
    for (const k of kinds) void themeRegistry.restore(k).catch(() => {});
  });
}
