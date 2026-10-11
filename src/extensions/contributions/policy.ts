/**
 * Modo "somente contribuições": quais extensões instaladas têm as
 * contribuições DECLARATIVAS (temas de cor, temas de ícones, ícones de produto,
 * gramáticas, linguagens, snippets) aplicadas pelo app — sem executar nada.
 *
 * - Sem `main`/`browser` → aplica sempre que habilitada ("sem código").
 * - Com código liberado pelo portão (Compatível/Parcial, ou "Não avaliada" com
 *   liberação explícita) → aplica, e o host roda o código como sempre.
 * - Com código BLOQUEADO (Incompatível, Não avaliada sem liberação, portão de
 *   outra versão) → aplica as contribuições sem rodar o código se a setting
 *   `extensions.applyContributionsWhenCodeBlocked` estiver ligada (padrão).
 * - Desabilitada → nada.
 *
 * Puro (testado em policy.test.ts).
 */

export const DECLARATIVE_POINTS = ["themes", "iconThemes", "productIconThemes", "grammars", "languages", "snippets"] as const;
export type DeclarativePoint = (typeof DECLARATIVE_POINTS)[number];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function hasCode(manifest: Record<string, unknown>): boolean {
  return (typeof manifest.main === "string" && manifest.main.length > 0) || (typeof manifest.browser === "string" && manifest.browser.length > 0);
}

/** Pontos declarativos com pelo menos um item no manifesto. */
export function declarativePoints(manifest: Record<string, unknown>): DeclarativePoint[] {
  const c = isObj(manifest.contributes) ? manifest.contributes : {};
  return DECLARATIVE_POINTS.filter((k) => Array.isArray(c[k]) && (c[k] as unknown[]).length > 0);
}

export interface GateLike {
  verdict: string;
  version: string;
  hostVersion: string;
}

export interface ContributionCandidate {
  id: string;
  version: string;
  enabled: boolean;
  gate: GateLike | null;
  trust: { version: string; hostVersion: string } | null;
  manifest: Record<string, unknown>;
}

export type ContributionMode = "no-code" | "with-code" | "contributions-only" | "off";

export interface ContributionDecision {
  apply: boolean;
  mode: ContributionMode;
  /** Motivo curto (pt-BR) para a UI/saída. */
  reason: string;
  points: DeclarativePoint[];
}

/** O código desta versão está liberado no host (mesma regra do portão)? */
export function codeRunnable(c: ContributionCandidate, hostVersion: string): boolean {
  const g = c.gate;
  if (!g || g.version !== c.version || g.hostVersion !== hostVersion) return false;
  if (g.verdict === "compatible" || g.verdict === "partial") return true;
  return g.verdict === "unknown" && !!c.trust && c.trust.version === c.version && c.trust.hostVersion === hostVersion;
}

export function contributionDecision(c: ContributionCandidate, opts: { hostVersion: string; applyWhenCodeBlocked: boolean }): ContributionDecision {
  const points = declarativePoints(c.manifest);
  if (!points.length) return { apply: false, mode: "off", reason: "sem contribuições declarativas", points };
  if (!c.enabled) return { apply: false, mode: "off", reason: "extensão desabilitada", points };
  if (!hasCode(c.manifest)) return { apply: true, mode: "no-code", reason: "sem código: só contribuições declarativas", points };
  if (codeRunnable(c, opts.hostVersion)) return { apply: true, mode: "with-code", reason: "código liberado pelo portão", points };
  if (opts.applyWhenCodeBlocked)
    return { apply: true, mode: "contributions-only", reason: "somente contribuições: o código da extensão não roda", points };
  return { apply: false, mode: "off", reason: "código bloqueado e contribuições desligadas para extensões bloqueadas", points };
}
