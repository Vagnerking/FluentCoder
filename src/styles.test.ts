import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const baseStyles = readFileSync(new URL("./styles/base.css", import.meta.url), "utf8");
const shellStyles = readFileSync(new URL("./styles/shell.css", import.meta.url), "utf8");

test("o layout principal não sobrescreve a classe interna .main do Monaco", () => {
  assert.match(shellStyles, /^\.app-main\s*\{/m);
  assert.doesNotMatch(styles, /^\.main\s*\{/m);
  assert.doesNotMatch(baseStyles, /^\.main\s*\{/m);
  assert.doesNotMatch(shellStyles, /^\.main\s*\{/m);
});
