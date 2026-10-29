/**
 * Instâncias únicas do registro e do serviço de configurações.
 *
 * Puro: sem Tauri. Antes de `settings.init(io)` (feito no boot do app, ver
 * `bootstrap.ts`) o serviço responde só com os defaults — o que também vale
 * para os testes `node --test` que importam módulos que leem settings.
 */
import { CORE_SETTINGS } from "./coreSettings.ts";
import { SettingsRegistry } from "./registry.ts";
import { SettingsService } from "./service.ts";

export const settingsRegistry = new SettingsRegistry();
settingsRegistry.register(CORE_SETTINGS);

export const settings = new SettingsService(settingsRegistry, null);

/** Lê uma setting (atalho). */
export function getSetting<T = unknown>(key: string, opts?: { resource?: string | null; languageId?: string | null }): T {
  return settings.get<T>(key, opts);
}
