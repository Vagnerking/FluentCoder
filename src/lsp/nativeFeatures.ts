/**
 * Disabling native `vscode-languageclient` features so our hand-written bridges
 * stay the SINGLE provider per feature/language (audit §2 — the highest-risk
 * area of the v10 migration).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE PROBLEM (1.x → v10)
 * ──────────────────────────────────────────────────────────────────────────
 * On the v10 `@codingame/monaco-vscode-api` stack the real VS Code services are
 * running, so `vscode-languageclient`'s built-in features (SemanticTokens,
 * Diagnostic, References, …) now AUTO-REGISTER a working Monaco provider from
 * the server's `initialize` capabilities. This project ALSO installs manual
 * bridges that encode hard-won behavior the native features don't:
 *   - semantic tokens: the C# provisional→definitive stabilization race
 *     (`stabilize`, discard-stale-response) — without it, `DateTime`/enums flip
 *     back to `variable` (a direct `editor.md` contract);
 *   - diagnostics: owner-based marker dedup keyed by `serverId`, plus a manual
 *     pull loop for Roslyn (which omits `diagnosticProvider` from initialize);
 *   - references: the `editor.action.showReferences` CodeLens override that
 *     converts raw LSP `Location[]` before opening the peek.
 * Running BOTH = two providers for the same selector → flicker/overwrite,
 * duplicated markers, doubled peek. So the decision (ADR 0003 / #76) is to KEEP
 * the manual bridges and DISABLE the native features.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HOW WE DISABLE A FEATURE
 * ──────────────────────────────────────────────────────────────────────────
 * In `vscode-languageclient@9` a feature is a `DynamicFeature`/`StaticFeature`
 * with NO `.dispose()` (that existed on the 1.x shim). The provider is created
 * inside the feature's `initialize(capabilities, selector)` — called during
 * `client.start()` for statically-advertised capabilities — and via `register`
 * for dynamic ones. To stop the native provider from ever attaching we replace
 * BOTH `initialize` and `register` with no-ops BEFORE `start()`, while leaving
 * `fillClientCapabilities` untouched so the client still advertises support and
 * the server still offers the feature (our bridge then drives it directly).
 *
 * This must run before `client.start()`. The same trick handled the v1.x
 * "unsupported" crash (old `neutralizeBuiltinDiagnosticFeature`); here it serves
 * the deduplication mandate instead.
 */
import type { MonacoLanguageClient } from "monaco-languageclient";
import { lspLog } from "./debug";

/** LSP request methods whose native client feature we may want to neutralize. */
export type NativeFeatureMethod =
  | "textDocument/semanticTokens"
  | "textDocument/diagnostic"
  | "textDocument/references";

/** A feature object as returned by `client.getFeature(...)`, narrowed to the
 * lifecycle hooks we override. All optional so we never assume a shape. */
interface NeutralizableFeature {
  initialize?: (...args: unknown[]) => void;
  register?: (...args: unknown[]) => void;
}

/**
 * Neutralizes the native client feature for `method` so it registers no Monaco
 * provider, leaving the matching manual bridge as the sole provider. Returns
 * `true` if a feature was found and patched. Never throws — a guard here must
 * not break `client.start()`.
 */
export function disableNativeClientFeature(
  client: MonacoLanguageClient,
  serverId: string,
  method: NativeFeatureMethod
): boolean {
  try {
    // The typed `getFeature` overloads don't cover passing a bare method string
    // for our neutralization purpose, so resolve through a narrow cast.
    const feature = (client as unknown as {
      getFeature(method: string): NeutralizableFeature | undefined;
    }).getFeature(method);
    if (!feature) {
      lspLog("native feature absent (nothing to disable)", serverId, method);
      return false;
    }
    let patched = false;
    if (typeof feature.initialize === "function") {
      feature.initialize = () => {};
      patched = true;
    }
    if (typeof feature.register === "function") {
      feature.register = () => {};
      patched = true;
    }
    if (patched) lspLog("native feature disabled (bridge owns it)", serverId, method);
    return patched;
  } catch (err) {
    lspLog("could not disable native feature", serverId, method, String(err));
    return false;
  }
}
