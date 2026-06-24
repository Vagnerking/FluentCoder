/**
 * Shiki-backed syntax coloring for `.cshtml`/`.razor` (Fase A.2, ADR 0002).
 *
 * The hand-written Monarch grammar can't accurately segment the embedded
 * languages (C# inside `@{}`/`@expr`, HTML, CSS, the Razor transitions). Shiki's
 * real TextMate `razor` grammar does. We do NOT use `@shikijs/monaco`'s global
 * `shikiToMonaco` (it monkeypatches `monaco.editor.setTheme`/`create` and
 * re-tokenizes EVERY language, clobbering the app's `fluent-acrylic-dark` theme).
 *
 * Instead this is SCOPED to the two Razor language ids and theme-agnostic: a
 * Monaco `TokensProvider` tokenizes with Shiki's grammar and maps each token's
 * deepest TextMate scope to a STANDARD Monaco token type (`keyword`, `string`,
 * `tag`, `type`, …) that the active theme already colors. No theme is replaced.
 *
 * Loads lazily (WASM Oniguruma) on the first Razor model — compat proven by
 * `tools/razor-lsp-probe/spike-shiki.mjs`. Falls back to the Monarch grammar if
 * Shiki fails to load.
 */
import * as monaco from "monaco-editor";
import { createHighlighter } from "shiki";
import { INITIAL, type IGrammar, type StateStack } from "@shikijs/vscode-textmate";
import { mapScopes, isMemberProperty } from "./shikiScopeMap";

/** Monaco language ids that get Shiki coloring (`.razor` cohost + `.cshtml` projection). */
const RAZOR_LANG_IDS = ["aspnetcorerazor", "cshtml"];

/** Monaco `IState` wrapping the TextMate rule stack across lines. */
class RazorTmState implements monaco.languages.IState {
  constructor(readonly ruleStack: StateStack) {}
  clone(): monaco.languages.IState {
    return new RazorTmState(this.ruleStack);
  }
  // Force re-tokenize whenever Monaco asks (matches @shikijs/monaco); the grammar
  // state isn't cheaply comparable and lines are short.
  equals(other: monaco.languages.IState): boolean {
    return other === this;
  }
}

let started = false;

/**
 * Idempotently installs Shiki coloring for the Razor language ids. Safe to call
 * repeatedly (and from sync setup via `void`). No-ops on failure, leaving the
 * Monarch grammar in place.
 */
export async function installShikiRazorColors(): Promise<void> {
  if (started) return;
  started = true;
  let highlighter: Awaited<ReturnType<typeof createHighlighter>>;
  try {
    // A theme must be loaded, but token SCOPES (not colors) drive our mapping, so
    // which theme is irrelevant — we never use Shiki's color output here.
    highlighter = await createHighlighter({ themes: ["dark-plus"], langs: ["razor"] });
  } catch {
    started = false; // let a later model retry
    return;
  }
  const grammar = highlighter.getLanguage("razor") as unknown as IGrammar;

  // Beyond this a single line is left unhighlighted rather than risking the
  // grammar's time limit on pathological input (matches @shikijs/monaco).
  const MAX_LINE = 20_000;

  const provider: monaco.languages.TokensProvider = {
    getInitialState: () => new RazorTmState(INITIAL),
    tokenize(line, state) {
      const ruleStack = (state as RazorTmState).ruleStack;
      if (line.length >= MAX_LINE) {
        return { tokens: [{ startIndex: 0, scopes: "" }], endState: state };
      }
      const result = grammar.tokenizeLine(line, ruleStack, 500);
      const raw = result.tokens;
      const tokenText = (i: number) =>
        line.slice(raw[i].startIndex, raw[i].endIndex).trim();
      /** Index of the next non-whitespace token after `i`, or -1. */
      const nextMeaningful = (i: number): number => {
        for (let j = i + 1; j < raw.length; j++) {
          if (tokenText(j) !== "") return j;
        }
        return -1;
      };
      const tokens = raw.map((t, i) => {
        let type = mapScopes(t.scopes);
        // The LAST member of a `.`-chain (the property, e.g. `City` in
        // `Model.Address.City`) gets the type/green color. The grammar can't tell
        // tail from intermediate (both are `…object.property`), so the tail is the
        // member NOT immediately followed by a `.` accessor.
        if (isMemberProperty(t.scopes)) {
          const n = nextMeaningful(i);
          const followedByDot = n !== -1 && tokenText(n) === ".";
          if (!followedByDot) type = "type";
        }
        return { startIndex: t.startIndex, scopes: type };
      });
      return { tokens, endState: new RazorTmState(result.ruleStack) };
    },
  };

  for (const id of RAZOR_LANG_IDS) {
    // Replaces the Monarch tokens provider registered in monacoSetup.
    monaco.languages.setTokensProvider(id, provider);
  }
}
