/**
 * Settings no editor em execução (Monaco + Tauri). A parte pura está em
 * `editorSettings.ts`/`editorconfig.ts`; aqui:
 *
 * - `useEditorSettingsOptions(languageId, path)`: opções do editor (React),
 *   recalculadas só quando uma setting muda;
 * - `attachEditorSettings(editor)`: aplica tabSize/insertSpaces/detecção ao
 *   MODELO (com `.editorconfig`) a cada troca de modelo e mudança de setting;
 * - `editorConfigFor(path)`: cadeia de `.editorconfig` resolvida (cache
 *   invalidado quando um `.editorconfig` é salvo pelo app ou a janela volta ao foco);
 * - indentação do editor ativo para a barra de status.
 */
import { useMemo, useSyncExternalStore } from "react";
import type * as MonacoNs from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { fontStacks } from "../platform/fonts";
import { getPlatform } from "../platform/os";
import { fromFileUri } from "../lsp/uri";
import { settings } from "./instance";
import { useSettingsVersion } from "./react";
import {
  editorConfigOverrides,
  resolveEditorConfig,
  type EditorConfigFile,
  type EditorConfigOverrides,
} from "./editorconfig";
import {
  applySaveTransforms,
  editorOptionsFromSettings,
  indentationFor,
  newFileEncoding,
  newFileEol,
  saveTransformsFor,
} from "./editorSettings";

// ------------------------------------------------------------ .editorconfig

const ecCache = new Map<string, Promise<EditorConfigOverrides>>();
const ecResolved = new Map<string, EditorConfigOverrides>();
const ecListeners = new Set<() => void>();
let ecVersion = 0;

function isLocalPath(path: string): boolean {
  return !!path && !path.startsWith("untitled:") && !path.includes("://") && (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path));
}

export function editorConfigFor(path: string): Promise<EditorConfigOverrides> {
  if (!isLocalPath(path)) return Promise.resolve({});
  let p = ecCache.get(path);
  if (!p) {
    p = invoke<EditorConfigFile[]>("editorconfig_chain", { path })
      .then((chain) => editorConfigOverrides(resolveEditorConfig(chain, path)))
      .catch(() => ({}) as EditorConfigOverrides)
      .then((o) => {
        ecResolved.set(path, o);
        return o;
      });
    ecCache.set(path, p);
  }
  return p;
}

/** Já resolvido (síncrono) — `{}` enquanto não carregou. */
export function editorConfigSync(path: string | null | undefined): EditorConfigOverrides {
  return (path && ecResolved.get(path)) || {};
}

export function invalidateEditorConfig(): void {
  ecCache.clear();
  ecResolved.clear();
  ecVersion++;
  for (const l of [...ecListeners]) l();
}

let invalidationInstalled = false;
function installInvalidation(): void {
  if (invalidationInstalled || typeof window === "undefined") return;
  invalidationInstalled = true;
  window.addEventListener("fluent:file-saved", (e) => {
    const path = (e as CustomEvent<{ path?: string }>).detail?.path ?? "";
    if (/(^|[\\/])\.editorconfig$/.test(path)) invalidateEditorConfig();
  });
  // Editado fora do app: relê ao voltar para a janela.
  window.addEventListener("focus", () => {
    if (ecCache.size) invalidateEditorConfig();
  });
}

// ---------------------------------------------------------------- opções

function reduceMotion(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-reduce-motion");
}

