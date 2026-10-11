/**
 * `contributes.languages` + `contributes.grammars` das extensões (modo
 * somente contribuições) → o que o app registra. Puro.
 *
 * PRECEDÊNCIA (docs/context/editor.md + cshtml-language-service.md): as
 * linguagens que o app atende com pipeline próprio NÃO são tocadas — nem o
 * mapeamento de arquivos, nem a tokenização, nem a configuração:
 * C#/Roslyn (`csharp`), Razor/CSHTML (`cshtml`, `aspnetcorerazor`, `razor`)
 * e as com LSP + Monarch próprios (TS/JS/JSON/CSS/SCSS/Less/HTML).
 * Gramática com `injectTo` mirando um escopo dessas linguagens é ignorada.
 */
import { normalizeInside } from "../../extensions/contributions/paths.ts";

export const PROTECTED_LANGUAGES: ReadonlySet<string> = new Set([
  "csharp",
  "cshtml",
  "aspnetcorerazor",
  "razor",
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "json",
  "jsonc",
  "css",
  "scss",
  "less",
  "html",
]);

/** Escopos TextMate das linguagens protegidas (injeções neles são ignoradas). */
export const PROTECTED_SCOPES: ReadonlySet<string> = new Set(["source.cs", "text.html.cshtml", "text.aspnetcorerazor", "text.html.razor", "source.ts", "source.tsx", "source.js", "source.js.jsx", "source.json", "source.css", "source.css.scss", "source.css.less", "text.html.basic", "text.html.derivative"]);

export interface ContributedLanguage {
  id: string;
  extensions: string[];
  filenames: string[];
  filenamePatterns: string[];
  firstLine?: string;
  aliases: string[];
  mimetypes: string[];
  /** `configuration` (relativo à raiz da extensão), se houver. */
  configuration?: string;
  extensionId: string;
}

export interface ContributedGrammar {
  language?: string;
  scopeName: string;
  /** Caminho relativo à raiz da extensão. */
  path: string;
  embeddedLanguages: Record<string, string>;
  injectTo: string[];
  extensionId: string;
}

export interface ExtensionContributions {
  id: string;
  manifest: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strs = (v: unknown, max = 200): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= max).slice(0, 200) : []);
