/**
 * Wiring for the "▶ Executar Teste" CodeLens (milestone #5): connects the pure
 * provider in `testCodeLens.ts` to the app's test runner and its UI.
 *
 * - Resolver: finds the test `.csproj` to run a lens against — the first project
 *   that looks like a test project (name ends in `Tests`/`Test`, or a `tests`
 *   folder) among the workspace `.csproj`s. Falls back to the first `.csproj` so
 *   a single-project solution still runs.
 * - Runner: dispatches a `fluent:run-test` CustomEvent carrying the csproj + FQN.
 *   The RunPanel's Tests section listens for it (running the test and showing the
 *   pass/fail inline, where the user expects results), and the App switches to
 *   the "Executar e Depurar" view. This reuses the app's existing event bus
 *   (`fluent:file-saved`, `fluent:debug-stopped`) instead of threading state.
 *
 * Kept out of `csharp.ts` so that module stays focused on Roslyn startup, and so
 * the async `installTestCodeLens` dynamic import is isolated here.
 */
import type { MonacoLanguageClient } from "monaco-languageclient";
import { listProjectFiles } from "../api";
import { addClientContributions } from "./client";
import { installTestCodeLens } from "./testCodeLens";
import { pickTestCsproj } from "./testProjectResolver.ts";
import { lspLog } from "./debug";

/** Event name the RunPanel + App listen for to run a test from a CodeLens. */
export const RUN_TEST_EVENT = "fluent:run-test";
/** Event name to DEBUG a test from a CodeLens (milestone #10). */
export const DEBUG_TEST_EVENT = "fluent:debug-test";

/** Detail payload of {@link RUN_TEST_EVENT} / {@link DEBUG_TEST_EVENT}. */
export interface RunTestEventDetail {
  csprojPath: string;
  fullyQualifiedName: string;
}

/**
 * Registers the "▶ Executar Teste" CodeLens for `.cs` and ties its disposables
 * to the C# client so "Resetar Servidores de Código" and workspace switches tear
 * it down. Best-effort: a failure here never breaks C# startup.
 */
export async function installCsharpTestCodeLens(
  client: MonacoLanguageClient,
  rootPath: string
): Promise<void> {
  try {
    const resolver = async (): Promise<string | null> => {
      const files = await listProjectFiles(rootPath);
      const csprojs = files
        .filter((f) => f.name.toLowerCase().endsWith(".csproj"))
        .map((f) => f.path);
      return pickTestCsproj(csprojs);
    };
    const dispatch = (event: string) => (
      csprojPath: string,
      fullyQualifiedName: string
    ): void => {
      window.dispatchEvent(
        new CustomEvent<RunTestEventDetail>(event, {
          detail: { csprojPath, fullyQualifiedName },
        })
      );
    };
    const disposables = await installTestCodeLens(
      resolver,
      dispatch(RUN_TEST_EVENT),
      dispatch(DEBUG_TEST_EVENT)
    );
    addClientContributions(client, disposables);
    lspLog("test CodeLens registered for csharp");
  } catch (err) {
    lspLog("test CodeLens registration failed (non-fatal)", String(err));
  }
}
