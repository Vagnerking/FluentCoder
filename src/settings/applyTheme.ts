/**
 * `workbench.colorTheme` / `workbench.iconTheme` → registro de temas
 * (`src/theme/registry.ts`): reaplica quando a setting muda (UI, settings.json,
 * watcher). Tema desconhecido cai no padrão sem apagar a setting (o registro
 * cuida disso). Na integração com o registro da frente de temas, ele mesmo
 * observa a setting e este arquivo vira desnecessário.
 */
import { themeRegistry } from "../theme/registry";
import { settings } from "./instance";

let installed = false;

export function installThemeSettings(): void {
  if (installed) return;
  installed = true;
  void themeRegistry.restore("color");
  void themeRegistry.restore("fileIcon");
  settings.onDidChange((e) => {
    if (e.affectsConfiguration("workbench.colorTheme")) void themeRegistry.restore("color");
    if (e.affectsConfiguration("workbench.iconTheme")) void themeRegistry.restore("fileIcon");
  });
}
