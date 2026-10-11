import { test } from "node:test";
import assert from "node:assert/strict";
import { authorInitials, formatAbsoluteDate, formatAuthor, formatRelativeDate } from "./format.ts";

const NOW = Date.parse("2026-10-10T21:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

test("datas relativas curtas em pt-BR", () => {
  assert.equal(formatRelativeDate(ago(10_000), NOW), "agora");
  assert.equal(formatRelativeDate(ago(5 * MIN), NOW), "há 5 min");
  assert.equal(formatRelativeDate(ago(2 * H), NOW), "há 2 h");
  assert.equal(formatRelativeDate(ago(30 * H), NOW), "ontem");
  assert.equal(formatRelativeDate(ago(3 * D), NOW), "há 3 dias");
  assert.equal(formatRelativeDate(ago(15 * D), NOW), "há 2 sem.");
  assert.equal(formatRelativeDate(ago(40 * D), NOW), "há 1 mês");
  assert.equal(formatRelativeDate(ago(100 * D), NOW), "há 3 meses");
  assert.equal(formatRelativeDate(ago(400 * D), NOW), "há 1 ano");
  assert.equal(formatRelativeDate(ago(800 * D), NOW), "há 2 anos");
});

test("ISO com fuso (formato do git) e entradas inválidas", () => {
  assert.equal(formatRelativeDate("2026-10-10T16:04:25-03:00", NOW), "há 1 h");
  assert.equal(formatRelativeDate(new Date(NOW + 5 * MIN), NOW), "agora");
  assert.equal(formatRelativeDate("ontem à noite", NOW), "ontem à noite");
  assert.equal(formatRelativeDate(Number.NaN, NOW), "");
});

test("data absoluta para tooltip", () => {
  const d = new Date(2026, 9, 10, 18, 4);
  assert.equal(formatAbsoluteDate(d), "10/10/2026 18:04");
  assert.equal(formatAbsoluteDate("x"), "x");
});

test("autor: você, nomes longos abreviados, nunca uma letra solta", () => {
  assert.equal(formatAuthor("You"), "Você");
  assert.equal(formatAuthor("Rafael Gomes"), "Rafael Gomes");
  assert.equal(formatAuthor("Rafael Gouveia Gomes da Silva"), "Rafael S.");
  assert.equal(formatAuthor("Rafael Gomes", 8), "Rafael …");
  assert.equal(formatAuthor("Rafael Gomes", 9), "Rafael G.");
  assert.equal(formatAuthor("dependabot[bot]-with-a-long-name", 10), "dependabo…");
  assert.equal(formatAuthor("  "), "");
});

test("iniciais para avatar", () => {
  assert.equal(authorInitials("Rafael Gomes"), "RG");
  assert.equal(authorInitials("vagnerking"), "VA");
  assert.equal(authorInitials("You"), "EU");
  assert.equal(authorInitials(""), "?");
});
