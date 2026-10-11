/**
 * Snippets no IntelliSense do Monaco: `contributes.snippets` das extensões
 * (modo somente contribuições), snippets do USUÁRIO (`<config>/snippets/
 * <linguagem>.json` e `*.code-snippets`) e do WORKSPACE
 * (`.vscode/*.code-snippets`).
 *
 * Um provedor de completion por linguagem com snippets (nunca `cshtml`,
 * `aspnetcorerazor` nem `razor` — "um provider por feature" de
 * cshtml-language-service.md), recriado a cada mudança (sem acumular
 * providers). Itens `kind: Snippet`, abaixo das sugestões do LSP
 * (`sortText`). Inserção = SnippetController do Monaco (tabstops,
 * placeholders, escolhas); as variáveis de arquivo/workspace/data
 * (`TM_FILENAME`, `CURRENT_YEAR`, `WORKSPACE_NAME`, `UUID`…) são resolvidas
 * aqui antes de inserir; as de seleção/área de transferência ficam com o
 * Monaco. Setting `editor.snippetSuggestions.enabled` (padrão ligado).
 */
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { whenMonacoReady } from "../../monaco-loader";
import { getContributingExtensions, onDidChangeContributions, readExtensionFile, contributionsLog } from "../../extensions/contributions/source";
import { normalizeInside } from "../../extensions/contributions/paths";
import { parseJsonc } from "../../extensions/contributions/jsonc";
import { getExplorerWorkspaceRoot, onDidChangeExplorerWorkspaceRoot } from "../../api";
import { fromFileUri } from "../../lsp/uri";
import { SETTING, getSetting, onDidChangeSetting } from "../../theme/settingsAdapter";
import { fileVariables, parseSnippet, readSnippetFile, resolveSnippetVariables, snippetPreview, timeVariables, type SnippetDefinition } from "./snippetParser";

const EXCLUDED = new Set(["cshtml", "aspnetcorerazor", "razor"]);

