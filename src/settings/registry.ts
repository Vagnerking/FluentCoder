/**
 * Registro (schema) das configurações — fonte única para a UI de
 * Configurações, o JSON Schema do `settings.json`, o Monaco e o host de
 * extensões. Mesmo shape do `contributes.configuration` do VS Code: as
 * settings do core são declaradas em `coreSettings.ts`; as das extensões
 * entram por `registerExtensionConfiguration`.
 *
 * Puro (sem DOM/Tauri): testável com `node --test`.
 */

export type SettingType = "boolean" | "string" | "number" | "integer" | "array" | "object" | "null";

/**
 * Escopo (como no VS Code):
 * - `application`: só no Usuário (ex.: auto-update de extensões);
 * - `window`: Usuário ou Workspace (layout, tema…);
 * - `resource`: também por Pasta (`.vscode/settings.json` de cada raiz);
 * - `language-overridable`: por Pasta e por linguagem (`"[typescript]": {…}`).
 */
export type SettingScope = "application" | "machine" | "window" | "resource" | "language-overridable";

/** Categorias da árvore da UI (ordem = ordem de exibição). */
export const SETTING_CATEGORIES = [
  { id: "editor", label: "Editor" },
  { id: "appearance", label: "Aparência e Temas" },
  { id: "font", label: "Fonte" },
  { id: "accessibility", label: "Acessibilidade" },
  { id: "tabs", label: "Abas" },
  { id: "files", label: "Arquivos" },
  { id: "search", label: "Busca" },
  { id: "terminal", label: "Terminal" },
  { id: "git", label: "Git" },
  { id: "extensions", label: "Extensões" },
  { id: "agents", label: "Agentes de IA" },
  { id: "window", label: "Janela" },
  { id: "languages", label: "Linguagens" },
] as const;

export type SettingCategory = (typeof SETTING_CATEGORIES)[number]["id"];

export interface SettingSchema {
  key: string;
  type: SettingType | SettingType[];
  default: unknown;
  /** Descrição em pt-BR (texto simples; `markdownDescription` das extensões vira texto). */
  description: string;
  /** Título curto exibido na UI (derivado da chave quando omitido). */
  title?: string;
  enum?: readonly (string | number | boolean | null)[];
  /** Rótulos pt-BR dos valores do enum (mesma ordem). */
  enumLabels?: readonly string[];
  enumDescriptions?: readonly string[];
  minimum?: number;
  maximum?: number;
  /** Itens de array (para validação simples). */
  items?: { type?: SettingType | SettingType[]; enum?: readonly unknown[] };
  scope: SettingScope;
  category: SettingCategory;
  tags?: readonly string[];
  /** Ordem dentro da categoria. */
  order?: number;
  /** `core` ou o id da extensão que contribuiu. */
  source: string;
  /** Nome da extensão (para "Extensões › <nome>" na árvore). */
  sourceLabel?: string;
  deprecationMessage?: string;
  /** Editor de UI preferido. `color` → seletor de cor; `json` → só no settings.json. */
  editor?: "color" | "json" | "multiline";
  /** Settings que a UI só mostra mas o app aplica em outro lugar (documentação). */
  appliedBy?: string;
}

type Listener = () => void;

