import assert from "node:assert/strict";
import test from "node:test";
import { acpProvider, acpProviders } from "./index.ts";

test("o registro ACP expõe Codex e Claude", () => {
  assert.deepEqual(
    acpProviders().map((provider) => provider.id),
    ["codex", "claude"],
  );
  assert.equal(acpProvider("codex").label, "Codex");
  assert.equal(acpProvider("claude").label, "Claude");
});
