/**
 * Linguagens e gramáticas TextMate de extensões (modo somente contribuições)
 * no Monaco do app — a MESMA instância de `src/monaco-loader.ts`.
 *
 * - `contributes.languages` → `monaco.languages.register` + mapa de arquivos
 *   (`setContributedLanguageResolver` em `src/language.ts`) +
 *   `setLanguageConfiguration` (comentários, brackets, autoClosingPairs,
 *   folding, indentationRules, onEnterRules — `languageConfig.ts`).
 * - `contributes.grammars` → vscode-textmate (`@shikijs/vscode-textmate`) +
 *   Oniguruma WASM do Shiki, carregados só no 1º modelo de uma linguagem com
 *   gramática (como o Razor em `src/lsp/shikiRazor.ts`). `embeddedLanguages`,
 *   `include` de outras gramáticas (contribuídas ou as do Shiki embutidas) e
 *   `injectTo` funcionam.
 * - Cor: cada token recebe o estilo do tema ativo pelo seletor TextMate
 *   (`src/theme/tmScopes.ts`) e vira `tm.<cor>[.<estilo>]` (regras geradas em
 *   `src/theme/monacoTheme.ts`). Trocar de tema re-tokeniza.
 * - ReDoS: validação estática + compilação no Oniguruma antes de usar
 *   (`redos.ts`), `timeLimit` por linha e desligamento da gramática que
 *   estoura repetidamente.
 * - C#, Razor/CSHTML e as linguagens com LSP próprio NÃO são tocadas
 *   (`PROTECTED_LANGUAGES`; docs/context/editor.md e cshtml-language-service.md).
 */
import * as monaco from "monaco-editor";
import { INITIAL, Registry, type IGrammar, type IRawGrammar, type StateStack } from "@shikijs/vscode-textmate";
import { whenMonacoReady } from "../../monaco-loader";
import { getContributingExtensions, onDidChangeContributions, readExtensionFile, contributionsLog, type ContributingExtension } from "../../extensions/contributions/source";
import { parseJsonc } from "../../extensions/contributions/jsonc";
import { parsePlist } from "../../extensions/contributions/plist";
import { setContributedLanguageResolver, languageForFile } from "../../language";
import { getActiveColorTheme, onDidChangeActiveColorTheme } from "../../theme/activeTheme";
import { compileTokenColors, matchScopes, styleToken, type CompiledRule } from "../../theme/tmScopes";
import { buildLanguageResolver, collectLanguageContributions, externalIncludes, PROTECTED_LANGUAGES, type ContributedGrammar, type ContributedLanguage } from "./contributedLanguages";
import { convertLanguageConfiguration } from "./languageConfig";
import { checkGrammar } from "./redos";

/** Orçamento de tempo por linha (ms) e quantas estouradas desligam a gramática. */
export const LINE_TIME_LIMIT_MS = 50;
const MAX_STOPPED_EARLY = 5;
const MAX_LINE = 20_000;

/** Escopos embutidos do Shiki usados quando uma gramática inclui outra não contribuída. */
const SHIKI_SCOPES: Record<string, string> = {
  "source.js": "javascript",
  "source.ts": "typescript",
  "source.tsx": "tsx",
  "source.js.jsx": "jsx",
  "source.css": "css",
  "source.css.scss": "scss",
  "source.json": "json",
  "text.html.basic": "html",
  "text.html.derivative": "html-derivative",
  "text.html.markdown": "markdown",
  "source.yaml": "yaml",
  "source.shell": "shellscript",
  "source.python": "python",
  "source.sql": "sql",
  "text.xml": "xml",
  "source.toml": "toml",
  "source.rust": "rust",
  "source.go": "go",
  "source.c": "c",
  "source.cpp": "cpp",
  "source.java": "java",
  "source.regexp.python": "regexp",
  "source.graphql": "graphql",
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

let languages: ContributedLanguage[] = [];
let grammars: ContributedGrammar[] = [];
let extById = new Map<string, ContributingExtension>();
const registeredLangs = new Set<string>();
const configuredLangs = new Map<string, monaco.IDisposable>();
const providers = new Map<string, monaco.IDisposable>();
const activating = new Map<string, Promise<void>>();
const disabled = new Set<string>();
const languageHooks = new Map<string, monaco.IDisposable>();

// ------------------------------------------------------------------ engine

type Engine = { createScanner: (p: string[]) => unknown; createString: (s: string) => unknown };
let enginePromise: Promise<Engine> | null = null;

function engine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const { createOnigurumaEngine } = await import("shiki/engine/oniguruma");
      return (await createOnigurumaEngine(import("shiki/wasm"))) as unknown as Engine;
    })();
    enginePromise.catch(() => (enginePromise = null));
  }
  return enginePromise;
}

const rawGrammars = new Map<string, IRawGrammar>();
let registry: Registry | null = null;