/** `contributes.configuration` de uma extensão (subset que usamos). */
export interface ContributedConfiguration {
  title?: string;
  order?: number;
  properties?: Record<string, Record<string, unknown>>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Texto sem markdown básico (`**`, `` ` ``, links) para descrições. */
export function plainDescription(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`#?([^`]+)#?`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function defaultForType(type: SettingType | SettingType[]): unknown {
  const t = Array.isArray(type) ? type[0] : type;
  switch (t) {
    case "boolean":
      return false;
    case "number":
    case "integer":
      return 0;
    case "string":
      return "";
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

const SCOPES = new Set(["application", "machine", "window", "resource", "language-overridable", "machine-overridable"]);

/** Converte uma propriedade de `contributes.configuration` para o nosso schema. */
export function schemaFromContribution(
  key: string,
  prop: Record<string, unknown>,
  source: string,
  sourceLabel?: string,
  order = 0,
): SettingSchema {
  const rawType = prop.type as SettingType | SettingType[] | undefined;
  const type: SettingType | SettingType[] = rawType ?? (prop.enum ? "string" : "object");
  const desc =
    typeof prop.description === "string"
      ? prop.description
      : typeof prop.markdownDescription === "string"
        ? plainDescription(prop.markdownDescription)
        : "";
  const rawScope = typeof prop.scope === "string" && SCOPES.has(prop.scope) ? prop.scope : "window";
  const scope = (rawScope === "machine-overridable" ? "machine" : rawScope) as SettingScope;
  const enumDescriptions = Array.isArray(prop.enumDescriptions)
    ? (prop.enumDescriptions as unknown[]).map((d) => String(d ?? ""))
    : Array.isArray(prop.markdownEnumDescriptions)
      ? (prop.markdownEnumDescriptions as unknown[]).map((d) => plainDescription(String(d ?? "")))
      : undefined;
  return {
    key,
    type,
    default: Object.prototype.hasOwnProperty.call(prop, "default") ? prop.default : defaultForType(type),
    description: desc,
    enum: Array.isArray(prop.enum) ? (prop.enum as (string | number | boolean | null)[]) : undefined,
    enumDescriptions,
    enumLabels: Array.isArray(prop.enumItemLabels) ? (prop.enumItemLabels as unknown[]).map(String) : undefined,
    minimum: typeof prop.minimum === "number" ? prop.minimum : undefined,
    maximum: typeof prop.maximum === "number" ? prop.maximum : undefined,
    items: isObj(prop.items) ? (prop.items as SettingSchema["items"]) : undefined,
    scope,
    category: "extensions",
    tags: Array.isArray(prop.tags) ? (prop.tags as unknown[]).map(String) : undefined,
    order: typeof prop.order === "number" ? prop.order : order,
    source,
    sourceLabel,
    deprecationMessage:
      typeof prop.deprecationMessage === "string"
        ? prop.deprecationMessage
        : typeof prop.markdownDeprecationMessage === "string"
          ? plainDescription(prop.markdownDeprecationMessage)
          : undefined,
    editor: rawType === "object" || (Array.isArray(rawType) && rawType.includes("object")) ? "json" : undefined,
  };
}

/** Título legível de uma chave: `editor.fontSize` → "Font Size". */
export function titleFromKey(key: string): string {
  const last = key.split(".").pop() ?? key;
  return last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

/** Grupo de uma chave (`editor.minimap.enabled` → "Editor › Minimap"). */
export function groupFromKey(key: string): string {
  const parts = key.split(".");
  parts.pop();
  return parts.map((p) => p.replace(/^./, (c) => c.toUpperCase()).replace(/([a-z])([A-Z])/g, "$1 $2")).join(" › ");
}

export class SettingsRegistry {
  private readonly entries = new Map<string, SettingSchema>();
  /** `contributes.configurationDefaults`: `{ "[lang]": {...}, "chave": valor }`. */
  private readonly contributedDefaults = new Map<string, Record<string, unknown>>();
  private readonly listeners = new Set<Listener>();
  private version = 0;

  register(entries: readonly SettingSchema[]): void {
    for (const e of entries) this.entries.set(e.key, e);
    this.changed();
  }

  /** Registra o `contributes.configuration` (+ `configurationDefaults`) de uma extensão. */
  registerExtension(extensionId: string, label: string, packageJson: unknown): void {
    this.unregisterExtension(extensionId, false);
    const contributes = isObj(packageJson) && isObj(packageJson.contributes) ? packageJson.contributes : {};
    const conf = contributes.configuration;
    const blocks = Array.isArray(conf) ? conf : conf ? [conf] : [];
    let order = 0;
    for (const block of blocks) {
      if (!isObj(block) || !isObj(block.properties)) continue;
      for (const [key, prop] of Object.entries(block.properties)) {
        if (!isObj(prop)) continue;
        // Uma extensão não sobrescreve uma setting do core.
        const existing = this.entries.get(key);
        if (existing && existing.source === "core") continue;
        this.entries.set(key, schemaFromContribution(key, prop, extensionId, label, order++));
      }
    }
    if (isObj(contributes.configurationDefaults)) {
      this.contributedDefaults.set(extensionId, contributes.configurationDefaults);
    }
    this.changed();
  }

  unregisterExtension(extensionId: string, notify = true): void {
    let removed = false;
    for (const [key, e] of this.entries) {
      if (e.source === extensionId) {
        this.entries.delete(key);
        removed = true;
      }
    }
    if (this.contributedDefaults.delete(extensionId)) removed = true;
    if (removed && notify) this.changed();
  }

  get(key: string): SettingSchema | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  all(): SettingSchema[] {
    return [...this.entries.values()];
  }

  /** Defaults efetivos: os do schema + `configurationDefaults` das extensões. */
  defaults(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const e of this.entries.values()) out[e.key] = e.default;
    for (const extra of this.contributedDefaults.values()) {
      for (const [k, v] of Object.entries(extra)) {
        if (k.startsWith("[")) {
          out[k] = { ...(isObj(out[k]) ? (out[k] as Record<string, unknown>) : {}), ...(isObj(v) ? v : {}) };
        } else out[k] = v;
      }
    }
    return out;
  }

  /** Alguma setting registrada começa com `prefix.`? (para achatar objetos aninhados). */
  isSection(prefix: string): boolean {
    const p = prefix + ".";
    for (const k of this.entries.keys()) if (k.startsWith(p)) return true;
    return false;
  }

  get revision(): number {
    return this.version;
  }

  onDidChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }
}

/** Valida um valor contra o schema. Devolve a mensagem de erro (pt-BR) ou null. */
export function validateSettingValue(schema: SettingSchema, value: unknown): string | null {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value === "number"
          ? Number.isInteger(value)
            ? "integer"
            : "number"
          : typeof value;
  const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
  if (!ok) return `Tipo incorreto: esperado ${types.join(" | ")}.`;
  if (schema.enum && !schema.enum.includes(value as string)) {
    return `Valor não permitido. Use: ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}.`;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `O valor mínimo é ${schema.minimum}.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `O valor máximo é ${schema.maximum}.`;
  }
  return null;
}
