/**
 * Atalhos do usuário em execução: registro dos comandos do app (os da Paleta,
 * publicados pelo App), contexto de `when` e o listener de teclado.
 *
 * Convivência com o handler de teclado do App (que continua tratando os
 * atalhos embutidos) e com o Monaco:
 * - regra do usuário (ou embutida que o App não trata, ex.: Ctrl+,) que casa →
 *   executa o comando e consome a tecla (preventDefault + stopPropagation, na
 *   fase de captura: vence o editor, como no VS Code);
 * - atalho embutido que o App trata e o usuário não mexeu → nada (o App trata);
 * - atalho embutido REMOVIDO pelo usuário (`-command`) → a tecla segue para o
 *   editor/WebView, mas o handler do App a ignora (`isKeyClaimed`);
 * - 1º acorde de uma sequência (`ctrl+k`) nunca é consumido: o Monaco e o App
 *   armam os próprios acordes (Ctrl+K Ctrl+C do editor continua valendo).
 */
import * as monaco from "monaco-editor";
import { extHost } from "../extensions/client";
import { settings } from "./instance";
import {
  APP_HANDLED_KEYS,
  DEFAULT_APP_KEYBINDINGS,
  canonicalCommand,
  chordFromEvent,
  matchKeybinding,
  parseKeybindingsJson,
  resolveKeybindings,
  type KeybindingRule,
} from "./keybindings";

export interface AppCommand {
  id: string;
  title: string;
  detail?: string;
  keybinding?: string;
  run: (args?: unknown) => void;
}

let appCommands = new Map<string, AppCommand>();
let fallbackRunner: ((command: string, args?: unknown) => boolean) | null = null;
let whenProvider: (() => Record<string, unknown>) | null = null;
let extensionRules: KeybindingRule[] = [];
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version++;
  for (const l of [...listeners]) l();
}

export function onKeybindingsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function keybindingsVersion(): number {
  return version;
}

/** O App publica os comandos da Paleta (ids iguais aos de lá). */
export function setAppCommands(commands: readonly AppCommand[]): void {
  appCommands = new Map(commands.map((c) => [c.id, c]));
  changed();
}

export function getAppCommands(): AppCommand[] {
  return [...appCommands.values()];
}

/** Executor para ids que não são do app (`editor.action.*`, comandos de extensões). */
export function setFallbackCommandRunner(fn: (command: string, args?: unknown) => boolean): void {
  fallbackRunner = fn;
}

/** Contexto extra do `when` vindo do App (linguagem/arquivo ativo…). */
export function setWhenContextProvider(fn: () => Record<string, unknown>): void {
  whenProvider = fn;
}

/** Atalhos contribuídos pelas extensões (só exibição/conflitos; o host os executa). */
export function setExtensionKeybindings(rules: KeybindingRule[]): void {
  extensionRules = rules;
  changed();
}

export function userKeybindingsText(): string | null {
  const path = settings.settingsPaths?.userKeybindings;
  return path ? settings.textOf(path) : null;
}

let cache: { text: string | null; v: number; rules: KeybindingRule[]; errors: string[] } | null = null;

/** Regras do usuário + efetivas (padrões do app e das extensões, com remoções). */
export function currentKeybindings(): { user: KeybindingRule[]; effective: KeybindingRule[]; errors: string[] } {
  const text = userKeybindingsText();
  if (!cache || cache.text !== text || cache.v !== version) {
    const parsed = parseKeybindingsJson(text);
    cache = { text, v: version, rules: parsed.rules, errors: parsed.errors };
  }
  const user = cache.rules;
  return { user, effective: resolveKeybindings([...DEFAULT_APP_KEYBINDINGS, ...extensionRules], user), errors: cache.errors };
}

export function runCommand(command: string, args?: unknown): boolean {
  const id = canonicalCommand(command);
  const cmd = appCommands.get(id) ?? appCommands.get(`menu.${id}`);
  if (cmd) {
    cmd.run(args);
    return true;
  }
  if (fallbackRunner?.(id, args)) return true;
  // Ações do Monaco (`editor.action.*`, `actions.find`…) no editor focado.
  const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus() || e.hasWidgetFocus());
  const action = editor?.getAction(id);
  if (action) {
    void action.run(args);
    return true;
  }
  // Comandos de extensões hospedadas (ativa a extensão se preciso).
  if (extHost.info && /^[\w.-]+\.[\w.-]+$/.test(id)) {
    void extHost.call("executeCommand", { command: id, args: args === undefined ? [] : [args] }).catch(() => {});
    return true;
  }
  return false;
}

function focusContext(): Record<string, unknown> {
  const el = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  const inMonaco = !!el?.closest?.(".monaco-editor");
  const inTerminal = !!el?.closest?.(".xterm");
  const isInput = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) && !inMonaco && !inTerminal;
  return {
    editorTextFocus: inMonaco && el?.tagName === "TEXTAREA",
    editorFocus: inMonaco,
    textInputFocus: isInput || (inMonaco && el?.tagName === "TEXTAREA"),
    inputFocus: isInput,
    terminalFocus: inTerminal,
  };
}

export function whenContext(): (key: string) => unknown {
  const extra = { ...focusContext(), ...(whenProvider?.() ?? {}) };
  return (key: string) => {
    if (key in extra) return extra[key];
    if (key.startsWith("config.")) return settings.get(key.slice(7));
    return undefined;
  };
}

const claimed = new WeakSet<Event>();

/** O handler do App deve ignorar esta tecla (o usuário removeu/remapeou o atalho embutido). */
export function isKeyClaimed(e: Event): boolean {
  return claimed.has(e);
}

let installed = false;

export function installKeybindings(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  settings.onDidChangeText((path) => {
    if (path === settings.settingsPaths?.userKeybindings) changed();
  });
  let pending: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const clearPending = () => {
    pending = null;
    clearTimeout(pendingTimer);
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.defaultPrevented && !pending) return;
      // Gravando um atalho na tela de Atalhos: não interpreta.
      if ((e.target as HTMLElement | null)?.closest?.("[data-keybinding-recorder]")) return;
      const chord = chordFromEvent(e);
      if (!chord) return;
      const { user, effective } = currentKeybindings();
      const ctx = whenContext();
      const prefix = pending;
      clearPending();
      const res = matchKeybinding(effective, prefix, chord, ctx);
      if (res.kind === "chord") {
        pending = chord;
        pendingTimer = setTimeout(clearPending, 1500);
        return; // não consome: Monaco/App armam os próprios acordes
      }
      const seq = prefix ? `${prefix} ${chord}` : chord;
      if (res.kind === "match") {
        const rule = res.rule;
        const appHandles = rule.source === "default" && APP_HANDLED_KEYS.has(rule.key);
        if (appHandles) return;
        if (runCommand(rule.command, rule.args)) {
          e.preventDefault();
          e.stopPropagation();
          claimed.add(e);
        }
        return;
      }
      // Nenhuma regra: se era um atalho embutido que o usuário removeu, o App não o trata.
      if (APP_HANDLED_KEYS.has(seq) && user.some((r) => r.command.startsWith("-") && (!r.key || r.key === seq))) {
        claimed.add(e);
      }
    },
    { capture: true },
  );
}