const LANG_ID = /^[\w.+#-]{1,64}$/;
const SCOPE = /^[\w.+-]{1,128}$/;

export interface CollectResult {
  languages: ContributedLanguage[];
  grammars: ContributedGrammar[];
  /** O que ficou de fora e por quê (para a saída "Extensões"). */
  skipped: string[];
}

export function collectLanguageContributions(exts: readonly ExtensionContributions[]): CollectResult {
  const byId = new Map<string, ContributedLanguage>();
  const grammars: ContributedGrammar[] = [];
  const skipped: string[] = [];
  const scopes = new Set<string>();
  for (const ext of exts) {
    const c = isObj(ext.manifest.contributes) ? ext.manifest.contributes : {};
    for (const l of Array.isArray(c.languages) ? c.languages : []) {
      if (!isObj(l) || typeof l.id !== "string" || !LANG_ID.test(l.id)) continue;
      if (PROTECTED_LANGUAGES.has(l.id)) {
        skipped.push(`${ext.id}: linguagem \`${l.id}\` tem pipeline próprio no app (mantida)`);
        continue;
      }
      const prev = byId.get(l.id);
      const conf = typeof l.configuration === "string" ? normalizeInside(l.configuration) : null;
      const lang: ContributedLanguage = prev ?? { id: l.id, extensions: [], filenames: [], filenamePatterns: [], aliases: [], mimetypes: [], extensionId: ext.id };
      lang.extensions.push(...strs(l.extensions, 32).map((e) => e.toLowerCase()));
      lang.filenames.push(...strs(l.filenames, 128));
      lang.filenamePatterns.push(...strs(l.filenamePatterns, 128));
      lang.aliases.push(...strs(l.aliases, 64));
      lang.mimetypes.push(...strs(l.mimetypes, 64));
      if (!lang.firstLine && typeof l.firstLine === "string" && l.firstLine.length <= 512) lang.firstLine = l.firstLine;
      // A 1ª configuração vale (como no VS Code, que não mescla arquivos).
      if (!lang.configuration && conf) {
        lang.configuration = conf;
        lang.extensionId = ext.id;
      }
      byId.set(l.id, lang);
    }
    for (const g of Array.isArray(c.grammars) ? c.grammars : []) {
      if (!isObj(g) || typeof g.scopeName !== "string" || !SCOPE.test(g.scopeName) || typeof g.path !== "string") continue;
      const path = normalizeInside(g.path);
      if (!path) continue;
      const language = typeof g.language === "string" && LANG_ID.test(g.language) ? g.language : undefined;
      if (language && PROTECTED_LANGUAGES.has(language)) {
        skipped.push(`${ext.id}: gramática de \`${language}\` ignorada (C#/Razor/CSHTML e linguagens com LSP próprio mantêm o pipeline do app)`);
        continue;
      }
      const injectTo = strs(g.injectTo, 128).filter((s) => SCOPE.test(s) && !PROTECTED_SCOPES.has(s));
      if (scopes.has(g.scopeName)) continue;
      scopes.add(g.scopeName);
      const embedded: Record<string, string> = {};
      if (isObj(g.embeddedLanguages)) for (const [k, v] of Object.entries(g.embeddedLanguages)) if (SCOPE.test(k) && typeof v === "string" && LANG_ID.test(v)) embedded[k] = v;
      grammars.push({ language, scopeName: g.scopeName, path, embeddedLanguages: embedded, injectTo, extensionId: ext.id });
    }
  }
  return { languages: [...byId.values()], grammars, skipped };
}

function globToRegex(glob: string): RegExp | null {
  if (glob.length > 128) return null;
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`(^|/)${out}$`, "i");
  } catch {
    return null;
  }
}

/**
 * Resolvedor nome-de-arquivo → linguagem contribuída: `filenames` exatos, depois
 * `filenamePatterns` (glob), depois `extensions` (sufixo mais longo).
 */
export function buildLanguageResolver(languages: readonly ContributedLanguage[]): (name: string, path?: string) => string | undefined {
  const names = new Map<string, string>();
  const exts: [string, string][] = [];
  const patterns: [RegExp, string][] = [];
  for (const l of languages) {
    for (const f of l.filenames) if (!names.has(f.toLowerCase())) names.set(f.toLowerCase(), l.id);
    for (const e of l.extensions) exts.push([e.startsWith(".") ? e : `.${e}`, l.id]);
    for (const p of l.filenamePatterns) {
      const re = globToRegex(p);
      if (re) patterns.push([re, l.id]);
    }
  }
  exts.sort((a, b) => b[0].length - a[0].length);
  return (name, path) => {
    const lower = name.toLowerCase();
    const byName = names.get(lower);
    if (byName) return byName;
    const target = (path ?? name).replace(/\\/g, "/");
    for (const [re, id] of patterns) if (re.test(target)) return id;
    for (const [e, id] of exts) if (lower.endsWith(e) && lower.length > e.length - 1) return id;
    return undefined;
  };
}

/** Escopos externos citados por `include` (sem `#`/`$self`/`$base`), para pré-carregar. */
export function externalIncludes(grammar: unknown): string[] {
  const out = new Set<string>();
  const stack: unknown[] = [grammar];
  let n = 0;
  while (stack.length && n++ < 50_000) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (k === "include" && typeof x === "string" && !x.startsWith("#") && !x.startsWith("$")) {
          const scope = x.split("#")[0];
          if (SCOPE.test(scope)) out.add(scope);
        } else if (typeof x === "object") stack.push(x);
      }
    }
  }
  return [...out];
}
