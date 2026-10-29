/**
 * Validação e completion dos arquivos de configuração no editor JSON (puro):
 * `settings.json` (User, `.vscode/`, `.fluent/`), o `settings` de
 * `.code-workspace`/`.fluent-workspace` e `keybindings.json`. O schema é o
 * registro de settings (core + extensões) — o mesmo da tela de Configurações.
 * A ligação com o Monaco fica em `settingsJsonMonaco.ts`.
 */
import { parseTree, type JsonNode } from "./jsonc.ts";
import { languagesOfKey } from "./model.ts";
import { validateSettingValue, type SettingSchema } from "./registry.ts";

export type SettingsFileKind = "settings" | "workspace" | "keybindings";

export function settingsFileKind(path: string): SettingsFileKind | null {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (/\/(\.vscode|\.fluent|user)\/settings\.json$/.test(p)) return "settings";
  if (/\/user\/keybindings\.json$/.test(p)) return "keybindings";
  if (p.endsWith(".code-workspace") || p.endsWith(".fluent-workspace")) return "workspace";
  return null;
}

export interface SettingsDiagnostic {
  offset: number;
  length: number;
  message: string;
  severity: "error" | "warning" | "info";
}

interface SchemaLookup {
  get(key: string): SettingSchema | undefined;
  isSection(prefix: string): boolean;
}

function settingsObject(root: JsonNode | undefined, kind: SettingsFileKind): JsonNode | undefined {
  if (!root || root.type !== "object") return undefined;
  if (kind === "settings") return root;
  const prop = root.children?.find((p) => p.key?.value === "settings");
  return prop?.valueNode?.type === "object" ? prop.valueNode : undefined;
}

export function settingsDiagnostics(text: string, kind: SettingsFileKind, schema: SchemaLookup, knownCommands?: (id: string) => boolean): SettingsDiagnostic[] {
  const { root, errors } = parseTree(text);
  const out: SettingsDiagnostic[] = errors.map((e) => ({ offset: e.offset, length: 1, message: e.message, severity: "error" as const }));
  if (kind === "keybindings") {
    if (root && root.type !== "array") out.push({ offset: root.offset, length: 1, message: "keybindings.json deve ser uma lista ([ … ]).", severity: "error" });
    for (const item of root?.type === "array" ? root.children ?? [] : []) {
      if (item.type !== "object") continue;
      const cmd = item.children?.find((p) => p.key?.value === "command")?.valueNode;
      if (!cmd) out.push({ offset: item.offset, length: 1, message: 'Falta "command".', severity: "warning" });
      else if (typeof cmd.value === "string" && knownCommands && !cmd.value.startsWith("-") && !knownCommands(cmd.value)) {
        out.push({ offset: cmd.offset, length: cmd.length, message: `Comando desconhecido: ${cmd.value} (pode ser de uma extensão não carregada).`, severity: "info" });
      }
    }
    return out;
  }
  const obj = settingsObject(root, kind);
  const check = (o: JsonNode, inLanguage: boolean) => {
    for (const prop of o.children ?? []) {
      const key = String(prop.key?.value ?? "");
      if (!inLanguage && languagesOfKey(key)) {
        if (prop.valueNode?.type === "object") check(prop.valueNode, true);
        else out.push({ offset: prop.key!.offset, length: prop.key!.length, message: "Override de linguagem deve ser um objeto.", severity: "warning" });
        continue;
      }
      const s = schema.get(key);
      if (!s) {
        if (!schema.isSection(key)) {
          out.push({ offset: prop.key!.offset, length: prop.key!.length, message: `Configuração desconhecida: ${key} (preservada e repassada às extensões).`, severity: "info" });
        }
        continue;
      }
      if (inLanguage && s.scope !== "language-overridable") {
        out.push({ offset: prop.key!.offset, length: prop.key!.length, message: `${key} não pode ser definida por linguagem.`, severity: "warning" });
      }
      if (prop.valueNode) {
        const value = nodeValueOf(prop.valueNode);
        const err = validateSettingValue(s, value);
        if (err) out.push({ offset: prop.valueNode.offset, length: prop.valueNode.length, message: err, severity: "warning" });
      }
      if (s.deprecationMessage) out.push({ offset: prop.key!.offset, length: prop.key!.length, message: s.deprecationMessage, severity: "info" });
    }
  };
  if (obj) check(obj, false);
  else if (kind === "settings" && root && root.type !== "object") out.push({ offset: root.offset, length: 1, message: "settings.json deve ser um objeto ({ … }).", severity: "error" });
  return out;
}

function nodeValueOf(n: JsonNode): unknown {
  if (n.type === "object") return Object.fromEntries((n.children ?? []).map((p) => [String(p.key?.value), p.valueNode ? nodeValueOf(p.valueNode) : undefined]));
  if (n.type === "array") return (n.children ?? []).map(nodeValueOf);
  return n.value;
}

export type CompletionContext =
  | { kind: "key"; inLanguage: boolean; existing: string[] }
  | { kind: "value"; key: string }
  | { kind: "command" }
  | null;

function contains(n: JsonNode, offset: number): boolean {
  return offset > n.offset && offset <= n.offset + n.length - (n.type === "object" || n.type === "array" ? 1 : 0);
}

/** Onde o cursor está: digitando uma chave, um valor de uma chave conhecida ou um comando. */
export function completionContext(text: string, offset: number, kind: SettingsFileKind): CompletionContext {
  // Fecha a estrutura provisoriamente para o parse tolerante achar o objeto.
  const { root } = parseTree(text);
  if (!root) return kind === "keybindings" ? null : { kind: "key", inLanguage: false, existing: [] };
  if (kind === "keybindings") {
    const before = text.slice(0, offset);
    return /"command"\s*:\s*"[^"]*$/.test(before) ? { kind: "command" } : null;
  }
  const obj = settingsObject(root, kind);
  if (!obj || !contains(obj, offset)) return null;
  let target = obj;
  let inLanguage = false;
  for (const p of obj.children ?? []) {
    if (p.valueNode?.type === "object" && languagesOfKey(String(p.key?.value)) && contains(p.valueNode, offset)) {
      target = p.valueNode;
      inLanguage = true;
    }
  }
  // Valor: o cursor está depois dos dois-pontos de uma propriedade deste objeto.
  for (const p of target.children ?? []) {
    const keyEnd = p.key!.offset + p.key!.length;
    const colon = text.indexOf(":", keyEnd);
    const valueEnd = p.valueNode ? p.valueNode.offset + p.valueNode.length : Number.MAX_SAFE_INTEGER;
    if (colon >= 0 && offset > colon && offset <= valueEnd && !/\n/.test(text.slice(colon, offset))) {
      return { kind: "value", key: String(p.key!.value) };
    }
  }
  return { kind: "key", inLanguage, existing: (target.children ?? []).map((p) => String(p.key?.value)) };
}

/** Texto inserido para o valor padrão de uma setting (snippet simples). */
export function defaultValueText(s: SettingSchema): string {
  return JSON.stringify(s.default ?? null, null, 2);
}
