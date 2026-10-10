import assert from "node:assert/strict";
import test from "node:test";
import {
  UI_SCALE_MIN,
  UI_SCALE_MAX,
  UI_SCALE_DEFAULT,
  clampUiScale,
  stepUiScale,
} from "./uiScale.ts";

test("clampUiScale keeps in-range values (rounded to 2 decimals)", () => {
  assert.equal(clampUiScale(1), 1);
  assert.equal(clampUiScale(1.5), 1.5);
  assert.equal(clampUiScale(0.7), 0.7);
});

test("clampUiScale clamps to the min and max bounds", () => {
  assert.equal(clampUiScale(0.1), UI_SCALE_MIN);
  assert.equal(clampUiScale(-5), UI_SCALE_MIN);
  assert.equal(clampUiScale(10), UI_SCALE_MAX);
});

test("clampUiScale falls back to default for non-finite input", () => {
  // NaN and ±Infinity aren't finite, so they can't be meaningfully clamped —
  // fall back to the default rather than propagate a broken scale.
  assert.equal(clampUiScale(NaN), UI_SCALE_DEFAULT);
  assert.equal(clampUiScale(Infinity), UI_SCALE_DEFAULT);
  assert.equal(clampUiScale(-Infinity), UI_SCALE_DEFAULT);
});

test("clampUiScale rounds away floating-point drift", () => {
  // 1 + 0.1 + 0.1 would drift without rounding.
  assert.equal(clampUiScale(1.2000000000000002), 1.2);
});

test("stepUiScale zooms in and out by one 10% step", () => {
  assert.equal(stepUiScale(1, 1), 1.1);
  assert.equal(stepUiScale(1, -1), 0.9);
});

test("stepUiScale never escapes the allowed range", () => {
  assert.equal(stepUiScale(UI_SCALE_MAX, 1), UI_SCALE_MAX);
  assert.equal(stepUiScale(UI_SCALE_MIN, -1), UI_SCALE_MIN);
});

test("repeated in/out steps return to the starting scale", () => {
  const start = 1;
  assert.equal(stepUiScale(stepUiScale(start, 1), -1), start);
});
