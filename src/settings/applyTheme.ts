/**
 * Ponte temas ⇄ núcleo de settings. O registro de temas (`src/theme/`) lê e
 * grava `workbench.colorTheme` / `workbench.iconTheme` /
 * `workbench.productIconTheme` (e as demais chaves de `SETTING`) por um
 * adaptador pequeno (`src/theme/settingsAdapter.ts`), que nasce apontando para
 * `localStorage` — `bootThemes()` roda antes de as camadas de settings
 * carregarem. Aqui, com as settings prontas, o adaptador passa a usar o núcleo
 * (camadas usuário/workspace/pasta, settings.json, watcher) e os temas são
 * reaplicados a partir dele. Mudanças pela UI de Configurações, pelo JSON ou
 * por outra janela chegam ao registro pelo `onDidChange` do adaptador.
 */
import { themeRegistry } from "../theme/registry";
import { setSettingsBackend } from "../theme/settingsAdapter";
import { getSetting, settings } from "./instance";

let installed = false;

export function installThemeSettings(): void {
  if (installed) return;
  installed = true;
  setSettingsBackend({
    get: (key) => getSetting(key),
    // Escolhas de tema são preferências do usuário (como no VS Code).
    set: (key, value) => void settings.update(key, value, "user").catch(() => {}),
    onDidChange: (listener) =>
      settings.onDidChange((e) => {
        for (const key of e.keys) listener(key);
      }),
  });
  for (const kind of ["color", "fileIcon", "productIcon"] as const) {
    void themeRegistry.restore(kind).catch(() => {});
  }
}