/** Opções do Monaco vindas das settings (+ régua do `max_line_length`). */
export function useEditorSettingsOptions(languageId: string | null | undefined, path: string | null | undefined): Record<string, unknown> {
  installInvalidation();
  const version = useSettingsVersion();
  const ecV = useSyncExternalStore(
    (cb) => {
      ecListeners.add(cb);
      return () => ecListeners.delete(cb);
    },
    () => ecVersion,
  );
  return useMemo(() => {
    const opts = { languageId: languageId ?? null, resource: path ?? null };
    const ec = editorConfigSync(path);
    return editorOptionsFromSettings((k) => settings.get(k, opts), { monoFont: fontStacks().mono, reduceMotion: reduceMotion() }, ec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ecV, languageId, path]);
}

// ------------------------------------------------------------- indentação

export interface ActiveIndentation {
  tabSize: number;
  insertSpaces: boolean;
  source: "editorconfig" | "settings" | "detected";
}

let active: ActiveIndentation = { tabSize: 2, insertSpaces: true, source: "settings" };
const activeListeners = new Set<() => void>();

function setActive(next: ActiveIndentation): void {
  if (next.tabSize === active.tabSize && next.insertSpaces === active.insertSpaces && next.source === active.source) return;
  active = next;
  for (const l of [...activeListeners]) l();
}

export function useActiveIndentation(): ActiveIndentation {
  return useSyncExternalStore(
    (cb) => {
      activeListeners.add(cb);
      return () => activeListeners.delete(cb);
    },
    () => active,
  );
}

let editorCount = 0;
function monacoEditorCount(): number {
  return editorCount;
}

function pathOfModel(model: MonacoNs.editor.ITextModel): string | null {
  return model.uri.scheme === "file" ? fromFileUri(model.uri.toString()) : null;
}

async function applyIndentation(model: MonacoNs.editor.ITextModel, report: () => boolean): Promise<void> {
  const path = pathOfModel(model);
  const ec = path ? await editorConfigFor(path) : {};
  if (model.isDisposed()) return;
  const opts = { languageId: model.getLanguageId(), resource: path };
  const d = indentationFor((k) => settings.get(k, opts), ec);
  if (d.detect) model.detectIndentation(d.insertSpaces, d.tabSize);
  else model.updateOptions({ tabSize: d.tabSize, indentSize: d.indentSize, insertSpaces: d.insertSpaces });
  if (report()) {
    const o = model.getOptions();
    setActive({ tabSize: o.tabSize, insertSpaces: o.insertSpaces, source: d.detect ? "detected" : d.source });
  }
}

/**
 * Liga as settings de indentação ao editor: aplica ao modelo atual, a cada
 * troca de modelo e quando `editor.tabSize`/`insertSpaces`/`detectIndentation`
 * mudam. Devolve o dispose.
 */
export function attachEditorSettings(editor: MonacoNs.editor.IStandaloneCodeEditor): () => void {
  installInvalidation();
  editorCount++;
  const run = () => {
    const model = editor.getModel();
    // Reporta à barra de status se este é o editor focado (ou o único).
    if (model) void applyIndentation(model, () => editor.hasTextFocus() || monacoEditorCount() <= 1);
  };
  run();
  const d1 = editor.onDidChangeModel(run);
  const d2 = editor.onDidFocusEditorText(() => {
    const model = editor.getModel();
    if (!model) return;
    const o = model.getOptions();
    setActive({ tabSize: o.tabSize, insertSpaces: o.insertSpaces, source: active.source });
  });
  const d3 = editor.onDidChangeModelLanguage(run);
  const off = settings.onDidChange((e) => {
    if (e.affectsConfiguration("editor.tabSize") || e.affectsConfiguration("editor.insertSpaces") || e.affectsConfiguration("editor.detectIndentation")) run();
  });
  const onEc = () => run();
  ecListeners.add(onEc);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    editorCount = Math.max(0, editorCount - 1);
    d1.dispose();
    d2.dispose();
    d3.dispose();
    d4.dispose();
    off();
    ecListeners.delete(onEc);
  };
  const d4 = editor.onDidDispose(dispose);
  return dispose;
}

// --------------------------------------------------------------- salvamento

export interface PreparedSave {
  content: string;
  /** Só para arquivo novo (sem EOL/encoding detectados). */
  eol?: "Lf" | "Crlf";
  encoding?: string;
  bom?: boolean;
}

/**
 * Pipeline de salvamento depois do format-on-save: trim de espaços / nova
 * linha final (settings ou `.editorconfig`) e EOL/encoding de arquivo novo.
 */
export async function prepareSave(
  path: string,
  content: string,
  languageId: string | null,
  isNewFile: boolean,
): Promise<PreparedSave> {
  const ec = await editorConfigFor(path);
  const opts = { languageId, resource: path };
  const get = (k: string) => settings.get(k, opts);
  const out: PreparedSave = { content: applySaveTransforms(content, saveTransformsFor(get, ec)) };
  if (isNewFile) {
    out.eol = newFileEol(get, ec, getPlatform().os === "windows");
    const enc = newFileEncoding(get, ec);
    out.encoding = enc.id;
    out.bom = enc.bom;
  }
  return out;
}
