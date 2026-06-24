// @ts-check
/**
 * Fase A compat spike — prove Shiki can colorize `.cshtml` HEADLESS before any
 * production tokenizer swap (the plan mandates the spike first).
 *
 * Loads the bundled `razor` TextMate grammar + the `dark-plus`/`light-plus`
 * themes via `shiki`, tokenizes a real `.cshtml` snippet, and asserts that:
 *   - the engine loads and tokenizes without throwing (WASM Oniguruma in Node),
 *   - embedded languages resolve (razor transition, C#, HTML, CSS all present),
 *   - the theme assigns real colors (not all default foreground).
 * If green, the engine/grammars are compatible and the production swap can be
 * wired behind a flag with semantic tokens layered on top. Read-only.
 *
 * Run: node tools/razor-lsp-probe/spike-shiki.mjs
 */
import { createHighlighter } from "shiki";

const SAMPLE = `@model SampleMvc.Models.WeatherModel
@{
    var greeting = "Olá";
}
<!DOCTYPE html>
<html>
<head>
    <style>.title { color: red; }</style>
    <title>@Model.City</title>
</head>
<body>
    <h1>@greeting, @Model.City</h1>
    <a asp-controller="Home" asp-action="Index">Início</a>
</body>
</html>
`;

function fail(msg) {
  console.error("SPIKE FAIL:", msg);
  process.exit(1);
}

async function main() {
  const hl = await createHighlighter({
    themes: ["dark-plus", "light-plus"],
    langs: ["razor"],
  });

  // `razor` must be loaded (it pulls its embedded grammars: html/css/c#).
  const loaded = hl.getLoadedLanguages();
  console.log("loaded langs:", loaded.join(", "));
  if (!loaded.includes("razor")) fail("razor grammar not loaded");

  const { tokens } = hl.codeToTokens(SAMPLE, {
    lang: "razor",
    theme: "dark-plus",
    includeExplanation: "scopeName",
  });

  const flat = tokens.flat();
  if (flat.length === 0) fail("no tokens produced");

  // Collect the distinct TextMate scopes that fired.
  const scopes = new Set();
  for (const t of flat) {
    for (const e of t.explanation ?? []) {
      for (const s of e.scopes ?? []) scopes.add(s.scopeName);
    }
  }
  const allScopes = [...scopes];
  const has = (re) => allScopes.some((s) => re.test(s));

  const checks = {
    razorTransition: has(/razor|cshtml/i),
    csharp: has(/source\.cs|cs\b|csharp/i),
    html: has(/text\.html|meta\.tag|entity\.name\.tag/i),
    css: has(/source\.css|css/i),
  };
  console.log("scope checks:", checks);
  console.log("sample scopes:", allScopes.slice(0, 25).join("\n  "));

  // Theme actually colored things (more than one distinct color → not all-default).
  const colors = new Set(flat.map((t) => t.color).filter(Boolean));
  console.log("distinct colors:", colors.size);
  if (colors.size < 3) fail(`theme produced too few colors (${colors.size})`);

  const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length) {
    console.warn("WARN missing scope families:", missing.join(", "));
  }

  // Hard gate: razor + C# + html must all be present (the core of `.cshtml`).
  if (!checks.razorTransition || !checks.csharp || !checks.html) {
    fail(`core embedded langs missing: ${missing.join(", ")}`);
  }

  console.log("\nSPIKE PASS: shiki tokenizes .cshtml with razor+C#+html+theme colors.");
}

main().catch((e) => fail(String(e && e.stack ? e.stack : e)));
