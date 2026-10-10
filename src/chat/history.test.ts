import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConversation } from "../agents/types.ts";
import { filterConversations, groupConversationsByDate } from "./history.ts";

const conversation = (id: string, updatedAt: string, title = id, text = ""): AgentConversation => ({
  id,
  agentId: "provider:claude",
  title,
  messages: text ? [{ id: `${id}-m`, role: "user", content: text, createdAt: updatedAt }] : [],
  createdAt: updatedAt,
  updatedAt,
});

test("busca no título e nas mensagens, sem acento", () => {
  const list = [
    conversation("a", "2026-10-10T10:00:00", "Refatoração do login"),
    conversation("b", "2026-10-10T10:00:00", "Outra", "como funciona a autenticação?"),
    conversation("c", "2026-10-10T10:00:00", "Nada"),
  ];
  assert.deepEqual(filterConversations(list, "refatoracao").map((c) => c.id), ["a"]);
  assert.deepEqual(filterConversations(list, "AUTENTICAÇÃO").map((c) => c.id), ["b"]);
  assert.equal(filterConversations(list, "  ").length, 3);
});

test("agrupa por Hoje/Ontem/7 dias/Antigas e omite grupos vazios", () => {
  const now = new Date(2026, 9, 10, 15, 0, 0);
  const iso = (d: number, h = 12) => new Date(2026, 9, d, h).toISOString();
  const groups = groupConversationsByDate(
    [
      conversation("hoje", iso(10, 9)),
      conversation("ontem", iso(9)),
      conversation("semana", iso(5)),
      conversation("velha", iso(1)),
      conversation("invalida", "x"),
    ],
    now,
  );
  assert.deepEqual(
    groups.map((group) => [group.label, group.conversations.map((c) => c.id)]),
    [
      ["Hoje", ["hoje"]],
      ["Ontem", ["ontem"]],
      ["Últimos 7 dias", ["semana"]],
      ["Mais antigas", ["velha", "invalida"]],
    ],
  );
});
