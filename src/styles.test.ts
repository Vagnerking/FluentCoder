import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

test("o layout principal não sobrescreve a classe interna .main do Monaco", () => {
  assert.match(styles, /^\.app-main\s*\{/m);
  assert.doesNotMatch(styles, /^\.main\s*\{/m);
});
