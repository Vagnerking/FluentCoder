/**
 * "Open With…" mode registry (ISSUE-70).
 *
 * The list of ways a file can be opened is modeled as DATA, not as `if/else`
 * spread across the app: each entry declares the {@link OpenMode} it produces,
 * a label, a central-map codicon, a predicate `appliesTo(path)`, and which type
 * it is the default for. The selector merely filters by `appliesTo` and routes
 * the chosen `mode` back to the App — so adding a future mode (hex, markdown
 * preview, …) is one new entry here, with no change to the selector UI.
 */
import type { OpenMode, OpenWithMode } from "../types";

/** Extensions the image preview mode applies to. */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svg",
  "avif",
]);

/** Lowercased extension of `path` without the dot ("" when none). */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** True when `path` is an image type the preview mode can render. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

/**
 * The registered modes. Order is the display order in the selector. The Text
 * Editor applies to everything (the universal fallback); Image Preview only to
 * image files and is the default there — matching the double-click behavior so
 * the user is never surprised.
 */
export const OPEN_WITH_MODES: OpenWithMode[] = [
  {
    mode: "text",
    label: "Editor de Texto",
    icon: "textEditor",
    appliesTo: () => true,
    // Default for everything that isn't an image.
    isDefaultFor: (path) => !isImagePath(path),
  },
  {
    mode: "image",
    label: "Visualização de Imagem",
    icon: "imagePreview",
    appliesTo: (path) => isImagePath(path),
    isDefaultFor: (path) => isImagePath(path),
  },
];

/** The modes that can open `path`, in display order. */
export function applicableModes(path: string): OpenWithMode[] {
  return OPEN_WITH_MODES.filter((m) => m.appliesTo(path));
}

/**
 * The default mode for `path` — the one a plain double-click uses. Falls back to
 * `"text"` if (somehow) nothing claims to be the default.
 */
export function defaultModeFor(path: string): OpenMode {
  const match = OPEN_WITH_MODES.find((m) => m.isDefaultFor?.(path));
  return match?.mode ?? "text";
}
