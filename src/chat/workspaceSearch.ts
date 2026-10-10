/**
 * Busca no workspace guiada pelo grafo de conhecimento (`@workspace` e
 * `#contexto`): pontua os arquivos do índice (`build_knowledge_index`) pelos
 * termos da pergunta — nome, caminho, tags e títulos — e reforça a vizinhança
 * do arquivo ativo no grafo (links/imports de saída e backlinks) e os "hubs"
 * (arquivos muito referenciados). Pura e testável.
 */
import type { KnowledgeFile, KnowledgeIndex } from "../types.ts";
import { foldText } from "./mentions.ts";

const STOPWORDS = new Set(
  (
    "a o os as um uma uns umas de do da dos das em no na nos nas por para pra com sem que " +
    "qual quais como onde quando porque se ou e é ser está esta este isso isto esse essa " +
    "meu minha seu sua nosso nossa ele ela eles elas eu voce você me te lhe mais menos " +
    "the a an of to in on for with and or is are be this that what how where why which " +
    "do does can could should would please explique explica mostre mostra faca faça " +
    "codigo código arquivo arquivos projeto workspace funciona funcionamento"
  ).split(/\s+/),
);

/** Termos relevantes da pergunta (sem acento, sem stopwords, ≥ 3 letras). */
export function queryTerms(query: string): string[] {
  const words = foldText(query)
    .split(/[^a-z0-9_]+/)
    // camelCase/PascalCase já vem minúsculo; quebra snake_case também.
    .flatMap((word) => [word, ...word.split("_")])
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  return [...new Set(words)];
}

export interface RankedKnowledgeFile {
  file: KnowledgeFile;
  score: number;
  /** Por que o arquivo entrou (exibido ao modelo). */
  reasons: string[];
}

/** Separa um caminho/nome em pedaços comparáveis (camelCase, `-`, `_`, `.`). */
function pathTokens(rel: string): string[] {
  return foldText(rel.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function rankKnowledge(
  index: KnowledgeIndex,
  query: string,
  options: { seedPath?: string | null; limit?: number } = {},
): RankedKnowledgeFile[] {
  const terms = queryTerms(query);
  const seed = options.seedPath ?? null;
  const backlinkCount = new Map<string, number>();
  const neighbours = new Set<string>();
  for (const file of index.files) {
    for (const link of file.outgoing) {
      backlinkCount.set(link.target, (backlinkCount.get(link.target) ?? 0) + 1);
      if (seed && file.path === seed) neighbours.add(link.target);
      if (seed && link.target === seed) neighbours.add(file.path);
    }
  }

  const ranked: RankedKnowledgeFile[] = [];
  for (const file of index.files) {
    let score = 0;
    const reasons: string[] = [];
    const name = foldText(file.name);
    const tokens = pathTokens(file.rel);
    for (const term of terms) {
      if (name.includes(term)) {
        score += 6;
        reasons.push(`nome contém "${term}"`);
      } else if (tokens.some((token) => token.includes(term))) {
        score += 3;
        reasons.push(`caminho contém "${term}"`);
      }
      const heading = file.headings.find((h) => foldText(h.text).includes(term));
      if (heading) {
        score += 2;
        reasons.push(`título "${heading.text}"`);
      }
      if (file.tags.some((tag) => foldText(tag).includes(term))) {
        score += 3;
        reasons.push(`tag com "${term}"`);
      }
    }
    if (seed && file.path === seed) {
      score += 8;
      reasons.push("arquivo ativo");
    } else if (neighbours.has(file.path)) {
      score += 4;
      reasons.push("conectado ao arquivo ativo no grafo");
    }
    if (score > 0) {
      const degree = backlinkCount.get(file.path) ?? 0;
      if (degree > 0) {
        score += Math.min(3, Math.log2(1 + degree));
        if (degree >= 3) reasons.push(`referenciado por ${degree} arquivos`);
      }
      ranked.push({ file, score, reasons: [...new Set(reasons)] });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.file.rel.length - b.file.rel.length);
  return ranked.slice(0, options.limit ?? 12);
}

/** Arquivos mais referenciados do workspace (visão geral do `@workspace`). */
export function knowledgeHubs(index: KnowledgeIndex, limit = 8): { rel: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const file of index.files) {
    for (const link of file.outgoing) counts.set(link.target, (counts.get(link.target) ?? 0) + 1);
  }
  const relOf = new Map(index.files.map((file) => [file.path, file.rel]));
  return [...counts.entries()]
    .filter(([path]) => relOf.has(path))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, count]) => ({ rel: relOf.get(path) as string, count }));
}

/**
 * Bloco de contexto do `@workspace`/`#contexto`: arquivos relevantes com o
 * motivo, títulos e conexões; o conteúdo dos principais vem à parte.
 */
export function formatWorkspaceContext(
  title: string,
  ranked: RankedKnowledgeFile[],
  index: KnowledgeIndex,
  extras: { hubs?: { rel: string; count: number }[]; contents?: { rel: string; content: string; lang: string }[] } = {},
): string {
  const relOf = new Map(index.files.map((file) => [file.path, file.rel]));
  const lines: string[] = [title];
  lines.push(`Workspace com ${index.files.length} arquivo(s) indexado(s).`);
  if (ranked.length === 0) {
    lines.push("Nenhum arquivo do grafo de conhecimento corresponde aos termos da pergunta.");
  } else {
    lines.push("Arquivos relevantes (grafo de conhecimento):");
    for (const entry of ranked) {
      const links = [...new Set(entry.file.outgoing.map((link) => relOf.get(link.target)).filter(Boolean))]
        .slice(0, 5)
        .join(", ");
      const headings = entry.file.headings.slice(0, 4).map((h) => h.text).join(" / ");
      let line = `- \`${entry.file.rel}\` — ${entry.reasons.join("; ") || "relacionado"}`;
      if (headings) line += ` · títulos: ${headings}`;
      if (links) line += ` · aponta para: ${links}`;
      lines.push(line);
    }
  }
  if (extras.hubs?.length) {
    lines.push(
      "Arquivos centrais (mais referenciados): " +
        extras.hubs.map((hub) => `\`${hub.rel}\` (${hub.count})`).join(", "),
    );
  }
  for (const content of extras.contents ?? []) {
    lines.push(`\nConteúdo de \`${content.rel}\`:\n\`\`\`${content.lang}\n${content.content}\n\`\`\``);
  }
  return lines.join("\n");
}
