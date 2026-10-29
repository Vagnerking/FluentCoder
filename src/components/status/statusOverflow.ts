/**
 * Itens da barra de status que somem quando ela estreita (container queries
 * em styles/status-base.css — MANTER OS LIMITES EM SINCRONIA) e vão para o
 * menu "Mais", em vez de desaparecerem sem acesso equivalente. Puro.
 */
export type StatusOverflowKey =
  | "blameSubject"
  | "blame"
  | "tabSize"
  | "eol"
  | "encoding"
  | "language"
  | "cursor"
  | "workspace";

/** Largura (px) da barra abaixo da qual (≤) o item some — igual ao `@container (max-width: N)`. */
export const STATUS_HIDE_AT: Record<StatusOverflowKey, number> = {
  blameSubject: 860,
  tabSize: 720,
  blame: 680,
  eol: 680,
  encoding: 620,
  language: 520,
  cursor: 430,
  workspace: 360,
};

/** Itens escondidos para uma largura de barra (ordem de prioridade do menu). */
export function hiddenStatusItems(width: number): StatusOverflowKey[] {
  if (!(width > 0)) return [];
  const order: StatusOverflowKey[] = ["cursor", "language", "encoding", "eol", "tabSize", "blame", "workspace"];
  // O assunto do blame é só um corte de texto do item blame: não vira entrada própria.
  return order.filter((k) => width <= STATUS_HIDE_AT[k]);
}
