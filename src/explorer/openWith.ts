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

/** Extensions the video player mode applies to. */
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi"]);

/** Extensions the audio player mode applies to. */
const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "ogg",
  "oga",
  "flac",
  "m4a",
  "aac",
  "opus",
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

/** True when `path` is a video type the player mode can render. */
export function isVideoPath(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(path));
}

/** True when `path` is an audio type the player mode can render. */
export function isAudioPath(path: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionOf(path));
}

/** True when `path` is any previewable media (image/video/audio). */
export function isMediaPath(path: string): boolean {
  return isImagePath(path) || isVideoPath(path) || isAudioPath(path);
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
    // Default for everything that isn't previewable media.
    isDefaultFor: (path) => !isMediaPath(path),
  },
  {
    mode: "image",
    label: "Visualização de Imagem",
    icon: "imagePreview",
    appliesTo: (path) => isImagePath(path),
    isDefaultFor: (path) => isImagePath(path),
  },
  {
    mode: "video",
    label: "Reproduzir Vídeo",
    icon: "video",
    appliesTo: (path) => isVideoPath(path),
    isDefaultFor: (path) => isVideoPath(path),
  },
  {
    mode: "audio",
    label: "Reproduzir Áudio",
    icon: "audio",
    appliesTo: (path) => isAudioPath(path),
    isDefaultFor: (path) => isAudioPath(path),
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
