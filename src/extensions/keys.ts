/**
 * Teclado entre os webviews das extensões e o app (como o VS Code faz com os
 * webviews): o preâmbulo do iframe sobe os atalhos não tratados pela própria
 * extensão (`{type:'key'}`); aqui primeiro tentamos os `keybindings`
 * contribuídos pelas extensões (com o contexto "foco num webview") e, se
 * nenhum valer, re-disparamos o atalho no documento do app — a Paleta
 * (Ctrl+Shift+P), Ctrl+P, Ctrl+B, Ctrl+` etc. funcionam com o foco no chat.
 */
import { extHost } from "./client";
import { chordFromKey, normalizeChord, type KeyLike } from "./editorModel";
import type { ContributedKeybinding } from "./protocol";

let bindings = new Set<string>();

/** Atualiza o conjunto de acordes contribuídos (das extensões instaladas). */
export function setContributedKeybindings(list: ContributedKeybinding[]): void {
  bindings = new Set(list.map((k) => normalizeChord(k.key)));
}

export function hasContributedChord(chord: string): boolean {
  return bindings.has(chord);
}

/** Re-dispara a tecla no app (os atalhos do App escutam `keydown` na window/document). */
export function redispatchKey(k: KeyLike & { repeat?: boolean }): void {
  const ev = new KeyboardEvent("keydown", {
    key: k.key,
    code: k.code,
    ctrlKey: !!k.ctrl,
    shiftKey: !!k.shift,
    altKey: !!k.alt,
    metaKey: !!k.meta,
    repeat: !!k.repeat,
    bubbles: true,
    cancelable: true,
  });
  (document.body ?? document.documentElement).dispatchEvent(ev);
}

/** Tecla vinda de um iframe de webview (já validada pelo relay). */
export async function handleForwardedKey(k: KeyLike & { repeat?: boolean }, webview: { viewType: string; kind: string }): Promise<void> {
  const chord = chordFromKey(k);
  if (bindings.has(chord) && extHost.running) {
    try {
      const r = (await extHost.call("runKeybinding", {
        key: chord,
        context: {
          webviewFocus: true,
          editorFocus: false,
          editorTextFocus: false,
          panelFocus: false,
          sideBarFocus: webview.kind === "view",
          activeWebviewPanelId: webview.kind === "panel" ? webview.viewType : undefined,
          focusedView: webview.kind === "view" ? webview.viewType : undefined,
        },
      })) as { handled?: boolean } | null;
      if (r?.handled) return;
    } catch {
      /* host indisponível: segue para o app */
    }
  }
  redispatchKey(k);
}

/**
 * Atalhos contribuídos digitados no EDITOR (ex.: Alt+K "inserir @-menção" do
 * Claude Code). Só acordes cujo `when` cita `editorTextFocus` — os demais
 * poderiam roubar atalhos do app. Devolve um listener de `keydown` (captura).
 */
export function editorKeybindingListener(list: () => ContributedKeybinding[]): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (e.defaultPrevented || !extHost.running) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest?.(".monaco-editor")) return;
    const chord = chordFromKey({ key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
    const match = list().filter((k) => normalizeChord(k.key) === chord && /\beditorTextFocus\b/.test(k.when ?? "") && !/!\s*editorTextFocus/.test(k.when ?? ""));
    if (match.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    void extHost.call("runKeybinding", { key: chord, context: { editorFocus: true, editorTextFocus: true, webviewFocus: false, panelFocus: false } }).catch(() => {});
  };
}
