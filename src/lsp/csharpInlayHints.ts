/**
 * C# inlay hints toggle (milestone #5 — paridade C# Dev Kit).
 *
 * Roslyn emits inlay hints (parameter names, inferred `var` types, …) only when
 * its `csharp|inlay_hints.*` settings are ON. Those settings are PULLED at
 * runtime via `workspace/configuration` (answered in `csharpConfiguration.ts`),
 * so the values must reflect a user preference read live — not a build-time
 * constant. This module owns that preference.
 *
 * Like the C# extension out of the box, hints are OFF by default. Flipping the
 * flag re-nudges Roslyn (`didChangeConfiguration`) so it re-pulls and the native
 * inlay-hint provider starts/stops emitting — no reload needed. The Monaco editor
 * option `inlayHints.enabled` defaults to "on", so nothing else gates rendering.
 *
 * Follows the `localStorage` boolean-flag idiom (see `formatOnSave.ts`,
 * `razorProjectionFlag.ts`).
 */

export const CSHARP_INLAY_HINTS_KEY = "csharp.inlayHints";

/** The `csharp|inlay_hints.*` sections whose value tracks the toggle. Mirrors
 * the C# Dev Kit "enable everything" set: types + all parameter kinds. The
 * suppression sub-options stay ON (they only reduce noise) regardless. */
export const CSHARP_INLAY_HINT_ENABLE_SECTIONS: readonly string[] = [
  "csharp|inlay_hints.csharp_enable_inlay_hints_for_implicit_object_creation",
  "csharp|inlay_hints.csharp_enable_inlay_hints_for_implicit_variable_types",
  "csharp|inlay_hints.csharp_enable_inlay_hints_for_lambda_parameter_types",
  "csharp|inlay_hints.csharp_enable_inlay_hints_for_types",
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_indexer_parameters",
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_literal_parameters",
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_object_creation_parameters",
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_other_parameters",
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_parameters",
];

/** The suppression sub-options — kept ON so hints stay uncluttered when enabled
 * (matches the C# Dev Kit defaults). They are irrelevant while hints are OFF. */
export const CSHARP_INLAY_HINT_SUPPRESS_SECTIONS: readonly string[] = [
  "csharp|inlay_hints.dotnet_suppress_inlay_hints_for_parameters_that_differ_only_by_suffix",
  "csharp|inlay_hints.dotnet_suppress_inlay_hints_for_parameters_that_match_argument_name",
  "csharp|inlay_hints.dotnet_suppress_inlay_hints_for_parameters_that_match_method_intent",
];

/** True when C# inlay hints should be shown. Defaults to false; safe without DOM. */
export function isCsharpInlayHintsEnabled(): boolean {
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(CSHARP_INLAY_HINTS_KEY) === "1"
    );
  } catch {
    return false;
  }
}

/** Flip the flag; returns the new state. */
export function toggleCsharpInlayHints(): boolean {
  const next = !isCsharpInlayHintsEnabled();
  try {
    localStorage.setItem(CSHARP_INLAY_HINTS_KEY, next ? "1" : "0");
  } catch {
    /* storage unavailable — stays off */
  }
  return next;
}

/**
 * The `csharp|inlay_hints.*` overrides for the current toggle state, merged into
 * the base configuration table. Enable-sections follow the flag; suppression
 * sub-options are always ON (noise reduction). Returned as a plain map so
 * `csharpConfiguration.ts` can spread it over its defaults.
 */
export function csharpInlayHintConfiguration(
  enabled: boolean = isCsharpInlayHintsEnabled()
): Record<string, boolean> {
  const config: Record<string, boolean> = {};
  for (const section of CSHARP_INLAY_HINT_ENABLE_SECTIONS) {
    config[section] = enabled;
  }
  for (const section of CSHARP_INLAY_HINT_SUPPRESS_SECTIONS) {
    config[section] = true;
  }
  return config;
}
