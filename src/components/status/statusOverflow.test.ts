import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hiddenStatusItems, STATUS_HIDE_AT } from "./statusOverflow.ts";

test("larguras da barra → itens que vão para o menu Mais", () => {
  assert.deepEqual(hiddenStatusItems(1200), []);
  assert.deepEqual(hiddenStatusItems(700), ["tabSize"]);
  assert.deepEqual(hiddenStatusItems(600), ["encoding", "eol", "tabSize", "blame"]);
  assert.deepEqual(hiddenStatusItems(400), ["cursor", "language", "encoding", "eol", "tabSize", "blame"]);
  assert.equal(hiddenStatusItems(0).length, 0);
});

test("limites em sincronia com as container queries do CSS", () => {
  const css = readFileSync(fileURLToPath(new URL("../../styles/status-base.css", import.meta.url)), "utf8");
  const classOf: Record<string, string> = {
    blameSubject: "status-blame-subject",
    tabSize: "status-tabsize",
    blame: "status-blame",
    eol: "status-eol",
    encoding: "status-encoding",
    language: "status-language",
    cursor: "status-cursor",
    workspace: "status-workspace",
  };
  for (const [key, px] of Object.entries(STATUS_HIDE_AT)) {
    // `.status-bar .x` (especificidade maior que `.status-item { display: flex }`,
    // declarado depois — com `.x` sozinho a container query nunca vencia).
    const re = new RegExp(`@container \\(max-width: ${px}px\\) \\{\\s*\\.status-bar \\.${classOf[key]} \\{ display: none; \\}`);
    assert.match(css, re, `${key} some em ${px}px no CSS`);
  }
});
