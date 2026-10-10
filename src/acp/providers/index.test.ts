import assert from "node:assert/strict";
import test from "node:test";
import {
  acpDefaultModel,
  acpModels,
  acpProvider,
  acpProviders,
  acpResolveModel,
  DEFAULT_MODEL,
  mergeProviderStatuses,
  NATIVE_PROVIDER_IDS,
} from "./index.ts";

test("o registro expõe os nativos primeiro e os agentes ACP conhecidos", () => {
  const ids = acpProviders().map((provider) => provider.id);
  assert.deepEqual(ids.slice(0, 2), NATIVE_PROVIDER_IDS);
  for (const id of ["gemini", "copilot", "opencode", "qwen", "goose"]) {
    assert.ok(ids.includes(id), `${id} ausente`);
    assert.equal(acpProvider(id).protocol, "acp");
  }
  assert.equal(acpProvider("claude").protocol, "claude-stream-json");
  assert.equal(acpProvider("codex").protocol, "codex-app-server");
});

test("provedor desconhecido vira um ACP genérico sem quebrar a UI", () => {
  const unknown = acpProvider("novo-cli");
  assert.equal(unknown.label, "novo-cli");
  assert.equal(unknown.protocol, "acp");
  assert.deepEqual(acpModels("novo-cli"), [DEFAULT_MODEL]);
});

test("nativos têm catálogo; o padrão é o primeiro", () => {
  for (const id of NATIVE_PROVIDER_IDS) {
    const models = acpModels(id);
    assert.ok(models.length >= 2, `${id} sem modelos`);
    assert.equal(acpDefaultModel(id), models[0].id);
    for (const model of models) {
      assert.ok(model.id && model.label && model.hint);
    }
  }
});

test("ACP usa o padrão do CLI + os modelos que a sessão anunciar", () => {
  assert.equal(acpDefaultModel("gemini"), "");
  const dynamic = [{ id: "gemini-3-pro", label: "Gemini 3 Pro", hint: "" }];
  assert.deepEqual(
    acpModels("gemini", dynamic).map((model) => model.id),
    ["", "gemini-3-pro"],
  );
  assert.equal(acpResolveModel("gemini", "gemini-3-pro", dynamic), "gemini-3-pro");
  assert.equal(acpResolveModel("gemini", "sumiu", dynamic), "");
});

test("acpResolveModel mantém o salvo e cai no padrão para ids antigos", () => {
  assert.equal(acpResolveModel("claude", "sonnet"), "sonnet");
  // Ids do catálogo antigo (v1) caem no padrão atual.
  assert.equal(acpResolveModel("claude", "claude-opus-4-8"), acpDefaultModel("claude"));
  assert.equal(acpResolveModel("codex", "gpt-5.5"), acpDefaultModel("codex"));
  assert.equal(acpResolveModel("codex", undefined), acpDefaultModel("codex"));
});

test("mergeProviderStatuses junta disponibilidade do backend ao catálogo", () => {
  const merged = mergeProviderStatuses([
    { id: "claude", installed: true, installHint: "x" },
    { id: "gemini", installed: false, installHint: "npm i -g @google/gemini-cli" },
    { id: "futuro", label: "Futuro CLI", installed: true, protocol: "acp" },
    { label: "sem id" } as never,
  ]);
  assert.deepEqual(
    merged.map((provider) => [provider.id, provider.installed]),
    [
      ["claude", true],
      ["gemini", false],
      ["futuro", true],
    ],
  );
  assert.equal(merged[0].label, "Claude Code");
  assert.equal(merged[2].label, "Futuro CLI");
  assert.equal(merged[1].installHint, "npm i -g @google/gemini-cli");
});