async function getRegistry(): Promise<Registry> {
  if (registry) return registry;
  const e = await engine();
  registry = new Registry({
    onigLib: { createOnigScanner: (p: string[]) => e.createScanner(p), createOnigString: (s: string) => e.createString(s) } as never,
    loadGrammar: (scope) => rawGrammars.get(scope) ?? null,
    getInjections: (scope) => grammars.filter((g) => g.injectTo.includes(scope) && rawGrammars.has(g.scopeName)).map((g) => g.scopeName),
  });
  return registry;
}

function parseGrammarText(text: string, rel: string): unknown {
  if (/\.(tmLanguage|plist|xml)$/i.test(rel) || text.trimStart().startsWith("<")) return parsePlist(text);
  return parseJsonc(text, { maxDepth: 128 });
}

/** Lê, valida (ReDoS + compilação) e guarda uma gramática e as que ela inclui. */
async function preload(scope: string, seen = new Set<string>()): Promise<void> {
  if (rawGrammars.has(scope) || seen.has(scope) || seen.size > 32) return;
  seen.add(scope);
  const g = grammars.find((x) => x.scopeName === scope);
  let raw: unknown = null;
  if (g) {
    const ext = extById.get(g.extensionId);
    if (!ext) return;
    raw = parseGrammarText(await readExtensionFile(ext, g.path), g.path);
    const check = checkGrammar(raw);
    if (!check.ok) throw new Error(`gramática ${scope} recusada: ${check.problems.slice(0, 3).join("; ")}`);
    const e = await engine();
    for (const p of check.patterns) {
      if (p.backrefs) continue;
      try {
        // Compila no Oniguruma (erro de sintaxe lança) e libera a memória WASM.
        (e.createScanner([p.source]) as { dispose?: () => void }).dispose?.();
      } catch (err) {
        throw new Error(`gramática ${scope} recusada: regex inválida em ${p.where} (${(err as Error).message ?? err})`);
      }
    }
  } else if (SHIKI_SCOPES[scope]) {
    try {
      const { bundledLanguages } = await import("shiki/langs");
      const loader = (bundledLanguages as Record<string, () => Promise<{ default: unknown[] }>>)[SHIKI_SCOPES[scope]];
      const mod = loader ? await loader() : null;
      for (const r of mod?.default ?? []) if (isObj(r) && typeof r.scopeName === "string" && !rawGrammars.has(r.scopeName)) rawGrammars.set(r.scopeName, r as unknown as IRawGrammar);
    } catch {
      /* sem a embutida: o trecho incluído fica sem cor */
    }
    return;
  } else return;
  if (!isObj(raw)) return;
  rawGrammars.set(scope, raw as unknown as IRawGrammar);
  for (const inc of externalIncludes(raw)) await preload(inc, seen).catch((err) => contributionsLog(String(err instanceof Error ? err.message : err)));
  for (const inj of grammars.filter((x) => x.injectTo.includes(scope))) await preload(inj.scopeName, seen).catch((err) => contributionsLog(String(err instanceof Error ? err.message : err)));
}

// ------------------------------------------------------------------ tokens

let themeRules: CompiledRule[] = compileTokenColors(getActiveColorTheme().tokenColors);
let defaultFg = getActiveColorTheme().defaultForeground;
const styleCache = new Map<string, string>();

function tokenFor(scopes: string[]): string {
  const key = scopes.join("\u0001");
  let t = styleCache.get(key);
  if (!t) {
    t = styleToken(matchScopes(themeRules, scopes), defaultFg);
    if (styleCache.size > 20_000) styleCache.clear();
    styleCache.set(key, t);
  }
  return t;
}

class TmState implements monaco.languages.IState {
  constructor(readonly stack: StateStack) {}
  clone(): monaco.languages.IState {
    return new TmState(this.stack);
  }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof TmState && other.stack === this.stack;
  }
}

function makeProvider(lang: string, grammar: IGrammar): monaco.languages.TokensProvider {
  let stoppedEarly = 0;
  return {
    getInitialState: () => new TmState(INITIAL),
    tokenize(line, state) {
      const st = state as TmState;
      if (disabled.has(lang) || line.length >= MAX_LINE) return { tokens: [{ startIndex: 0, scopes: "" }], endState: st };
      const r = grammar.tokenizeLine(line, st.stack, LINE_TIME_LIMIT_MS);
      if (r.stoppedEarly) {
        stoppedEarly++;
        if (stoppedEarly >= MAX_STOPPED_EARLY) {
          disabled.add(lang);
          contributionsLog(`gramática de \`${lang}\` desligada: ${stoppedEarly} linhas passaram de ${LINE_TIME_LIMIT_MS} ms (proteção contra ReDoS).`);
        }
        return { tokens: [{ startIndex: 0, scopes: "" }], endState: st };
      }
      return { tokens: r.tokens.map((t) => ({ startIndex: t.startIndex, scopes: tokenFor(t.scopes) })), endState: new TmState(r.ruleStack) };
    },
  };
}

