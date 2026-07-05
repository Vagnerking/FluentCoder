/**
 * Realce de sintaxe dos blocos de código citados pelo agente no chat.
 *
 * Usa o Shiki (já dependência do app — colore o Razor no editor) com o tema
 * `dark-plus`: a mesma família Dark+ em que o `fluent-acrylic-dark` do editor
 * se baseia, então as cores do chat casam com as do código aberto ao lado.
 *
 * O highlighter é um singleton preguiçoso e as grammars são carregadas sob
 * demanda por linguagem (a primeira citação em C# carrega só o C#). Qualquer
 * falha — linguagem desconhecida, WASM indisponível, bloco gigante — degrada
 * para `null` e o chat renderiza o bloco sem cores, nunca quebra.
 */
import {
  bundledLanguages,
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
} from "shiki";

const THEME = "dark-plus";

/**
 * Acima disso o bloco fica sem realce: tokenizar código muito grande a cada
 * delta do streaming custaria mais do que a cor vale.
 */
const MAX_HIGHLIGHT_CHARS = 20_000;

/**
 * Nomes que os agentes usam mas não são chaves do catálogo do Shiki. O
 * catálogo já inclui aliases comuns (`cs`, `js`, `ts`, `sh`…); aqui entram só
 * os que faltam nele.
 */
const LANG_ALIASES: Record<string, string> = {
  "c#": "csharp",
  cshtml: "razor",
  aspnetcorerazor: "razor",
  "c++": "cpp",
  dockerfile: "docker",
};

/**
 * Resolve o rótulo da fence (```csharp) para uma linguagem do catálogo do
 * Shiki, ou `null` quando não há grammar para ela.
 */
export function normalizeLang(
  lang: string | null | undefined,
): string | null {
  if (!lang) return null;
  const lower = lang.trim().toLowerCase();
  if (!lower) return null;
  const mapped = LANG_ALIASES[lower] ?? lower;
  return mapped in bundledLanguages ? mapped : null;
}

let highlighterPromise: Promise<Highlighter> | null = null;
/** Grammars já pedidas (carregadas ou em voo), para não carregar duas vezes. */
const languageLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [THEME], langs: [] });
  return highlighterPromise;
}

/**
 * Converte um bloco de código em HTML realçado (`<pre class="shiki">…`), ou
 * `null` para renderizar sem cores. O HTML é gerado pelo Shiki a partir do
 * texto (escapado) — seguro para `dangerouslySetInnerHTML`.
 */
export async function highlightCode(
  code: string,
  lang: string | null | undefined,
): Promise<string | null> {
  const resolved = normalizeLang(lang);
  if (!resolved || code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    const highlighter = await getHighlighter();
    let load = languageLoads.get(resolved);
    if (!load) {
      load = highlighter.loadLanguage(resolved as BundledLanguage);
      languageLoads.set(resolved, load);
    }
    await load;
    return highlighter.codeToHtml(code, {
      lang: resolved,
      theme: THEME,
    });
  } catch {
    // Grammar/WASM falhou — deixa o bloco plano e permite tentar de novo.
    languageLoads.delete(resolved);
    return null;
  }
}
