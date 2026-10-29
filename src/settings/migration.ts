/**
 * Migração única das preferências antigas do `localStorage` para o
 * `User/settings.json`.
 *
 * REGRA (ver `docs/context/configuracoes.md`): vira SETTING o que é
 * preferência do usuário e faz sentido versionar/compartilhar (fonte, tema,
 * posição da sidebar, format on save…). Fica no `localStorage` o ESTADO de UI
 * por janela/visualizador — tamanhos de painéis, `ui.viewLayout`, ordem da
 * activity bar, seções recolhidas, toggles da caixa de busca, pastas recentes,
 * último alvo SSH, último agente/modelo do chat, posições do grafo e caches.
 *
 * Puro (storage injetado) para os testes.
 */

export const MIGRATION_FLAG = "settings.migrated.v1";

type Reader = Pick<Storage, "getItem">;

interface Rule {
  legacy: string;
  key: string;
  read: (raw: string) => unknown;
}

const flag = (raw: string) => (raw === "1" ? true : raw === "0" ? false : undefined);
const json = (raw: string) => {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
};
const num = (raw: string) => {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? n : undefined;
};
const oneOf =
  (...values: string[]) =>
  (raw: string) =>
    values.includes(raw) ? raw : undefined;

/** Chaves antigas → settings (chaves VS Code quando existem). */
export const LEGACY_RULES: readonly Rule[] = [
  { legacy: "editor.formatOnSave", key: "editor.formatOnSave", read: flag },
  { legacy: "csharp.inlayHints", key: "csharp.inlayHints.enabled", read: flag },
  { legacy: "lsp.ts.preferEditor", key: "fluent.typescript.preferEditorVersion", read: flag },
  { legacy: "lsp.razorProjection", key: "fluent.razor.projection", read: flag },
  { legacy: "lsp.diagToFile", key: "fluent.lsp.logToFile", read: flag },
  { legacy: "files.exclude", key: "files.exclude", read: json },
  { legacy: "search.exclude", key: "search.exclude", read: json },
  { legacy: "fluent.quickOpen.maxFiles", key: "fluent.quickOpen.maxFiles", read: num },
  { legacy: "git.autofetch", key: "git.autofetch", read: (raw) => (raw === "off" ? false : raw === "on" ? true : undefined) },
  { legacy: "git.avatars", key: "git.avatars", read: oneOf("github", "gravatar", "off") },
  { legacy: "git.repositoryScanMaxDepth", key: "git.repositoryScanMaxDepth", read: num },
  { legacy: "ui.sidebarSide", key: "workbench.sideBar.location", read: oneOf("left", "right") },
  { legacy: "ui.activityBarPos", key: "workbench.activityBar.location", read: oneOf("side", "right", "top", "bottom") },
  { legacy: "ui.panelPos", key: "workbench.panel.defaultLocation", read: oneOf("bottom", "left", "right") },
  { legacy: "ui.scale", key: "fluent.ui.scale", read: num },
  { legacy: "ui.acrylicFlyouts", key: "fluent.window.acrylicFlyouts", read: oneOf("on", "off") },
];

export interface MigrationResult {
  /** Valores a gravar no User settings (só os diferentes do default). */
  values: Record<string, unknown>;
  /** Chaves antigas consumidas (a remover do `localStorage`). */
  consumed: string[];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function collectLegacySettings(
  storage: Reader,
  defaults: Record<string, unknown>,
): MigrationResult {
  const values: Record<string, unknown> = {};
  const consumed: string[] = [];
  for (const rule of LEGACY_RULES) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(rule.legacy);
    } catch {
      raw = null;
    }
    if (raw == null) continue;
    consumed.push(rule.legacy);
    const v = rule.read(raw);
    if (v === undefined) continue;
    const def = defaults[rule.key];
    // Objetos (`files.exclude`): grava só o que difere do default.
    if (v && typeof v === "object" && def && typeof def === "object") {
      const diff: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!same((def as Record<string, unknown>)[k], val)) diff[k] = val;
      }
      if (Object.keys(diff).length) values[rule.key] = diff;
      continue;
    }
    if (!same(def, v)) values[rule.key] = v;
  }
  return { values, consumed };
}

/** Overrides do antigo `<app_data>/ext-host/settings.json` que ainda não existem no User. */
export function legacyExtHostValues(
  legacy: Record<string, unknown>,
  user: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(user, k)) out[k] = v;
  }
  return out;
}
