/**
 * Acrílico (translucidez + desfoque) nos flyouts — menus, Quick Open, Paleta —
 * ligado SÓ quando é seguro: o WebView precisa suportar `backdrop-filter` E
 * efetivamente desenhá-lo. No Linux (WebKitGTK) o filtro é aceito pelo CSS mas
 * some sem composição por GPU, e o código do editor vazaria através do menu —
 * lá a superfície continua opaca. Também respeita `prefers-reduced-transparency`
 * e as settings `fluent.window.acrylicFlyouts` (auto/on/off) e
 * `fluent.ui.reduceTransparency`.
 *
 * Sem a classe `acrylic-flyouts` no <html>, nada muda (fundo opaco do token
 * `--color-surface-flyout`). Ver src/theme/acrylic.css.
 */

import { getPlatform } from "../platform/os.ts";
import { settings } from "../settings/instance.ts";

export interface AcrylicEnv {
  supportsBackdrop: boolean;
  platform: "windows" | "macos" | "linux" | "other";
  reducedTransparency: boolean;
  /** Preferência explícita do usuário (null = automático). */
  preference: "on" | "off" | null;
}

/** Decide se os flyouts podem ficar translúcidos. */
export function acrylicAllowed(env: AcrylicEnv): boolean {
  if (!env.supportsBackdrop) return false; // sem o filtro: translucidez = texto vazando
  if (env.preference === "off") return false;
  if (env.reducedTransparency) return false;
  if (env.preference === "on") return true;
  // Automático: só onde o WebView desenha o filtro de forma confiável.
  return env.platform === "windows" || env.platform === "macos";
}

function detect(): AcrylicEnv {
  const css = typeof CSS !== "undefined" && typeof CSS.supports === "function" ? CSS : null;
  const supportsBackdrop = !!css && (css.supports("backdrop-filter", "blur(2px)") || css.supports("-webkit-backdrop-filter", "blur(2px)"));
  const platform = getPlatform().os;
  let reducedTransparency = false;
  try {
    reducedTransparency = window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches ?? false;
  } catch {
    /* sem suporte à media query */
  }
  const v = settings.get<string>("fluent.window.acrylicFlyouts");
  const preference: AcrylicEnv["preference"] = v === "on" || v === "off" ? v : null;
  if (settings.get<boolean>("fluent.ui.reduceTransparency") === true) reducedTransparency = true;
  return { supportsBackdrop, platform, reducedTransparency, preference };
}

/** Aplica (uma vez, antes do 1º paint) a classe `acrylic-flyouts` no <html>. */
export function applyAcrylicFlyouts(): void {
  try {
    document.documentElement.classList.toggle("acrylic-flyouts", acrylicAllowed(detect()));
  } catch {
    /* fica opaco */
  }
}
