import test from "node:test";
import assert from "node:assert/strict";
import { CORE_SETTINGS } from "./coreSettings.ts";
import {
  applySaveTransforms,
  editorOptionsFromSettings,
  indentationFor,
  newFileEncoding,
  newFileEol,
  saveTransformsFor,
} from "./editorSettings.ts";
import { defaultShellFromSettings, terminalOptionsFromSettings } from "./terminalSettings.ts";
import { bridgedKey, monacoUserConfiguration } from "./monacoBridge.ts";
import { autoSaveCandidates } from "./useAutoSave.ts";
import { decideOpen, openLimitsFromSettings } from "../editor/fileOpenPolicy.ts";

const defaults = Object.fromEntries(CORE_SETTINGS.map((s) => [s.key, s.default]));
const getter = (over: Record<string, unknown> = {}) => (k: string) => (k in over ? over[k] : defaults[k]);
const env = { monoFont: "Mono", reduceMotion: false };

test("defaults do editor reproduzem o comportamento antigo (sem mudança na migração)", () => {
  const o = editorOptionsFromSettings(getter(), env);
  assert.equal(o.fontSize, 14);
  assert.deepEqual(o.minimap, { enabled: false });
  assert.deepEqual(o.stickyScroll, { enabled: false });
  assert.equal(o.formatOnPaste, true);
  assert.equal(o.formatOnType, true);
  assert.equal(o.scrollBeyondLastLine, false);
  assert.equal(o.fontFamily, "Mono", "vazio = mono do SO");
  assert.equal("lineHeight" in o, false, "0 = automática");
  // Opções travadas nunca vêm das settings.
  for (const k of ["hover", "wordBasedSuggestions", "semanticHighlighting.enabled", "suggestLineHeight"]) assert.equal(k in o, false, k);
});

test("settings mudam as opções; régua do max_line_length; menos movimento", () => {
  const o = editorOptionsFromSettings(
    getter({ "editor.fontSize": 18, "editor.wordWrap": "on", "editor.rulers": [80], "editor.fontLigatures": "'ss01'", "editor.smoothScrolling": true, "editor.lineHeight": 22 }),
    { monoFont: "Mono", reduceMotion: true },
    { ruler: 120 },
  );
  assert.equal(o.fontSize, 18);
  assert.equal(o.wordWrap, "on");
  assert.deepEqual(o.rulers, [80, 120]);
  assert.equal(o.fontLigatures, "'ss01'");
  assert.equal(o.smoothScrolling, false, "reduzir movimento desliga a rolagem suave");
  assert.equal(o.lineHeight, 22);
});

test("indentação: .editorconfig vence settings e desliga a detecção", () => {
  assert.deepEqual(indentationFor(getter()), { tabSize: 2, indentSize: 2, insertSpaces: true, detect: true, source: "settings" });
  const d = indentationFor(getter({ "editor.tabSize": 8 }), { insertSpaces: false, tabSize: 4 });
  assert.equal(d.tabSize, 4);
  assert.equal(d.insertSpaces, false);
  assert.equal(d.detect, false);
  assert.equal(d.source, "editorconfig");
});

test("salvamento: trim, nova linha final e linhas finais extras", () => {
  const t = saveTransformsFor(getter({ "files.trimTrailingWhitespace": true, "files.insertFinalNewline": true }));
  assert.equal(applySaveTransforms("a  \nb\t\nc", t), "a\nb\nc\n");
  assert.equal(applySaveTransforms("", t), "", "arquivo vazio continua vazio");
  const f = saveTransformsFor(getter({ "files.trimFinalNewlines": true }));
  assert.equal(applySaveTransforms("a\n\n\n", f), "a\n");
  // .editorconfig desliga o que a setting liga.
  const ec = saveTransformsFor(getter({ "files.trimTrailingWhitespace": true }), { trimTrailingWhitespace: false });
  assert.equal(applySaveTransforms("a  ", ec), "a  ");
});