async function activate(lang: string): Promise<void> {
  if (providers.has(lang) || disabled.has(lang) || PROTECTED_LANGUAGES.has(lang)) return;
  let p = activating.get(lang);
  if (!p) {
    p = (async () => {
      const g = grammars.find((x) => x.language === lang);
      if (!g) return;
      await preload(g.scopeName);
      const reg = await getRegistry();
      const grammar = reg.loadGrammar(g.scopeName);
      if (!grammar) throw new Error(`gramática ${g.scopeName} não carregou`);
      if (!grammars.includes(g)) return; // extensão removida no meio
      providers.set(lang, monaco.languages.setTokensProvider(lang, makeProvider(lang, grammar)));
      contributionsLog(`gramática TextMate ativa: ${lang} (${g.scopeName}, de ${g.extensionId}).`);
    })();
    activating.set(lang, p);
    p.catch((err) => {
      disabled.add(lang);
      contributionsLog(`gramática de \`${lang}\` não aplicada: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => activating.delete(lang));
  }
  return p;
}

/** Tema trocou: estilos recalculados e re-tokenização (provedor registrado de novo). */
function retheme(): void {
  const t = getActiveColorTheme();
  themeRules = compileTokenColors(t.tokenColors);
  defaultFg = t.defaultForeground;
  styleCache.clear();
  if (!registry) return;
  for (const [lang, d] of [...providers]) {
    d.dispose();
    providers.delete(lang);
    void activate(lang);
  }
}

// ------------------------------------------------------------------ linguagens

async function applyConfiguration(l: ContributedLanguage): Promise<void> {
  const ext = extById.get(l.extensionId);
  if (!ext || !l.configuration) return;
  try {
    const conf = convertLanguageConfiguration(parseJsonc(await readExtensionFile(ext, l.configuration)), (m) => contributionsLog(`${l.id}: language-configuration — ${m} (regra descartada)`));
    configuredLangs.get(l.id)?.dispose();
    configuredLangs.set(l.id, monaco.languages.setLanguageConfiguration(l.id, conf as monaco.languages.LanguageConfiguration));
  } catch (err) {
    contributionsLog(`${l.id}: language-configuration ignorada (${err instanceof Error ? err.message : String(err)})`);
  }
}

function refresh(): void {
  const exts = getContributingExtensions().filter((e) => e.points.includes("languages") || e.points.includes("grammars"));
  extById = new Map(exts.map((e) => [e.id, e]));
  const res = collectLanguageContributions(exts);
  for (const s of res.skipped) contributionsLog(s);
  const goneGrammars = grammars.filter((g) => !res.grammars.some((n) => n.scopeName === g.scopeName && n.extensionId === g.extensionId));
  languages = res.languages;
  grammars = res.grammars;
  for (const g of goneGrammars) {
    rawGrammars.delete(g.scopeName);
    if (g.language) {
      providers.get(g.language)?.dispose();
      providers.delete(g.language);
      disabled.delete(g.language);
    }
  }
  if (goneGrammars.length) registry = null; // gramáticas antigas ficam no Registry: recria
  setContributedLanguageResolver(languages.length ? buildLanguageResolver(languages) : null);

  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
  for (const l of languages) {
    if (!registeredLangs.has(l.id)) {
      monaco.languages.register({
        id: l.id,
        extensions: l.extensions,
        filenames: l.filenames,
        filenamePatterns: l.filenamePatterns,
        aliases: l.aliases.length ? l.aliases : undefined,
        mimetypes: l.mimetypes.length ? l.mimetypes : undefined,
        firstLine: l.firstLine,
      });
      registeredLangs.add(l.id);
    }
    void applyConfiguration(l);
  }
  // Gramática para linguagem sem `languages` (ex.: dependência só de gramática) também precisa existir.
  for (const g of grammars) {
    if (!g.language) continue;
    if (!known.has(g.language) && !registeredLangs.has(g.language)) {
      monaco.languages.register({ id: g.language });
      registeredLangs.add(g.language);
    }
    if (!languageHooks.has(g.language)) {
      const lang = g.language;
      languageHooks.set(lang, monaco.languages.onLanguage(lang, () => void activate(lang)));
    }
  }
  // Modelos já abertos: linguagem nova ganha o arquivo; gramática nova, os tokens.
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme !== "file") continue;
    const name = model.uri.path.split("/").pop() ?? "";
    const want = languageForFile(name);
    const cur = model.getLanguageId();
    if (cur === "plaintext" && want !== "plaintext" && !PROTECTED_LANGUAGES.has(want)) monaco.editor.setModelLanguage(model, want);
    const lang = model.getLanguageId();
    if (grammars.some((g) => g.language === lang)) void activate(lang);
  }
}

let started = false;

export function startContributedGrammars(): void {
  if (started) return;
  started = true;
  void whenMonacoReady.then(() => {
    refresh();
    onDidChangeContributions(refresh);
    onDidChangeActiveColorTheme(retheme);
  });
}