let fromExtensions: SnippetDefinition[] = [];
let fromUser: SnippetDefinition[] = [];
let fromWorkspace: SnippetDefinition[] = [];
const providers: monaco.IDisposable[] = [];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function loadExtensionSnippets(): Promise<void> {
  const out: SnippetDefinition[] = [];
  for (const ext of getContributingExtensions()) {
    if (!ext.points.includes("snippets")) continue;
    const c = isObj(ext.manifest.contributes) ? ext.manifest.contributes : {};
    for (const s of Array.isArray(c.snippets) ? c.snippets : []) {
      if (!isObj(s) || typeof s.path !== "string") continue;
      const rel = normalizeInside(s.path);
      if (!rel) continue;
      try {
        const json = parseJsonc(await readExtensionFile(ext, rel));
        out.push(...readSnippetFile(json, { language: typeof s.language === "string" ? s.language : undefined, source: ext.displayName }));
      } catch (err) {
        contributionsLog(`snippets de ${ext.id} (${rel}) ignorados: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  fromExtensions = out;
}

interface UserSnippetFile {
  name: string;
  path: string;
  content: string;
}

async function loadUserSnippets(): Promise<void> {
  try {
    const files = await invoke<UserSnippetFile[]>("snippets_user_list");
    const out: SnippetDefinition[] = [];
    for (const f of files) {
      try {
        const global = f.name.toLowerCase().endsWith(".code-snippets");
        const language = global ? undefined : f.name.replace(/\.json$/i, "");
        out.push(...readSnippetFile(parseJsonc(f.content, { maxChars: 1 << 20 }), { language, source: "Snippets do usuário" }));
      } catch (err) {
        contributionsLog(`snippets do usuário ${f.name} ignorados: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    fromUser = out;
  } catch {
    fromUser = [];
  }
}

async function loadWorkspaceSnippets(root: string | null): Promise<void> {
  fromWorkspace = [];
  if (!root) return;
  const dir = `${root.replace(/[\\/]$/, "")}${root.includes("\\") ? "\\" : "/"}.vscode`;
  try {
    const entries = await invoke<{ name: string; path: string; is_dir: boolean }[]>("read_dir", { path: dir, exclude: [], workspaceRoot: null });
    const out: SnippetDefinition[] = [];
    for (const e of entries.filter((x) => !x.is_dir && x.name.toLowerCase().endsWith(".code-snippets")).slice(0, 50)) {
      try {
        const { content } = await invoke<{ content: string }>("read_file", { path: e.path, allowLarge: false });
        out.push(...readSnippetFile(parseJsonc(content, { maxChars: 1 << 20 }), { source: `Workspace (${e.name})` }));
      } catch (err) {
        contributionsLog(`snippets do workspace ${e.name} ignorados: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    fromWorkspace = out;
  } catch {
    /* sem .vscode */
  }
}

function uuid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function variablesFor(model: monaco.editor.ITextModel): Record<string, string> {
  const path = model.uri.scheme === "file" ? fromFileUri(model.uri.toString()) : model.uri.path;
  const hex = () => Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return {
    ...fileVariables(path, getExplorerWorkspaceRoot()),
    ...timeVariables(new Date()),
    RANDOM: String(Math.floor(Math.random() * 1e6)).padStart(6, "0"),
    RANDOM_HEX: hex(),
    UUID: uuid(),
  };
}

function rebuild(): void {
  for (const d of providers.splice(0)) d.dispose();
  if (!getSetting(SETTING.snippetsEnabled, true)) return;
  const all = [...fromWorkspace, ...fromUser, ...fromExtensions];
  if (!all.length) return;
  const byLang = new Map<string, SnippetDefinition[]>();
  const global: SnippetDefinition[] = [];
  for (const s of all) {
    if (!s.scopes.length) global.push(s);
    for (const l of s.scopes) if (!EXCLUDED.has(l)) byLang.set(l, [...(byLang.get(l) ?? []), s]);
  }
  const langs = new Set<string>(byLang.keys());
  if (global.length) for (const l of monaco.languages.getLanguages()) if (!EXCLUDED.has(l.id)) langs.add(l.id);
  for (const lang of langs) {
    const list = [...(byLang.get(lang) ?? []), ...global];
    providers.push(
      monaco.languages.registerCompletionItemProvider(lang, {
        provideCompletionItems(model, position) {
          const word = model.getWordUntilPosition(position);
          const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
          const vars = variablesFor(model);
          const suggestions: monaco.languages.CompletionItem[] = [];
          for (const s of list) {
            const body = resolveSnippetVariables(s.body, vars);
            const preview = snippetPreview(parseSnippet(body), vars);
            for (const prefix of s.prefixes) {
              suggestions.push({
                label: { label: prefix, description: s.name },
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: body,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                detail: s.description ?? `${s.name} — ${s.source}`,
                documentation: { value: "```" + lang + "\n" + preview.slice(0, 4000) + "\n```" },
                // Abaixo das sugestões do LSP (que não usam o prefixo "~").
                sortText: `~${prefix}`,
                range,
              });
            }
          }
          return { suggestions };
        },
      }),
    );
  }
}

async function reloadAll(): Promise<void> {
  await Promise.all([loadExtensionSnippets(), loadUserSnippets(), loadWorkspaceSnippets(getExplorerWorkspaceRoot())]);
  rebuild();
}

/** Relê todos os snippets (ex.: depois de salvar um arquivo de snippets). */
export function reloadSnippets(): Promise<void> {
  return reloadAll();
}

let started = false;

export function startSnippets(): void {
  if (started) return;
  started = true;
  void whenMonacoReady.then(() => {
    void reloadAll();
    onDidChangeContributions(() => void loadExtensionSnippets().then(rebuild));
    onDidChangeExplorerWorkspaceRoot((root) => void loadWorkspaceSnippets(root).then(rebuild));
    onDidChangeSetting(SETTING.snippetsEnabled, rebuild);
  });
}
