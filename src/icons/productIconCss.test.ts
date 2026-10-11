import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProductIconTheme, productIconCss } from "./productIconCss.ts";

test("ícones de produto: CSS validado (ids, glifos, fontes)", () => {
  const doc = normalizeProductIconTheme({
    fonts: [{ id: "f", src: [{ path: "./fluent.woff", format: "woff" }] }, { id: "bad", src: [{ path: "./x.js" }] }],
    iconDefinitions: {
      "files": { fontCharacter: "\\E001" },
      "search": { fontCharacter: "\\e002", fontId: "f" },
      "bad id;}": { fontCharacter: "\\e003" },
      "evil": { fontCharacter: "a\";}body{x" },
    },
  });
  assert.deepEqual(Object.keys(doc.iconDefinitions), ["files", "search", "evil"]);
  const { css, icons } = productIconCss(doc, (p) => `fcext://localhost/a.b/${p.replace("./", "")}`, "fc-product-ab");
  assert.equal(icons, 2);
  assert.match(css, /@font-face\{font-family:"fc-product-ab-0";src:url\("fcext:\/\/localhost\/a\.b\/fluent\.woff"\) format\("woff"\)/);
  assert.match(css, /\.codicon-files::before\{font-family:"fc-product-ab-0"!important;content:"\\e001"!important\}/);
  assert.doesNotMatch(css, /body\{x/);
  assert.doesNotMatch(css, /x\.js/);
});