test("arquivo novo: EOL e encoding (editorconfig > setting > SO)", () => {
  assert.equal(newFileEol(getter(), {}, true), "Crlf");
  assert.equal(newFileEol(getter(), {}, false), "Lf");
  assert.equal(newFileEol(getter({ "files.eol": "\n" }), {}, true), "Lf");
  assert.equal(newFileEol(getter({ "files.eol": "\n" }), { eol: "\r\n" }, false), "Crlf");
  assert.deepEqual(newFileEncoding(getter({ "files.encoding": "utf8bom" }), {}), { id: "UTF-8", bom: true });
  assert.deepEqual(newFileEncoding(getter(), { encoding: { id: "UTF-16LE", bom: true } }), { id: "UTF-16LE", bom: true });
});

test("terminal: fonte/cursor/histórico e shell por perfil do SO", () => {
  const o = terminalOptionsFromSettings(getter({ "terminal.integrated.cursorStyle": "line", "terminal.integrated.scrollback": 5000 }), "Mono");
  assert.equal(o.fontFamily, "Mono");
  assert.equal(o.cursorStyle, "bar");
  assert.equal(o.scrollback, 5000);
  assert.equal(defaultShellFromSettings(getter(), "linux"), null);
  const prof = getter({
    "terminal.integrated.defaultProfile.linux": "zsh",
    "terminal.integrated.profiles.linux": { zsh: { path: ["/nao/existe", "zsh"], args: ["-l"] } },
  });
  assert.deepEqual(defaultShellFromSettings(prof, "linux"), { shellPath: "/nao/existe", shellArgs: ["-l"] });
  assert.deepEqual(defaultShellFromSettings(getter({ "fluent.terminal.shellPath": "fish" }), "macos"), { shellPath: "fish", shellArgs: [] });
});

test("ponte do Monaco: só o subconjunto, com as opções travadas forçadas", () => {
  assert.equal(bridgedKey("editor.tabSize"), true);
  assert.equal(bridgedKey("python.analysis.typeCheckingMode"), true);
  assert.equal(bridgedKey("editor.semanticHighlighting.enabled"), false);
  assert.equal(bridgedKey("editor.fontSize"), false);
  const values: Record<string, unknown> = { "editor.tabSize": 2, "editor.semanticHighlighting.enabled": true, "python.x": 1 };
  const json = monacoUserConfiguration(Object.keys(values), (k, lang) => (lang === "python" && k === "editor.tabSize" ? 4 : values[k]), ["python"]);
  assert.equal(json["editor.semanticHighlighting.enabled"], false, "contrato do editor");
  assert.equal(json["editor.wordBasedSuggestions"], "off");
  assert.equal(json["editor.tabSize"], 2);
  assert.deepEqual(json["[python]"], { "editor.tabSize": 4 });
});

test("auto save: só arquivos reais modificados", () => {
  const files = [
    { path: "/a.ts", dirty: true, content: "" },
    { path: "/a.ts", dirty: true, content: "" },
    { path: "untitled:1", dirty: true, content: "" },
    { path: "/ro.ts", dirty: true, readOnly: true, content: "" },
    { path: "fluentcoder://graph", dirty: true, content: "" },
    { path: "/b.ts", dirty: false, content: "" },
  ];
  assert.deepEqual(autoSaveCandidates(files, (p) => p.startsWith("fluentcoder://")).map((f) => f.path), ["/a.ts"]);
});

test("limites de arquivo grande vêm das settings (enorme nunca passa de 50 MB)", () => {
  const MB = 1024 * 1024;
  const l = openLimitsFromSettings(1, 500);
  assert.equal(l.large, MB);
  assert.equal(l.huge, 50 * MB);
  assert.equal(decideOpen({ size: 2 * MB, binary: false }, l).kind, "large");
  assert.equal(decideOpen({ size: 2 * MB, binary: false }).kind, "normal");
});
