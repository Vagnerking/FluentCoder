import assert from "node:assert/strict";
import test from "node:test";
import { compileTokenColors, matchScopes, selectorScore, styleToken } from "./tmScopes.ts";
import { loadColorTheme, tmThemeToTokenColors } from "./colorThemeModel.ts";
import { buildMonacoTheme, REQUIRED_SEMANTIC } from "./monacoTheme.ts";
import { cssTokensFromTheme, terminalThemeFromColors, TOKEN_MAP, vscodeCssVars } from "./vscodeThemeMap.ts";
import { contrast, ensureContrast, flatten, normalizeColor, parseColor } from "./colors.ts";
import { BUILTIN_COLOR_THEMES, FLUENT_DARK } from "./builtinThemes.ts";
import { parsePlist } from "../extensions/contributions/plist.ts";
import { setSettingsBackend } from "./settingsAdapter.ts";
import { registerThemeProvider, themeRegistry, notifyThemeListChanged, __resetThemeRegistryForTests, type ThemeEntry } from "./registry.ts";

test("cores: só hex; normalização e contraste", () => {
  assert.equal(normalizeColor("#ABC"), "#aabbcc");
  assert.equal(normalizeColor("#11223380"), "#11223380");
  assert.equal(normalizeColor("red"), null);
  assert.equal(normalizeColor("url(x)"), null);
  assert.equal(normalizeColor("var(--x)"), null);
  const bg = parseColor("#000000")!;
  const fixed = ensureContrast(parseColor("#111111")!, bg, 4.5);
  assert.ok(contrast(flatten(fixed, bg), bg) >= 4.5);
});

