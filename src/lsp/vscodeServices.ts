/**
 * Boots the `@codingame/monaco-vscode-api` services exactly ONCE for the whole
 * app, then hands every later caller the same in-flight promise.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS REPLACES `MonacoServices.install(monaco)`
 * ──────────────────────────────────────────────────────────────────────────
 * In monaco-languageclient v1.x, `MonacoServices.install(monaco)` taught the
 * language client how to talk to a plain `monaco-editor` distribution. That API
 * is GONE in v10. Instead the client expects a subset of the REAL VS Code
 * services to be running, supplied by `@codingame/monaco-vscode-api`. We boot
 * just enough of them through the low-level `initialize(overrides)` entry point
 * (the pattern proven by spike #70 — see ADR 0003).
 *
 * Both `src/monaco-loader.ts` (app entry, before the first editor mounts) and
 * `src/lsp/client.ts` (before creating any language client) await this. It is
 * idempotent: the FIRST call starts `initialize()`; concurrent and later calls
 * share the same promise. Calling `initialize()` twice throws ("already
 * initialized"), so funnelling through here is mandatory.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SERVICE-OVERRIDE SET
 * ──────────────────────────────────────────────────────────────────────────
 * `initialize()` ALWAYS boots a base set on its own (layout, environment,
 * extension, files, quickAccess). On top of that we pass the minimal explicit
 * set a `MonacoLanguageClient` needs to bridge LSP <-> editor models:
 *
 *   - languages       registers language ids + the provider registries the
 *                     client's features (completion, hover, references,
 *                     semantic tokens, …) attach to.
 *   - log             the client + services emit through the VS Code logger.
 *   - model           text-model / resolver service: maps `file://` URIs to
 *                     ITextModel so didOpen/didChange have something to track.
 *   - configuration   settings store the client reads (per-language options).
 *
 * We deliberately STOP there — no editor/views/theme/textmate service
 * overrides. Rationale (audit §2, risk matrix):
 *   - The editor itself is still mounted by `@monaco-editor/react` as a
 *     STANDALONE editor (ADR 0003 keeps it via the `monaco-editor` alias). The
 *     workbench `editor-service-override` would compete with that and with our
 *     own `registerEditorOpener` (cross-file go-to-definition). Headless model
 *     services are all the LSP round-trip needs; the standalone editor brings
 *     its own theming (`defineTheme`) and Monarch tokenizer registration.
 *   - Theming stays on the STANDALONE theme path (`defineTheme`), which works
 *     without the VS Code theme/textmate services. Pulling those in would
 *     replace the standalone theme engine and silently drop our
 *     `fluent-acrylic-dark` rules. Note: `'semanticHighlighting.enabled'` is
 *     currently `false` (see EditorPane editor options) because the standalone
 *     theme path can't resolve LSP semantic-token colors; coloring is driven by
 *     the Monarch lexical tokenizer instead. Re-enabling semantic highlighting
 *     would require the full VS Code theme path (deferred follow-up).
 *
 * No `container` argument → headless services (no workbench DOM mounted), which
 * is exactly right when the editor is a standalone `@monaco-editor/react` view.
 */
import { initialize as initializeVscodeServices } from "@codingame/monaco-vscode-api/services";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
import { configureDefaultWorkerFactory } from "monaco-languageclient/workerFactory";
import { lspLog } from "./debug";

let servicesInitialized: Promise<void> | undefined;

/**
 * Boots the minimal VS Code services ONCE. Idempotent: concurrent callers share
 * the same in-flight promise, and later calls resolve immediately.
 *
 * The single replacement for v1.x's `ensureMonacoServices()` /
 * `MonacoServices.install(monaco)`.
 */
export function ensureVscodeServices(): Promise<void> {
  if (servicesInitialized) return servicesInitialized;

  // v10 wires Monaco's web workers through the enhanced `MonacoEnvironment`
  // (getWorkerUrl/getWorkerOptions), NOT the old `MonacoEnvironment.getWorker`
  // that returned bundled `json`/`css`/`html`/`ts` workers. The default factory
  // registers the only workers this stack needs at runtime: the editor worker
  // (diff/tokenization helpers) and the textmate worker. We don't ship the
  // vanilla language workers anymore — JSON/CSS/HTML/TS IntelliSense comes from
  // real LSP servers, and the embedded TS worker is disabled on purpose.
  configureDefaultWorkerFactory(undefined);

  // Each `getServiceOverride()` returns a slice of `IEditorOverrideServices`;
  // merge them into one overrides object. Order is irrelevant — they register
  // disjoint service identifiers.
  const serviceOverrides = {
    ...getLanguagesServiceOverride(),
    ...getLogServiceOverride(),
    ...getModelServiceOverride(),
    ...getConfigurationServiceOverride(),
  };

  // On success the resolved promise is cached forever (idempotent boot). On
  // FAILURE we must NOT keep the rejected promise around: `initialize()` never
  // ran to completion, so the services are not up, yet every later caller would
  // reuse the cached rejection and could never retry. Clear the cache in the
  // failure path so a subsequent `ensureVscodeServices()` attempts the boot
  // again, and re-throw so the current caller still sees the error.
  //
  // `cached` (not the pre-`.catch` promise) is what we store in
  // `servicesInitialized`, so the guard below compares against the SAME
  // reference — only evicting if no later call has already replaced the cache.
  const cached: Promise<void> = initializeVscodeServices(serviceOverrides)
    .then(() => {
      lspLog("@codingame/monaco-vscode-api services initialized");
    })
    .catch((err) => {
      lspLog("@codingame/monaco-vscode-api services FAILED to initialize", String(err));
      if (servicesInitialized === cached) servicesInitialized = undefined;
      throw err;
    });
  servicesInitialized = cached;

  return servicesInitialized;
}
