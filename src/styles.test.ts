import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Folha global na ordem da cascata: os `import "./styles…css"` de src/main.tsx,
 * resolvendo os `@import` de cada arquivo (src/styles/*.css).
 */
function readGlobalStylesheet(): string {
  const srcDir = new URL("./", import.meta.url);
  const read = (url: URL): string => {
    const text = readFileSync(url, "utf8");
    return text.replace(/^@import '([^']+)';\s*$/gm, (_m, rel: string) => read(new URL(rel, url)));
  };
  const mainTsx = readFileSync(new URL("main.tsx", srcDir), "utf8");
  return [...mainTsx.matchAll(/^import "\.\/(styles[^"]*\.css)";$/gm)]
    .map((m) => read(new URL(m[1], srcDir)))
    .join("\n");
}

const styles = readGlobalStylesheet();

test("o entry src/styles.css continua só um ponteiro para src/styles/", () => {
  const entry = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.equal(entry.replace(/\/\*[\s\S]*?\*\//g, "").trim(), "");
});

test("o layout principal não sobrescreve a classe interna .main do Monaco", () => {
  assert.match(styles, /^\.app-main\s*\{/m);
  assert.doesNotMatch(styles, /^\.main\s*\{/m);
});
