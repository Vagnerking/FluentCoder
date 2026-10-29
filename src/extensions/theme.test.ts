import assert from "node:assert/strict";
import test from "node:test";
import { buildVscodeThemeVars, opaque } from "./theme.ts";

test("mapeia os tokens Fluent nas variáveis --vscode-* principais", () => {
  const tokens: Record<string, string> = {
    "--accent": " #123456 ",
    "--text": "#fafafa",
    "--editor-bg": "#101010",
    "--color-status-error": "#ff0000",
  };
  const vars = buildVscodeThemeVars((name) => tokens[name] ?? "");
  assert.equal(vars["--vscode-focusBorder"], "#123456");
  assert.equal(vars["--vscode-button-background"], "#123456");
  assert.equal(vars["--vscode-textLink-foreground"], "#123456");
  assert.equal(vars["--vscode-foreground"], "#fafafa");
  assert.equal(vars["--vscode-editor-background"], "#101010");
  assert.equal(vars["--vscode-errorForeground"], "#ff0000");
  // Tom do acrílico do dock, mas opaco (cabeçalhos fixos/máscaras das UIs).
  assert.equal(vars["--vscode-sideBar-background"], "rgb(28, 34, 43)");
});

test("opaque remove o alfa de rgba e preserva outras cores", () => {
  assert.equal(opaque("rgba(28, 34, 43, 0.9)"), "rgb(28, 34, 43)");
  assert.equal(opaque(" #1c222b "), "#1c222b");
  assert.equal(opaque("transparent"), "transparent");
});

test("cai nos padrões do tema escuro quando um token não existe", () => {
  const vars = buildVscodeThemeVars(() => "");
  assert.equal(vars["--vscode-focusBorder"], "#60cdff");
  assert.equal(vars["--vscode-foreground"], "#ffffff");
  for (const [k, v] of Object.entries(vars)) {
    assert.match(k, /^--[\w-]+$/);
    assert.ok(v.length > 0, `${k} vazio`);
    assert.doesNotMatch(v, /[;{}<]/, `${k} tem caractere inseguro para CSS inline`);
  }
});
