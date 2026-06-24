/**
 * Output channels store (issue #6).
 *
 * A tiny, framework-free pub/sub the whole app can append lines to (LSP
 * lifecycle, Git, the runner, app messages…) — the data behind the bottom
 * panel's "Saída" tab. Channels are created on first write; the panel renders
 * one at a time via a channel selector. Kept dependency-free so any module
 * (e.g. the LSP debug log) can push without importing React.
 */

/** Cap per channel so a chatty source can't grow memory unbounded. */
const MAX_LINES = 5000;

const channels = new Map<string, string[]>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version++;
  listeners.forEach((l) => l());
}

/** Appends `message` (split on newlines) to `channel`, creating it if needed. */
export function appendOutput(channel: string, message: string): void {
  let lines = channels.get(channel);
  if (!lines) {
    lines = [];
    channels.set(channel, lines);
  }
  for (const line of message.split("\n")) lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  notify();
}

/** Monotonic version — the stable snapshot for `useSyncExternalStore`. */
export function outputVersion(): number {
  return version;
}

/** Channel names, sorted for a stable selector order. */
export function outputChannels(): string[] {
  return [...channels.keys()].sort();
}

/** Lines currently buffered for `channel` (empty array if none). */
export function outputLines(channel: string): string[] {
  return channels.get(channel) ?? [];
}

export function subscribeOutput(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
