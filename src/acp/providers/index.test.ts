import assert from "node:assert/strict";
import test from "node:test";
import {
  acpDefaultModel,
  acpModels,
  acpProvider,
  acpProviders,
  acpResolveModel,
} from "./index.ts";

test("o registro ACP expõe Codex e Claude", () => {
  assert.deepEqual(
    acpProviders().map((provider) => provider.id),
    ["codex", "claude"],
  );
  assert.equal(acpProvider("codex").label, "Codex");
  assert.equal(acpProvider("claude").label, "Claude");
});

test("cada provedor oferece modelos e o padrão é o primeiro", () => {
  for (const provider of acpProviders()) {
    assert.ok(provider.models.length > 0, `${provider.id} sem modelos`);
    assert.equal(acpDefaultModel(provider.id), provider.models[0].id);
  }
});

test("acpResolveModel mantém um modelo válido e cai no padrão para inválidos", () => {
  const [preferred, second] = acpModels("claude");
  // um modelo válido é preservado
  assert.equal(acpResolveModel("claude", second.id), second.id);
  // id desconhecido/antigo cai no padrão do provedor
  assert.equal(acpResolveModel("claude", "modelo-que-nao-existe"), preferred.id);
  // ausente também cai no padrão
  assert.equal(acpResolveModel("claude", undefined), preferred.id);
});
