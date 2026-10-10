import assert from "node:assert/strict";
import test from "node:test";
import { acrylicAllowed, type AcrylicEnv } from "./acrylic.ts";

const base: AcrylicEnv = { supportsBackdrop: true, platform: "windows", reducedTransparency: false, preference: null };

test("acrílico nos flyouts: só onde o filtro é desenhado; senão opaco (sem vazar texto)", () => {
  assert.equal(acrylicAllowed(base), true);
  assert.equal(acrylicAllowed({ ...base, platform: "macos" }), true);
  assert.equal(acrylicAllowed({ ...base, platform: "linux" }), false, "WebKitGTK pode ignorar o filtro");
  assert.equal(acrylicAllowed({ ...base, supportsBackdrop: false }), false);
  assert.equal(acrylicAllowed({ ...base, supportsBackdrop: false, preference: "on" }), false, "sem filtro nunca fica translúcido");
  assert.equal(acrylicAllowed({ ...base, platform: "linux", preference: "on" }), true);
  assert.equal(acrylicAllowed({ ...base, preference: "off" }), false);
  assert.equal(acrylicAllowed({ ...base, reducedTransparency: true }), false);
});
