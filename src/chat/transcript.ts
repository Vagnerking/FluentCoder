/**
 * Lógica pura do transcript rico: upsert de chamadas de ferramenta vindas do
 * stream, intercalação texto/ferramentas, reconstrução de diffs unificados
 * para o DiffEditor e formatação de consumo.
 */
import type { ChatFileDiff, ChatToolCall, ChatUsage, ToolCallStatus } from "../agents/types.ts";

type ToolCallUpdate = Omit<ChatToolCall, "textOffset"> & { textOffset?: number };

const STATUSES: ToolCallStatus[] = ["pending", "in_progress", "completed", "failed"];

/**
 * Aplica um evento `toolCall` (semântica de upsert por id): campos presentes
 * substituem, ausentes preservam. Uma chamada nova é ancorada em
 * `textOffset` (tamanho do texto da resposta naquele momento).
 */
export function upsertToolCall(
  calls: ChatToolCall[] | undefined,
  update: ToolCallUpdate,
  textOffset: number,
): ChatToolCall[] {
  const list = calls ?? [];
  const status = STATUSES.includes(update.status as ToolCallStatus)
    ? (update.status as ToolCallStatus)
    : undefined;
  const index = list.findIndex((call) => call.id === update.id);
  if (index < 0) {
    const created: ChatToolCall = { id: update.id, textOffset };
    if (update.kind) created.kind = update.kind;
    if (update.title) created.title = update.title;
    created.status = status ?? "in_progress";
    if (update.detail) created.detail = update.detail;
    if (update.output) created.output = update.output;
    if (update.locations?.length) created.locations = update.locations;
    if (update.diffs?.length) created.diffs = update.diffs;
    return [...list, created];
  }
  const current = list[index];
  const merged: ChatToolCall = {
    ...current,
    ...(update.kind ? { kind: update.kind } : {}),
    ...(update.title ? { title: update.title } : {}),
    ...(status ? { status } : {}),
    ...(update.detail ? { detail: update.detail } : {}),
    ...(update.output ? { output: update.output } : {}),
    ...(update.locations?.length ? { locations: update.locations } : {}),
    ...(update.diffs?.length ? { diffs: update.diffs } : {}),
  };
  const next = [...list];
  next[index] = merged;
  return next;
}

/** Chamadas ainda abertas viram `failed` quando o turno termina com erro/cancelamento. */
export function settleToolCalls(
  calls: ChatToolCall[] | undefined,
  outcome: "done" | "error",
): ChatToolCall[] | undefined {
  if (!calls?.length) return calls;
  return calls.map((call) =>
    call.status === "in_progress" || call.status === "pending"
      ? { ...call, status: outcome === "done" ? "completed" : "failed" }
      : call,
  );
}

export type TranscriptSegment =
  | { type: "text"; text: string; key: string }
  | { type: "tools"; calls: ChatToolCall[]; key: string };

/**
 * Intercala o texto da resposta com as chamadas de ferramenta na ordem em que
 * aconteceram (cada chamada guarda o offset do texto quando começou). Chamadas
 * consecutivas no mesmo ponto formam um grupo.
 */
export function interleaveTranscript(
  content: string,
  calls: ChatToolCall[] | undefined,
): TranscriptSegment[] {
  if (!calls?.length) return content ? [{ type: "text", text: content, key: "t0" }] : [];
  const sorted = [...calls]
    .map((call, order) => ({ call, order }))
    .sort((a, b) => a.call.textOffset - b.call.textOffset || a.order - b.order)
    .map(({ call }) => call);
  const segments: TranscriptSegment[] = [];
  let cursor = 0;
  for (const call of sorted) {
    const offset = Math.min(Math.max(call.textOffset, 0), content.length);
    if (offset > cursor) {
      segments.push({ type: "text", text: content.slice(cursor, offset), key: `t${cursor}` });
      cursor = offset;
    }
    const last = segments[segments.length - 1];
    if (last?.type === "tools") last.calls.push(call);
    else segments.push({ type: "tools", calls: [call], key: `c${call.id}` });
  }
  if (cursor < content.length) {
    segments.push({ type: "text", text: content.slice(cursor), key: `t${cursor}` });
  }
  return segments;
}

