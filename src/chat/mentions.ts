/**
 * Menções `#`/`@` do composer (estilo Copilot Chat): detecção do token sob o
 * cursor, catálogo de contextos, ranking (fuzzy + sem acento) e remoção do
 * token quando a menção vira chip. Funções puras — testadas em
 * `mentions.test.ts`.
 */
import { rankFiles } from "../quickOpen/fuzzy.ts";
import type { ProjectFile } from "../types.ts";

/** Tipos de contexto anexáveis. */
export type MentionKind =
  | "file"
  | "activeFile"
  | "selection"
  | "problems"
  | "graph"
  | "context"
  | "terminal"
  | "workspace";

export interface MentionDefinition {
  kind: MentionKind;
  trigger: "#" | "@";
  /** Nome digitado após o gatilho (pt-BR). */
  name: string;
  /** Sinônimos aceitos na busca (en/sem acento). */
  aliases: string[];
  description: string;
  /** IconAction. */
  icon: string;
}

export const MENTIONS: MentionDefinition[] = [
  {
    kind: "activeFile",
    trigger: "#",
    name: "arquivo",
    aliases: ["file", "arquivo-ativo", "editor"],
    description: "Arquivo aberto no editor",
    icon: "file",
  },
  {
    kind: "selection",
    trigger: "#",
    name: "seleção",
    aliases: ["selecao", "selection", "trecho"],
    description: "Trecho selecionado no editor",
    icon: "selection",
  },
  {
    kind: "problems",
    trigger: "#",
    name: "problemas",
    aliases: ["problems", "erros", "diagnosticos", "diagnostics"],
    description: "Erros e avisos do workspace",
    icon: "warning",
  },
  {
    kind: "graph",
    trigger: "#",
    name: "grafo",
    aliases: ["graph", "vizinhos", "relacionados"],
    description: "Arquivo ativo + vizinhos no grafo de conhecimento",
    icon: "graph",
  },
  {
    kind: "context",
    trigger: "#",
    name: "contexto",
    aliases: ["context", "relevantes"],
    description: "Arquivos relevantes à pergunta (grafo de conhecimento)",
    icon: "backlinks",
  },
  {
    kind: "terminal",
    trigger: "#",
    name: "terminal",
    aliases: ["saida", "output", "console"],
    description: "Última saída do terminal integrado",
    icon: "terminal",
  },
  {
    kind: "workspace",
    trigger: "@",
    name: "workspace",
    aliases: ["projeto", "codebase", "pasta"],
    description: "Busca no workspace guiada pelo grafo de conhecimento",
    icon: "workspaceContext",
  },
];

export function mentionDefinition(kind: MentionKind): MentionDefinition {
  return MENTIONS.find((mention) => mention.kind === kind) ?? MENTIONS[0];
}

/** Token de menção sob o cursor. */
export interface MentionTrigger {
  trigger: "#" | "@";
  /** Texto digitado após o gatilho (até o cursor). */
  query: string;
  /** Índice do gatilho no texto. */
  start: number;
  /** Índice logo após o token (posição do cursor). */
  end: number;
}

const TOKEN_CHAR = /[\p{L}\p{N}_\-./:]/u;

/**
 * Detecta `#algo`/`@algo` imediatamente antes do cursor. O gatilho precisa
 * estar no início do texto ou depois de espaço (evita `a#b`, e-mails, `C#`).
 */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  let index = caret;
  while (index > 0 && TOKEN_CHAR.test(text[index - 1])) index -= 1;
  const triggerIndex = index - 1;
  if (triggerIndex < 0) return null;
  const trigger = text[triggerIndex];
  if (trigger !== "#" && trigger !== "@") return null;
  if (triggerIndex > 0 && !/\s/.test(text[triggerIndex - 1])) return null;
  return {
    trigger,
    query: text.slice(index, caret),
    start: triggerIndex,
    end: caret,
  };
}

/** Minúsculas sem acento (busca tolerante: "selecao" acha "seleção"). */
export function foldText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export type MentionSuggestion =
  | { type: "mention"; id: string; mention: MentionDefinition; score: number }
  | { type: "file"; id: string; file: ProjectFile; positions: number[]; score: number };

function mentionScore(mention: MentionDefinition, query: string): number | null {
  const q = foldText(query);
  if (!q) return 0;
  const names = [mention.name, ...mention.aliases].map(foldText);
  let best: number | null = null;
  for (const name of names) {
    let score: number | null = null;
    if (name === q) score = 300;
    else if (name.startsWith(q)) score = 200 - name.length;
    else if (name.includes(q)) score = 100 - name.length;
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

/**
 * Sugestões do popup: menções do gatilho filtradas pelo texto e, no `#`,
 * arquivos do índice do Quick Open (fuzzy) — como o `#` do Copilot.
 */
export function mentionSuggestions(
  trigger: MentionTrigger,
  files: ProjectFile[],
  options: { maxFiles?: number } = {},
): MentionSuggestion[] {
  const mentions = MENTIONS.filter((mention) => mention.trigger === trigger.trigger)
    .map((mention) => ({ mention, score: mentionScore(mention, trigger.query) }))
    .filter((entry): entry is { mention: MentionDefinition; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .map(({ mention, score }) => ({
      type: "mention" as const,
      id: `mention:${mention.kind}`,
      mention,
      score,
    }));
  if (trigger.trigger !== "#" || !trigger.query.trim()) return mentions;
  const fileQuery = trigger.query.replace(/^arquivo:/i, "");
  const ranked = rankFiles(fileQuery, files)
    .slice(0, options.maxFiles ?? 8)
    .map((entry) => ({
      type: "file" as const,
      id: `file:${entry.file.path}`,
      file: entry.file,
      positions: entry.positions,
      score: entry.score,
    }));
  return [...mentions, ...ranked];
}

/** Remove o token de menção do texto e devolve o novo cursor. */
export function removeMentionToken(
  text: string,
  trigger: MentionTrigger,
): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  let after = text.slice(trigger.end);
  // Evita espaço duplo quando o token estava entre palavras.
  if (before.endsWith(" ") && after.startsWith(" ")) after = after.slice(1);
  return { text: before + after, caret: before.length };
}