test("TextMate: seleção por especificidade, ancestrais e cor/estilo independentes", () => {
  const rules = compileTokenColors([
    { settings: { foreground: "#ffffff" } },
    { scope: "string", settings: { foreground: "#00ff00" } },
    { scope: "string.quoted.double", settings: { foreground: "#0000ff" } },
    { scope: "meta.tag string", settings: { foreground: "#ff0000" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#888888", fontStyle: "italic" } },
    { scope: "keyword.control", settings: { fontStyle: "bold" } },
    { scope: "keyword", settings: { foreground: "#ff00ff" } },
    { scope: "storage, storage.type - meta.x", settings: { foreground: "#123456" } },
  ]);
  assert.equal(matchScopes(rules, ["source.js", "string.quoted.single.js"]).foreground, "#00ff00");
  assert.equal(matchScopes(rules, ["source.js", "string.quoted.double.js"]).foreground, "#0000ff");
  assert.equal(matchScopes(rules, ["text.html", "meta.tag.html", "string.quoted.single.html"]).foreground, "#ff0000");
  assert.equal(matchScopes(rules, ["source.x", "unknown.scope"]).foreground, "#ffffff", "regra padrão");
  const kw = matchScopes(rules, ["source.ts", "keyword.control.flow.ts"]);
  assert.deepEqual(kw, { foreground: "#ff00ff", fontStyle: "bold" }, "cor da regra menos específica + estilo da mais específica");
  assert.equal(matchScopes(rules, ["source.c", "storage.type.c"]).foreground, "#123456", "exclusão ignorada");
  assert.ok(selectorScore(["string"], ["string.quoted"]) > 0);
  assert.equal(selectorScore(["strings"], ["string.quoted"]), -1, "prefixo só por segmentos");
  assert.equal(styleToken({ foreground: "#888888", fontStyle: "italic" }, "#ffffff"), "tm.888888.i");
  assert.equal(styleToken({}, "#FFFFFF"), "tm.ffffff");
});

const files: Record<string, string> = {
  "themes/base.json": JSON.stringify({ type: "dark", colors: { "editor.background": "#101010", foreground: "#eeeeee" }, tokenColors: [{ scope: "comment", settings: { foreground: "#777777" } }] }),
  "themes/child.json": `{
    // JSONC com include relativo e tokenColors em .tmTheme
    "name": "Filho",
    "include": "./base.json",
    "colors": { "editor.background": "#202020", "bogus": "url(x)", },
    "tokenColors": "../tm/colors.tmTheme",
    "semanticTokenColors": { "class": "#abcdef", "method": { "foreground": "#fedcba", "italic": true } },
  }`,
  "tm/colors.tmTheme": `<?xml version="1.0"?><plist version="1.0"><dict><key>settings</key><array>
    <dict><key>settings</key><dict><key>foreground</key><string>#cccccc</string><key>caret</key><string>#ff0000</string></dict></dict>
    <dict><key>scope</key><string>keyword</string><key>settings</key><dict><key>foreground</key><string>#ff8800</string></dict></dict>
  </array></dict></plist>`,
  "themes/loop.json": JSON.stringify({ include: "./loop.json" }),
  "themes/escape.json": JSON.stringify({ include: "../../etc/x.json" }),
};
const ctx = { readFile: async (rel: string) => files[rel] ?? Promise.reject(new Error(`ENOENT ${rel}`)) };

test("tema de extensão: include + .tmTheme + semanticTokenColors, cores validadas", async () => {
  const t = await loadColorTheme(ctx, "themes/child.json", { label: "Filho (ext)", uiTheme: "vs-dark" });
  assert.equal(t.name, "Filho (ext)");
  assert.equal(t.colors["editor.background"], "#202020", "o filho vence o include");
  assert.equal(t.colors.foreground, "#eeeeee");
  assert.equal(t.colors["editorCursor.foreground"], "#ff0000", "globais do tmTheme");
  assert.equal(t.colors.bogus, undefined, "cor inválida descartada");
  assert.ok(t.tokenColors.some((r) => r.scope === "comment"), "tokenColors do include");
  assert.ok(t.tokenColors.some((r) => r.scope === "keyword"));
  assert.deepEqual(t.semanticTokenColors.method, { foreground: "#fedcba", italic: true });
  await assert.rejects(loadColorTheme(ctx, "themes/loop.json", { label: "x", uiTheme: "vs" }), /circular/);
  await assert.rejects(loadColorTheme(ctx, "themes/escape.json", { label: "x", uiTheme: "vs" }), /fora da pasta/);
  const tm = tmThemeToTokenColors(parsePlist(files["tm/colors.tmTheme"]));
  assert.equal(tm.colors["editor.foreground"], "#cccccc");
});

test("Monaco: categorias obrigatórias (editor.md) sempre com regra; tokens tm.* por cor", async () => {
  const t = await loadColorTheme(ctx, "themes/child.json", { label: "Filho", uiTheme: "vs-dark" });
  const m = buildMonacoTheme(t);
  assert.equal(m.base, "vs-dark");
  const byToken = new Map(m.rules.map((r) => [r.token, r]));
  for (const c of REQUIRED_SEMANTIC) assert.ok(byToken.has(c), `regra para ${c}`);
  assert.equal(byToken.get("class")!.foreground, "abcdef", "semanticTokenColors vence o escopo");
  assert.equal(byToken.get("method")!.fontStyle, "italic");
  assert.equal(byToken.get("comment")!.foreground, "777777");
  assert.equal(byToken.get("keyword")!.foreground, "ff8800");
  assert.ok(byToken.has("tm.777777"));
  assert.ok(byToken.has("tm.ff8800"));
  assert.equal(m.colors["editor.background"], "#202020");
});

test("Fluent Escuro mantém as regras C#/Roslyn do editor (sem derivar)", () => {
  const m = buildMonacoTheme(FLUENT_DARK.theme, { overrideRules: FLUENT_DARK.rules, deriveTokenRules: false });
  const byToken = new Map(m.rules.map((r) => [r.token, r.foreground]));
  assert.equal(byToken.get("controlKeyword"), "C586C0");
  assert.equal(byToken.get("keyword.if"), "C586C0");
  assert.equal(byToken.get("struct"), "86C691");
  assert.equal(byToken.get("class"), "4EC9B0");
  assert.equal(byToken.get("enum"), "B8D7A3");
  assert.equal(byToken.get("method"), "DCDCAA");
  assert.equal(m.colors["editor.background"], "#1c222b");
  assert.equal(FLUENT_DARK.monacoId, "fluent-acrylic-dark");
  for (const b of BUILTIN_COLOR_THEMES) {
    const ids = new Set(b.rules.map((r) => r.token));
    for (const c of REQUIRED_SEMANTIC) assert.ok(ids.has(c), `${b.id}: ${c}`);
  }
});

test("mapa workbench → tokens Fluent: cobre a tabela, reservas e contraste AA", () => {
  // Tema sem quase nada: tudo sai das reservas, nada fica vazio.
  const sparse = cssTokensFromTheme({ "editor.background": "#282a36" }, "vs-dark");
  for (const r of TOKEN_MAP) assert.ok(sparse.tokens[r.token], `token ${r.token} resolvido`);
  assert.equal(sparse.colorScheme, "dark");
  // Dracula-like: chaves mapeadas diretamente.
  const d = cssTokensFromTheme(
    {
      "editor.background": "#282a36",
      foreground: "#f8f8f2",
      "sideBar.background": "#21222c",
      "activityBarBadge.background": "#bd93f9",
      "list.activeSelectionBackground": "#44475a",
      "editorWidget.background": "#21222c",
      "gitDecoration.modifiedResourceForeground": "#8be9fd",
      "descriptionForeground": "#6272a4",
    },
    "vs-dark",
  );
  assert.equal(d.tokens["--editor-bg"], "#282a36");
  assert.equal(d.tokens["--sidebar-bg"], "#21222c");
  assert.equal(d.tokens["--accent"], "#bd93f9");
  assert.equal(d.tokens["--fill-selected"], "#44475a");
  assert.equal(d.tokens["--color-git-modified"], "#8be9fd");
  assert.equal(d.tokens["--shell-glow"], "none");
  // descriptionForeground fraco demais é clareado até 3:1 contra a barra lateral.
  const muted = parseColor(d.tokens["--text-muted"].startsWith("#") ? d.tokens["--text-muted"] : "#000000");
  if (muted) assert.ok(contrast(muted, parseColor("#21222c")!) >= 3);
  // Texto com contraste ruim é corrigido para AA.
  const bad = cssTokensFromTheme({ "editor.background": "#ffffff", foreground: "#eeeeee" }, "vs");
  assert.ok(contrast(parseColor(bad.tokens["--text"])!, parseColor("#ffffff")!) >= 4.5);
  assert.equal(bad.colorScheme, "light");
  // Superfícies de overlay nunca translúcidas (código não vaza).
  const alpha = cssTokensFromTheme({ "editor.background": "#000000", "editorWidget.background": "#ffffff20" }, "vs-dark");
  assert.ok(alpha.tokens["--color-surface-overlay"].startsWith("#"), alpha.tokens["--color-surface-overlay"]);
});

test("terminal e --vscode-* do tema", () => {
  const term = terminalThemeFromColors({ "editor.background": "#101010", "terminal.ansiRed": "#ff5555" }, "vs-dark");
  assert.equal(term.red, "#ff5555");
  assert.equal(term.background, "#101010");
  assert.ok(term.brightBlue);
  assert.deepEqual(vscodeCssVars({ "editor.background": "#101010", "x;y": "#fff", bad: "red" }), { "--vscode-editor-background": "#101010" });
});

test("registro: aplica salvo, pré-visualiza, restaura e segue a lista", async () => {
  __resetThemeRegistryForTests();
  const mem = new Map<string, unknown>();
  setSettingsBackend({ get: (k) => mem.get(k), set: (k, v) => void mem.set(k, v) });
  const applied: string[] = [];
  let list: ThemeEntry[] = [
    { kind: "color", id: "A", label: "A", origin: { type: "builtin" } },
    { kind: "color", id: "B", label: "B", origin: { type: "builtin" } },
  ];
  await registerThemeProvider({
    kind: "color",
    defaultId: "A",
    entries: () => list,
    applyEntry: async (e) => {
      if (e.id === "BROKEN") throw new Error("quebrado");
      applied.push(e.id);
    },
  });
  assert.equal(themeRegistry.active("color").id, "A");
  const events: string[] = [];
  const off = themeRegistry.onDidChange((e) => events.push(`${e.type}${e.preview ? ":preview" : ""}`));
  await themeRegistry.apply("color", "B", { preview: true });
  assert.equal(themeRegistry.active("color").id, "B");
  assert.equal(themeRegistry.configured("color"), "A", "prévia não salva");
  await themeRegistry.restore("color");
  assert.equal(themeRegistry.active("color").id, "A");
  await themeRegistry.apply("color", "B");
  assert.equal(themeRegistry.configured("color"), "B");
  await assert.rejects(themeRegistry.apply("color", "nao-existe"), /não encontrado/);
  // Tema ativo removido da lista → padrão, setting mantida; volta quando reaparece.
  list = list.filter((e) => e.id !== "B");
  notifyThemeListChanged("color");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(themeRegistry.active("color").id, "A");
  assert.equal(themeRegistry.configured("color"), "B");
  list = [...list, { kind: "color", id: "B", label: "B", origin: { type: "extension", extensionId: "x.y", extensionName: "X" } }];
  notifyThemeListChanged("color");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(themeRegistry.active("color").id, "B");
  // Tema quebrado: fica o padrão e o erro sobe.
  list = [...list, { kind: "color", id: "BROKEN", label: "Quebrado", origin: { type: "builtin" } }];
  await assert.rejects(themeRegistry.apply("color", "BROKEN", { preview: true }), /quebrado/);
  assert.equal(themeRegistry.active("color").id, "A");
  assert.ok(events.includes("active:preview") && events.includes("list"));
  off();
  assert.deepEqual(applied.slice(0, 3), ["A", "B", "A"]);
});
