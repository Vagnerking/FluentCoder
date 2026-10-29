import type { BlameHunk, GitAnnotationMode } from "../../types";

/** Faixa de recência de uma linha (heatmap). `date` vem relativo do backend. */
export type BlameAgeBucket = "hot" | "warm" | "cool" | "cold";

export function blameAgeBucket(date: string): BlameAgeBucket {
  const normalized = date.toLowerCase();
  const amount = Number(normalized.match(/(\d+)/)?.[1] ?? "0");
  if (
    normalized.includes("agora") ||
    normalized.includes("min") ||
    normalized.includes("hora") ||
    // "há 3 h" (backend). Não usar /\bh\b/: em "há" o "á" não é caractere de
    // palavra ASCII, então TODA data ("há 2 anos") virava "hot".
    /\d+\s*h\b/.test(normalized)
  ) {
    return "hot";
  }
  if (normalized.includes("dia")) return amount <= 14 ? "warm" : "cool";
  if (normalized.includes("semana")) return amount <= 4 ? "warm" : "cool";
  if (normalized.includes("mês") || normalized.includes("mes")) return "cool";
  return "cold";
}

const OVERVIEW_COLORS: Record<BlameAgeBucket, string> = {
  hot: "#60CDFF",
  warm: "#8FE0AD",
  cool: "#E2C08D",
  cold: "#7D8795",
};
const BLAME_OVERVIEW_COLOR = "rgba(96, 205, 255, 0.42)";

/** Uma decoração de anotação, independente do Monaco (testável). */
export interface FileAnnotationSpec {
  line: number;
  className: string;
  overviewColor: string;
  hunk: BlameHunk;
}

/**
 * Decorações de gutter para o modo pedido. `off` (o padrão de todo editor)
 * não produz nada: anotações só aparecem por toggle explícito.
 */
export function buildFileAnnotationSpecs(
  blame: ReadonlyMap<number, BlameHunk>,
  lineCount: number,
  mode: GitAnnotationMode
): FileAnnotationSpec[] {
  if (mode === "off" || blame.size === 0) return [];
  const specs: FileAnnotationSpec[] = [];
  for (let line = 1; line <= lineCount; line++) {
    const hunk = blame.get(line);
    if (!hunk) continue;
    if (mode === "blame") {
      specs.push({ line, className: "git-file-annotation-blame", overviewColor: BLAME_OVERVIEW_COLOR, hunk });
    } else {
      const bucket = blameAgeBucket(hunk.date || "");
      specs.push({
        line,
        className: `git-file-annotation-heatmap git-file-annotation-${bucket}`,
        overviewColor: OVERVIEW_COLORS[bucket],
        hunk,
      });
    }
  }
  return specs;
}

/** Alterna um modo: ativar o mesmo modo de novo desliga (toggle). */
export function toggleAnnotationMode(current: GitAnnotationMode, next: Exclude<GitAnnotationMode, "off">): GitAnnotationMode {
  return current === next ? "off" : next;
}