/**
 * Reconstrói os lados antigo/novo de um diff unificado (só os trechos dos
 * hunks — suficiente para o DiffEditor mostrar a mudança). Hunks distintos
 * são separados por uma linha `⋯`.
 */
export function unifiedDiffToTexts(diff: string): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let inHunk = false;
  let hunks = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      if (hunks > 0) {
        oldLines.push("⋯");
        newLines.push("⋯");
      }
      hunks += 1;
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      // Patches sem cabeçalho @@ (arquivo novo do Codex = conteúdo cru).
      if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) newLines.push(line.slice(1));
    else if (line.startsWith("-")) oldLines.push(line.slice(1));
    else if (inHunk) {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      oldLines.push(text);
      newLines.push(text);
    } else {
      newLines.push(line);
    }
  }
  return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

/** Textos antigo/novo de um diff para abrir no Monaco. */
export function diffTexts(diff: ChatFileDiff): { oldText: string; newText: string } {
  if (diff.oldText !== undefined || diff.newText !== undefined) {
    return { oldText: diff.oldText ?? "", newText: diff.newText ?? "" };
  }
  return unifiedDiffToTexts(diff.unified ?? "");
}

/** Linhas adicionadas/removidas de um diff (resumo do cartão). */
export function diffStats(diff: ChatFileDiff): { added: number; removed: number } {
  if (diff.unified !== undefined && diff.oldText === undefined && diff.newText === undefined) {
    let added = 0;
    let removed = 0;
    for (const line of diff.unified.split(/\r?\n/)) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
    return { added, removed };
  }
  const count = (text: string | undefined) => (text ? text.split(/\r?\n/).length : 0);
  return { added: count(diff.newText), removed: count(diff.oldText) };
}

/** Soma consumos (vários eventos `usage` no mesmo turno ⇒ o último vale por campo). */
export function mergeUsage(current: ChatUsage | undefined, update: ChatUsage): ChatUsage {
  const next: ChatUsage = { ...(current ?? {}) };
  for (const key of Object.keys(update) as (keyof ChatUsage)[]) {
    const value = update[key];
    if (typeof value === "number" && Number.isFinite(value)) next[key] = value;
  }
  return next;
}

const integer = new Intl.NumberFormat("pt-BR");
const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** Resumo legível do consumo ("1.234 tokens de entrada · 56 de saída · US$ 0,04"). */
export function formatUsage(usage: ChatUsage | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens != null) parts.push(`${integer.format(usage.inputTokens)} tokens de entrada`);
  if (usage.outputTokens != null) parts.push(`${integer.format(usage.outputTokens)} de saída`);
  if (usage.costUsd != null) parts.push(currency.format(usage.costUsd));
  if (usage.contextUsed != null && usage.contextWindow) {
    const pct = Math.min(100, Math.round((usage.contextUsed / usage.contextWindow) * 100));
    parts.push(`${pct}% do contexto`);
  }
  // Intl usa espaço inquebrável em "US$ 0,04"; normaliza para texto simples.
  return parts.length ? parts.join(" · ").replace(/\u00a0/g, " ") : null;
}

/** Ícone (IconAction) de uma chamada pelo tipo ACP. */
export function toolIcon(kind: string | undefined): string {
  switch (kind) {
    case "read":
      return "toolRead";
    case "edit":
      return "toolEdit";
    case "delete":
      return "toolDelete";
    case "move":
      return "toolMove";
    case "search":
      return "toolSearch";
    case "execute":
      return "toolExecute";
    case "fetch":
      return "toolFetch";
    case "think":
      return "thinking";
    case "plan":
      return "toolPlan";
    default:
      return "toolOther";
  }
}
