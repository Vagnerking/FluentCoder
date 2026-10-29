/**
 * Anti-regressão multiplataforma: falha se voltarem os vazamentos Windows-only
 * que a auditoria 04 encontrou (rótulos fixos, `navigator.platform`,
 * `window.open` para links externos, pilhas de fonte fixas fora dos tokens).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const SRC = new URL("../", import.meta.url);

function walk(dir: URL, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) walk(new URL(`${name}/`, dir), out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(url.pathname);
  }
  return out;
}

const files = walk(SRC).map((path) => ({ path: path.slice(SRC.pathname.length), text: readFileSync(path, "utf8") }));
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function offenders(re: RegExp, allow: (p: string) => boolean = () => false): string[] {
  return files.filter((f) => !allow(f.path) && re.test(code(f.text))).map((f) => f.path);
}

test("nenhum rótulo 'Explorer do Windows' fixo", () => {
  assert.deepEqual(offenders(/Explorer do Windows/), []);
});

test("SO vem de src/platform, nunca de navigator.platform", () => {
  assert.deepEqual(offenders(/navigator\.platform|userAgentData/), []);
});

test("links externos saem pelo adaptador (window.open não chega ao navegador do SO)", () => {
  assert.deepEqual(offenders(/window\.open\(/), []);
});

test("pilhas de fonte só nos tokens/adaptador (CSS usa var(--font-ui/--font-mono))", () => {
  const allow = (p: string) => p === "styles/tokens.css" || p === "platform/fonts.ts" || p === "extensions/theme.ts";
  assert.deepEqual(offenders(/font-family:\s*["']?(Cascadia|Segoe|Consolas)|fontFamily:\s*["'`][^"'`]*(Cascadia|Segoe|Consolas)/, allow), []);
});
