/**
 * Boot do sistema de configurações no app (Tauri): E/S pelos comandos
 * `settings_*` do Rust (`src-tauri/src/settings.rs`), migração única do
 * `localStorage` e do antigo `ext-host/settings.json`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseJsoncObject } from "./jsonc.ts";
import { settings, settingsRegistry } from "./instance.ts";
import { MIGRATION_FLAG, collectLegacySettings, legacyExtHostValues } from "./migration.ts";
import type { SettingsIO, SettingsPathsInfo } from "./service.ts";

export const tauriSettingsIO: SettingsIO = {
  paths: () => invoke<SettingsPathsInfo>("settings_paths"),
  read: (paths) => invoke<Record<string, string | null>>("settings_read_files", { paths }),
  write: (path, content) => invoke<void>("settings_write_file", { path, content }),
  watch: (paths) => invoke<void>("settings_watch", { paths }),
  onFilesChanged: (cb) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listen<{ paths: string[] }>("settings://changed", (e) => {
      for (const p of e.payload.paths) pending.add(p);
      clearTimeout(timer);
      // Editores salvam em rajadas (tmp + rename): coalesce.
      timer = setTimeout(() => {
        const paths = [...pending];
        pending.clear();
        cb(paths);
      }, 120);
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      unlisten?.();
    };
  },
};

let booting: Promise<void> | null = null;

/** Sobe as settings (idempotente). O app pode renderizar antes: até lá valem os defaults. */
export function bootSettings(): Promise<void> {
  if (booting) return booting;
  booting = (async () => {
    try {
      await settings.init(tauriSettingsIO);
      await migrateLegacy();
    } catch (err) {
      console.error("[settings] falha ao carregar as configurações", err);
    }
  })();
  return booting;
}

async function migrateLegacy(): Promise<void> {
  const paths = settings.settingsPaths;
  if (!paths) return;
  let storage: Storage | null = null;
  try {
    storage = typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    storage = null;
  }
  const userRaw = parseJsoncObject(settings.textOf(paths.userSettings));

  if (storage && storage.getItem(MIGRATION_FLAG) !== "1") {
    const { values, consumed } = collectLegacySettings(storage, settingsRegistry.defaults());
    for (const [key, value] of Object.entries(values)) {
      // Nunca sobrescreve o que o usuário já tem no settings.json.
      if (Object.prototype.hasOwnProperty.call(userRaw, key)) continue;
      await settings.update(key, value, "user").catch((err) => console.warn("[settings] migração", key, err));
    }
    for (const k of consumed) storage.removeItem(k);
    storage.setItem(MIGRATION_FLAG, "1");
  }

  // Overrides antigos do host de extensões → User settings (uma vez; o arquivo vira .bak).
  if (paths.legacyExtHostSettings) {
    const read = await tauriSettingsIO.read([paths.legacyExtHostSettings]).catch(() => ({}) as Record<string, string | null>);
    const text = read[paths.legacyExtHostSettings];
    if (text != null) {
      const values = legacyExtHostValues(parseJsoncObject(text), parseJsoncObject(settings.textOf(paths.userSettings)));
      for (const [key, value] of Object.entries(values)) {
        await settings.update(key, value, "user").catch(() => {});
      }
      await invoke("settings_retire_legacy").catch(() => {});
    }
  }
}
