/**
 * C# (Roslyn) workspace configuration.
 *
 * Roslyn's `Microsoft.CodeAnalysis.LanguageServer` does NOT read these settings
 * from `initialize.initializationOptions`. Instead it PULLS them at runtime with
 * `workspace/configuration`, requesting one section per option. If the client
 * leaves that request unanswered (or errors it), Roslyn falls back to its own
 * conservative defaults — most importantly `*_diagnostics_scope: "none"` — and
 * then reports NO compiler/analyzer diagnostics for open files. The visible
 * symptom is that a genuine error (e.g. an undefined enum member, CS0117) never
 * gets a squiggle even though the document is correctly bound to its project.
 *
 * So we answer `workspace/configuration` from this table, mirroring the defaults
 * the official C# extension (C# Dev Kit) ships. Unknown sections resolve to
 * `null`, which Roslyn treats as "use your default" — exactly the LSP contract.
 *
 * Section-name format (confirmed against the running server and vscode-csharp's
 * `optionNameConverter`): `"{language}|{group}.{name}"`, e.g.
 * `"csharp|background_analysis.dotnet_compiler_diagnostics_scope"`. The group
 * token itself contains a `|` (`csharp|background_analysis`); the option name is
 * everything after the FIRST `.` that follows the group.
 */

/**
 * The settings Roslyn pulls, keyed by `"{group}.{name}"` (the exact section the
 * server asks for). Values mirror the C# Dev Kit defaults. Keeping interactive
 * analysis scoped to open files (not the whole solution) matches our design:
 * full-solution verification stays behind the explicit rebuild command.
 */
export const CSHARP_CONFIGURATION: Readonly<Record<string, unknown>> = {
  // --- Background analysis: the settings that actually gate diagnostics ---
  "csharp|background_analysis.dotnet_analyzer_diagnostics_scope": "openFiles",
  "csharp|background_analysis.dotnet_compiler_diagnostics_scope": "openFiles",

  // --- Diagnostics reporting ---
  "csharp|diagnostics.dotnet_report_information_as_hint": true,

  // --- Completion ---
  "csharp|completion.dotnet_provide_regex_completions": true,
  "csharp|completion.dotnet_show_completion_items_from_unimported_namespaces": true,
  "csharp|completion.dotnet_show_name_completion_suggestions": true,
  "csharp|completion.dotnet_trigger_completion_in_argument_lists": true,

  // --- Symbol search ---
  "csharp|symbol_search.dotnet_search_reference_assemblies": true,

  // --- Code lens (references/tests adornments) ---
  "csharp|code_lens.dotnet_enable_references_code_lens": true,
  "csharp|code_lens.dotnet_enable_tests_code_lens": true,

  // --- Inlay hints: off by default, like the C# extension out of the box ---
  "csharp|inlay_hints.csharp_enable_inlay_hints_for_implicit_object_creation": false,
  "csharp|inlay_hints.csharp_enable_inlay_hints_for_implicit_variable_types": false,
  "csharp|inlay_hints.csharp_enable_inlay_hints_for_lambda_parameter_types": false,
  "csharp|inlay_hints.csharp_enable_inlay_hints_for_types": false,
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_indexer_parameters": false,
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_literal_parameters": false,
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_object_creation_parameters": false,
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_other_parameters": false,
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_parameters": false,
  "csharp|inlay_hints.dotnet_suppress_inlay_hints_for_parameters_that_differ_only_by_suffix": false,
  "csharp|inlay_hints.dotnet_suppress_inlay_hints_for_parameters_that_match_argument_name": false,
  "csharp|inlay_hints.dotnet_suppress_inlay_hints_for_parameters_that_match_method_intent": false,

  // --- Implement type generation preferences ---
  "csharp|implement_type.dotnet_insertion_behavior": "with_other_members_of_the_same_kind",
  "csharp|implement_type.dotnet_property_generation_behavior": "prefer_throwing_properties",
};

/** Shape of a `workspace/configuration` request's params. */
export interface ConfigurationParams {
  items: Array<{ section?: string }>;
}

/**
 * Answers a `workspace/configuration` request: one value per requested item, in
 * order. A known section returns its configured value; anything else returns
 * `null` so Roslyn keeps its own default (the LSP-defined "unset" answer). The
 * returned array length always matches `items.length`, as the protocol requires.
 */
export function resolveConfigurationSections(
  params: ConfigurationParams
): unknown[] {
  const items = params?.items ?? [];
  return items.map((item) => {
    const section = item?.section;
    if (section && Object.prototype.hasOwnProperty.call(CSHARP_CONFIGURATION, section)) {
      return CSHARP_CONFIGURATION[section];
    }
    return null;
  });
}
