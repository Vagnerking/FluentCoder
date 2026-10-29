/**
 * Ponte settings ⇄ host de extensões (ConfigurationStore do sidecar):
 *
 * - `configuration` (app → host): snapshot das camadas (default/user/
 *   workspace/pastas) logo após o `initialize` — antes de qualquer extensão
 *   ativar — e a cada mudança; o host dispara `onDidChangeConfiguration`;
 * - `configurationUpdate` (host → app): `update()` de uma extensão, gravado na
 *   camada pedida pelo `SettingsService`;
 * - `contributes.configuration` das extensões liberadas entra no registro (UI
 *   de Configurações, schema do settings.json).
 */
import { extHost } from "../extensions/client";
import type { HostEvent, InstalledExtension } from "../extensions/protocol";
import { settings, settingsRegistry } from "./instance";
import type { Layer } from "./model";

export interface HostConfigurationSnapshot {
  defaults: Layer;
  user: Layer;
  workspace: Layer;
  folders: { root: string; layer: Layer }[];
  hasWorkspace: boolean;
}

export function hostConfigurationSnapshot(): HostConfigurationSnapshot {
  const snap = settings.model.snapshot();
  return { ...snap, hasWorkspace: settings.workspaceDescriptor.mode !== "empty" };
}

/** Registra/remove as settings contribuídas pelas extensões liberadas. */
export function syncExtensionConfigurations(list: readonly InstalledExtension[]): void {
  const live = new Set<string>();
  for (const ext of list) {
    if (!ext.supported || !ext.contributes) continue;
    live.add(ext.id);
    settingsRegistry.registerExtension(ext.id, ext.label || ext.displayName, { contributes: ext.contributes });
  }
  const stale = new Set(settingsRegistry.all().map((s) => s.source).filter((s) => s !== "core" && !live.has(s)));
  for (const id of stale) settingsRegistry.unregisterExtension(id);
}

let installed = false;

export function installExtHostSettingsBridge(): void {
  if (installed) return;
  installed = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = () => {
    if (!extHost.info) return;
    clearTimeout(timer);
    timer = setTimeout(() => void extHost.notify("configuration", hostConfigurationSnapshot()).catch(() => {}), 30);
  };

  extHost.onInitialized(async (info) => {
    syncExtensionConfigurations(info.extensions);
    await extHost.notify("configuration", hostConfigurationSnapshot());
  });
  settings.onDidChange(push);
  extHost.on((ev) => {
    if (ev.event === "installedChanged") {
      syncExtensionConfigurations(extHost.info?.extensions ?? []);
      return;
    }
    if (ev.event !== "configurationUpdate") return;
    const u = ev as Extract<HostEvent, { event: "configurationUpdate" }>;
    const target = u.target === "folder" || u.target === "workspace" ? u.target : "user";
    const allowed = settings.availableTargets().includes(target) ? target : "user";
    void settings
      .update(u.key, u.value, allowed, {
        resource: u.resource ?? null,
        languageId: u.languageId ?? null,
        overrideInLanguage: !!u.languageId,
      })
      .catch((err) => {
        console.warn("[settings] update de extensão recusado", u.key, err);
        // Devolve o estado real (o host aplicou o update de forma otimista).
        push();
      });
  });
}
