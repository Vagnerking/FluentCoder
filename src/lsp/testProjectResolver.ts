/**
 * Pure helpers for choosing which `.csproj` runs a "▶ Executar Teste" CodeLens
 * (milestone #5). Leaf module — no Monaco/LSP imports, so it unit-tests under
 * `node --test`. The wiring in `csharpTestCodeLensWiring.ts` consumes these.
 */

/** True when a `.csproj` path looks like a test project. The filename must end
 *  in `Test`/`Tests` at a word boundary (so `Greatest.csproj` doesn't match),
 *  or live under a `test`/`tests` folder. */
export function looksLikeTestProject(csprojPath: string): boolean {
  const lower = csprojPath.toLowerCase().replace(/\\/g, "/");
  const file = lower.split("/").pop() ?? lower;
  return (
    /(?:^|[^a-z])tests?\.csproj$/.test(file) ||
    lower.includes("/test/") ||
    lower.includes("/tests/")
  );
}

/**
 * Picks the test `.csproj` to run a lens against from the workspace's project
 * files: the first test-looking project, else the first project at all (so a
 * single-project repo still runs). Returns null when there are no `.csproj`s.
 */
export function pickTestCsproj(csprojPaths: readonly string[]): string | null {
  if (csprojPaths.length === 0) return null;
  return csprojPaths.find(looksLikeTestProject) ?? csprojPaths[0];
}
