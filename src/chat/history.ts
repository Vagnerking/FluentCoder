/** Histórico de conversas: busca e agrupamento por data (puro, testável). */
import type { AgentConversation } from "../agents/types.ts";
import { foldText } from "./mentions.ts";

/** Busca no título e no texto das mensagens (sem acento/caixa). */
export function filterConversations(
  conversations: AgentConversation[],
  query: string,
): AgentConversation[] {
  const q = foldText(query.trim());
  if (!q) return conversations;
  return conversations.filter(
    (conversation) =>
      foldText(conversation.title).includes(q) ||
      conversation.messages.some((message) => foldText(message.content).includes(q)),
  );
}

export interface ConversationGroup {
  label: string;
  conversations: AgentConversation[];
}

/** Agrupa (já ordenadas, mais recentes primeiro) em Hoje/Ontem/7 dias/Antigas. */
export function groupConversationsByDate(
  conversations: AgentConversation[],
  now: Date = new Date(),
): ConversationGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const buckets: ConversationGroup[] = [
    { label: "Hoje", conversations: [] },
    { label: "Ontem", conversations: [] },
    { label: "Últimos 7 dias", conversations: [] },
    { label: "Mais antigas", conversations: [] },
  ];
  for (const conversation of conversations) {
    const time = Date.parse(conversation.updatedAt);
    const index = Number.isNaN(time)
      ? 3
      : time >= startOfToday
        ? 0
        : time >= startOfToday - day
          ? 1
          : time >= startOfToday - 7 * day
            ? 2
            : 3;
    buckets[index].conversations.push(conversation);
  }
  return buckets.filter((bucket) => bucket.conversations.length > 0);
}
