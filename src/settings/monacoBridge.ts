/**
 * Settings → serviço de configuração do VS Code dentro do Monaco
 * (`@codingame/monaco-vscode-configuration-service-override`, já carregado em
 * `lsp/vscodeServices.ts`). Não cria outro Monaco nem outro serviço: só
 * alimenta o "settings.json do usuário" desse serviço com `updateUserConfiguration`.
 *
 * Por que um SUBCONJUNTO: os servidores de linguagem ligados pelo
 * monaco-languageclient respondem `workspace/configuration` a partir desse
 * serviço (Pyright lê `python.analysis.*`, YAML lê `yaml.*`…), e os modelos
 * nascem com `editor.tabSize`/`insertSpaces` dele. Já opções que o app TRAVA
 * (`editor.semanticHighlighting.enabled`, `editor.wordBasedSuggestions` — ver
 * docs/context/editor.md) nunca passam daqui, mesmo que um `.vscode/settings.json`
 * as traga: são forçadas aos valores do contrato.
 */
import { settings } from "./instance.ts";
import { languagesOfKey } from "./model.ts";

/** Chaves de editor que o serviço usa para os modelos. */
const EDITOR_KEYS = new Set(["editor.tabSize", "editor.insertSpaces", "editor.detectIndentation", "files.eol", "files.associations"]);
/** Seções lidas pelos servidores de linguagem via `workspace/configuration`. */
const SERVER_SECTIONS = ["python.", "yaml.", "json.", "css.", "scss.", "less.", "html.", "typescript.", "javascript.", "dart.", "go.", "bashIde.", "docker."];
/** Contratos do editor (não podem ser ligados por settings). */
const LOCKED: Record<string, unknown> = {
  "editor.semanticHighlighting.enabled": false,
  "editor.wordBasedSuggestions": "off",
};

export function bridgedKey(key: string): boolean {
  if (key in LOCKED) return false;
  return EDITOR_KEYS.has(key) || SERVER_SECTIONS.some((s) => key.startsWith(s));
}

/** JSON do "user settings" do serviço do Monaco (puro: recebe as chaves efetivas). */
export function monacoUserConfiguration(
  keys: Iterable<string>,
  get: (key: string, languageId?: string) => unknown,
  languages: Iterable<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...LOCKED };
  const keyList = [...keys].filter(bridgedKey);
  for (const k of keyList) {
    const v = get(k);
    if (v !== undefined) out[k] = v;
  }
  for (const lang of languages) {
    const o: Record<string, unknown> = {};
    for (const k of keyList) {
      const general = get(k);
      const v = get(k, lang);
      if (v !== undefined && JSON.stringify(v) !== JSON.stringify(general)) o[k] = v;
    }
    if (Object.keys(o).length) out[`[${lang}]`] = o;
  }
  return out;
}

let installed = false;

export function installMonacoSettingsBridge(whenReady: Promise<unknown>): void {
  if (installed) return;
  installed = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = async () => {
    const { updateUserConfiguration } = await import("@codingame/monaco-vscode-configuration-service-override");
    const model = settings.model;
    const langs = new Set<string>();
    for (const l of [model.defaults, model.user, model.workspace]) for (const id of Object.keys(l.overrides)) langs.add(id);
    const json = monacoUserConfiguration(model.allKeys(), (k, lang) => settings.get(k, { languageId: lang ?? null }), langs);
    await updateUserConfiguration(JSON.stringify(json, null, 2));
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void push().catch((err) => console.warn("[settings] Monaco", err)), 50);
  };
  void whenReady.then(schedule);
  settings.onDidChange((e) => {
    for (const k of e.keys) {
      if (bridgedKey(k) || languagesOfKey(k)) {
        schedule();
        return;
      }
    }
  });
}
