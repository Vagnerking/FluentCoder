import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * O WebKitGTK (motor do Tauri no Linux) NÃO suporta `user-select` sem prefixo:
 * `CSS.supports('user-select','none')` é false e `user-select: none` computa
 * `-webkit-user-select: text`. Toda declaração precisa do gêmeo `-webkit-` no
 * mesmo bloco, com o mesmo valor — senão arrastar seleciona texto no Linux.
 */

const srcDir = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

/** Blocos `{ ... }` folha (sem chaves internas) com suas declarações. */
function leafBlocks(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...noComments.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
}

export function missingWebkitTwins(css: string): string[] {
  const missing: string[] = [];
  for (const block of leafBlocks(css)) {
    for (const m of block.matchAll(/(?<![-\w])user-select\s*:\s*([^;}]+)/g)) {
      const value = m[1].trim();
      const twin = new RegExp(
        `-webkit-user-select\\s*:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
      );
      if (!twin.test(block)) missing.push(`user-select: ${value} em { ${block.trim().slice(0, 80)} … }`);
    }
  }
  return missing;
}

test("missingWebkitTwins detecta a falta do gêmeo -webkit-", () => {
  assert.equal(missingWebkitTwins(".a { user-select: none; }").length, 1);
  assert.equal(missingWebkitTwins(".a { user-select: none; -webkit-user-select: none; }").length, 0);
  assert.equal(missingWebkitTwins(".a { user-select: text; -webkit-user-select: none; }").length, 1);
  assert.equal(missingWebkitTwins(".a { -webkit-user-select: none; }").length, 0);
});

test("toda declaração user-select em CSS tem o gêmeo -webkit-user-select", () => {
  const problems: string[] = [];
  for (const file of walk(srcDir, [".css"])) {
    for (const p of missingWebkitTwins(readFileSync(file, "utf8"))) {
      problems.push(`${file.slice(srcDir.length)}: ${p}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("estilos inline userSelect em TSX também levam WebkitUserSelect", () => {
  const problems: string[] = [];
  for (const file of walk(srcDir, [".tsx"])) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?<![\w])userSelect\s*:/g)) {
      const around = text.slice(Math.max(0, m.index - 200), m.index + 200);
      if (!/WebkitUserSelect\s*:/.test(around)) problems.push(file.slice(srcDir.length));
    }
  }
  assert.deepEqual(problems, []);
});
