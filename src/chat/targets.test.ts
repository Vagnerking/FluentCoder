import assert from "node:assert/strict";
import test from "node:test";
import { mergeProviderStatuses } from "../acp/providers/index.ts";
import type { AgentDefinition } from "../agents/types.ts";
import {
  buildTargets,
  defaultTargetId,
  isProviderTarget,
  providerTargetId,
  resolveTarget,
} from "./targets.ts";

const providers = mergeProviderStatuses([
  { id: "claude", installed: false },
  { id: "codex", installed: true },
  { id: "gemini", installed: true },
  { id: "goose", installed: false },
]);

const agent: AgentDefinition = {
  id: "agent-1",
  name: "Revisor",
  color: "#ff0000",
  initialPrompt: "Revise.",
  provider: "codex",
  workspacePath: "/w",
  createdAt: "",
  updatedAt: "",
  defaultMode: "plan",
};

test("instalados primeiro, depois os ausentes, depois os agentes", () => {
  const targets = buildTargets(providers, [agent]);
  assert.deepEqual(
    targets.map((target) => target.id),
    ["provider:codex", "provider:gemini", "provider:claude", "provider:goose", "agent-1"],
  );
  const custom = targets.at(-1)!;
  assert.equal(custom.kind, "agent");
  assert.equal(custom.provider, "codex");
  assert.equal(custom.installed, true);
  assert.equal(custom.defaultMode, "plan");
  assert.ok(custom.description.includes("Codex"));
});

test("resolve alvos de provedor e de agente", () => {
  assert.ok(isProviderTarget(providerTargetId("gemini")));
  assert.equal(resolveTarget("provider:gemini", providers, [])?.label, "Gemini CLI");
  assert.equal(resolveTarget("agent-1", providers, [agent])?.label, "Revisor");
  assert.equal(resolveTarget("apagado", providers, [agent]), null);
});

test("alvo padrão: último usado válido ou o 1º provedor instalado", () => {
  const targets = buildTargets(providers, [agent]);
  assert.equal(defaultTargetId(targets, "agent-1"), "agent-1");
  assert.equal(defaultTargetId(targets, "sumiu"), "provider:codex");
  assert.equal(defaultTargetId([], null), "provider:claude");
});
