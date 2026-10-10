import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstEnabledTab,
  lastEnabledTab,
  nextEnabledTab,
  rovingTabIndex,
  tabsKeyTarget,
} from "./tabsLogic.ts";

const three = [{}, {}, {}];
const withDisabled = [{}, { disabled: true }, {}, { disabled: true }];

test("setas horizontais andam e dão a volta nas pontas", () => {
  assert.equal(tabsKeyTarget("ArrowRight", 0, three), 1);
  assert.equal(tabsKeyTarget("ArrowRight", 2, three), 0);
  assert.equal(tabsKeyTarget("ArrowLeft", 0, three), 2);
  assert.equal(tabsKeyTarget("ArrowLeft", 1, three), 0);
});

test("Home/End vão para as pontas habilitadas", () => {
  assert.equal(tabsKeyTarget("Home", 2, three), 0);
  assert.equal(tabsKeyTarget("End", 0, three), 2);
  assert.equal(tabsKeyTarget("End", 0, withDisabled), 2);
  assert.equal(lastEnabledTab(withDisabled), 2);
  assert.equal(firstEnabledTab([{ disabled: true }, {}]), 1);
});

test("abas desabilitadas são puladas", () => {
  assert.equal(tabsKeyTarget("ArrowRight", 0, withDisabled), 2);
  assert.equal(tabsKeyTarget("ArrowRight", 2, withDisabled), 0);
  assert.equal(tabsKeyTarget("ArrowLeft", 0, withDisabled), 2);
});

test("orientação vertical usa ↑/↓ e ignora ←/→", () => {
  assert.equal(tabsKeyTarget("ArrowDown", 0, three, "vertical"), 1);
  assert.equal(tabsKeyTarget("ArrowUp", 0, three, "vertical"), 2);
  assert.equal(tabsKeyTarget("ArrowRight", 0, three, "vertical"), null);
  assert.equal(tabsKeyTarget("ArrowDown", 0, three, "horizontal"), null);
});

test("teclas que não navegam retornam null; lista toda desabilitada também", () => {
  assert.equal(tabsKeyTarget("Enter", 0, three), null);
  assert.equal(tabsKeyTarget("a", 0, three), null);
  const allOff = [{ disabled: true }, { disabled: true }];
  assert.equal(tabsKeyTarget("ArrowRight", 0, allOff), null);
  assert.equal(tabsKeyTarget("Home", 0, allOff), null);
  assert.equal(nextEnabledTab([], 0, 1), -1);
});

test("tabindex roving fica na aba selecionada, ou na primeira habilitada", () => {
  assert.equal(rovingTabIndex(three, 1), 1);
  assert.equal(rovingTabIndex(withDisabled, 1), 0);
  assert.equal(rovingTabIndex(three, -1), 0);
  assert.equal(rovingTabIndex([{ disabled: true }, {}], -1), 1);
});
