/**
 * Format on save (roadmap csharp-ide-parity, Fase A1).
 *
 * The Roslyn LSP already announces `documentFormattingProvider` and the generic
 * monaco-languageclient bridge registers the corresponding Monaco provider for
 * `csharp` — so formatting is invoked through Monaco's own
 * `editor.action.formatDocument` action, with zero extra LSP plumbing here.
 *
 * Scope (documented behavior):
 *  - Applies to the languages in {@link FORMATTABLE_LANGUAGES} only.
 *  - Requires an ATTACHED editor (the active/visible tab). Background "save all"
 *    flows (close window / switch folder) write as-is — formatting a model with
 *    no editor is not supported by Monaco's action surface, and blocking a bulk
 *    save on N format round-trips would be worse than not formatting.
 *  - NEVER blocks or fails a save: any error/timeout falls back to saving the
 *    unformatted content.
 *
 * Follows the codebase's `localStorage` boolean-flag idiom (see
 * `razorProjectionFlag.ts`); flipping the flag needs no reload — it is read at
 * every save.
 */
import * as monaco from "monaco-editor";
import { toFileUri } from "./uri";
import { lspLog } from "./debug";

export const FORMAT_ON_SAVE_KEY = "editor.formatOnSave";

/** Languages whose LSP formatting is wired and trusted for on-save runs. */
const FORMATTABLE_LANGUAGES = new Set(["csharp"]);

/** A save must never hang on a slow/stuck formatter. */
const FORMAT_TIMEOUT_MS = 2000;

/** True when saves should format first. Defaults to false; safe without DOM. */
export function isFormatOnSaveEnabled(): boolean {
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(FORMAT_ON_SAVE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

/** Flip the flag; returns the new state. */
export function toggleFormatOnSave(): boolean {
  const next = !isFormatOnSaveEnabled();
  try {
    localStorage.setItem(FORMAT_ON_SAVE_KEY, next ? "1" : "0");
  } catch {
    /* storage unavailable — stays off */
  }
  return next;
}

/**
 * Format the open model for `path` (via its attached editor) and return the
 * formatted text, or `null` when formatting doesn't apply (flag off, language
 * not formattable, no editor attached, provider missing) or failed/timed out.
 * The caller saves `null` ⇒ the original content — a save never breaks here.
 */
export async function formatModelForSave(path: string): Promise<string | null> {
  if (!isFormatOnSaveEnabled()) return null;
  const model = monaco.editor.getModel(monaco.Uri.parse(toFileUri(path)));
  if (!model || model.isDisposed()) return null;
  if (!FORMATTABLE_LANGUAGES.has(model.getLanguageId())) return null;
  const editor = monaco.editor.getEditors().find((e) => e.getModel() === model);
  if (!editor) return null; // background tab — save as-is (see module docs)
  const action = editor.getAction("editor.action.formatDocument");
  if (!action) return null;
  try {
    await Promise.race([
      action.run(),
      new Promise((_, reject) =>
        window.setTimeout(
          () => reject(new Error(`format timed out after ${FORMAT_TIMEOUT_MS}ms`)),
          FORMAT_TIMEOUT_MS
        )
      ),
    ]);
  } catch (err) {
    lspLog("formatOnSave: skipped (save proceeds unformatted)", String(err));
    return null;
  }
  if (model.isDisposed()) return null;
  return model.getValue();
}
