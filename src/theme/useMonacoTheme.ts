/**
 * Ponte React/Monaco do tema de cor ativo. Todo `<Editor>`/`<DiffEditor>` e
 * `monaco.editor.create*` do app usa `useMonacoThemeId()` (ou
 * `getActiveColorTheme().monacoId`) em vez de um nome fixo: o standalone do
 * Monaco aplica o tema GLOBALMENTE a cada criação, então um nome fixo
 * desfaria a troca de tema ao abrir um editor novo.
 */
import { useSyncExternalStore } from "react";
import type * as MonacoNS from "monaco-editor";
import { getActiveColorTheme, onDidChangeActiveColorTheme } from "./activeTheme";

const subscribe = (cb: () => void) => onDidChangeActiveColorTheme(() => cb());
const snapshot = () => getActiveColorTheme().monacoId;

export function useMonacoThemeId(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Define (idempotente) o tema ativo no Monaco e devolve o id — para `beforeMount`. */
export function defineActiveMonacoTheme(monaco: typeof MonacoNS): string {
  const t = getActiveColorTheme();
  if (t.monacoTheme) monaco.editor.defineTheme(t.monacoId, t.monacoTheme as MonacoNS.editor.IStandaloneThemeData);
  return t.monacoId;
}
