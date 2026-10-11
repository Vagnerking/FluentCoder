/**
 * Registro de linguagens do Monaco → host de extensões (`setLanguages`):
 * `vscode.languages.getLanguages()` devolve as linguagens REAIS do editor e
 * `languages.match` compara com o mesmo `languageId` que o espelho do editor
 * (`editorBridge`) manda nos documentos.
 */
import * as monaco from "monaco-editor";
import { whenMonacoReady } from "../monaco-loader";
import { extHost, extLog } from "./client";

export interface LanguageInfo {
  id: string;
  aliases?: string[];
  extensions?: string[];
}

/** Snapshot enxuto (ids únicos; aliases/extensões com teto). */
export function languageSnapshot(list: { id: string; aliases?: string[]; extensions?: string[] }[]): LanguageInfo[] {
  const seen = new Set<string>();
  const out: LanguageInfo[] = [];
  for (const l of list) {
    if (!l.id || seen.has(l.id) || !/^[\w.+#-]+$/.test(l.id) || l.id.length > 128) continue;
    seen.add(l.id);
    out.push({ id: l.id, aliases: (l.aliases ?? []).slice(0, 64), extensions: (l.extensions ?? []).slice(0, 512) });
  }
  return out.slice(0, 2000);
}

/** Manda o registro ao host (a cada `hostReady`: startup ou reinício). */
export function publishLanguages(): void {
  void whenMonacoReady
    .then(() => extHost.notify("setLanguages", { languages: languageSnapshot(monaco.languages.getLanguages()) }))
    .catch((err) => extLog("setLanguages falhou", err));
}
