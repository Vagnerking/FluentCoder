/**
 * Single rollback point for the CSHTML projection broker (ADR 0002).
 *
 * When OFF (default), `.cshtml` keeps its current behavior: Monaco id
 * `aspnetcorerazor` → Roslyn cohost (which is blocked headless — see
 * `tools/razor-lsp-probe/FINDINGS-fase0.md` — but the routing is unchanged, so
 * there is zero regression risk in landing the projection code dark).
 *
 * When ON, `.cshtml` gets Monaco id `cshtml` → the projection starter
 * (`servers/razorProjection.ts`): the Razor compiler emits a projected `.g.cs`,
 * the standalone Roslyn analyzes it, and results are remapped back to the
 * `.cshtml` via `#line`. `.razor` (Blazor) always stays on the cohost.
 *
 * The flag is read live at every decision point (language mapping, registry,
 * lint) so flipping it + reloading the window is enough — no rebuild. Lido do
 * sistema de settings.
 */
import { settings } from "../settings/instance.ts";

/** Setting `fluent.razor.projection` (antes `localStorage["lsp.razorProjection"]`). */
export const RAZOR_PROJECTION_FLAG_KEY = "fluent.razor.projection";

/**
 * True when the CSHTML projection broker should serve `.cshtml`. Defaults to
 * false. Safe to call in non-browser contexts (returns false if `localStorage`
 * is unavailable, e.g. during SSR/tests).
 */
export function isRazorProjectionEnabled(): boolean {
  return settings.get<boolean>(RAZOR_PROJECTION_FLAG_KEY) === true;
}

/** Liga/desliga (setting do usuário). */
export function setRazorProjectionEnabled(on: boolean): Promise<void> {
  return settings.update(RAZOR_PROJECTION_FLAG_KEY, on, "user");
}
