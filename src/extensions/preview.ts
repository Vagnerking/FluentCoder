/**
 * Classificação da PRÉVIA de um resultado da loja (antes de instalar), a partir
 * do `extensions_preflight` do Rust. Mesmo classificador do portão; só soma os
 * motivos da fase (código grande demais, fonte sem arquivos, prévia
 * incompleta). Nunca grava portão: depois de instalar, o portão é recalculado
 * sobre os arquivos extraídos.
 */
import type { Preflight } from "./catalog";
import { classify, type Capabilities, type CompatibilityReport, type Reason } from "./compatibility.ts";

const CODE_NOTE: Partial<Record<Preflight["code"], string>> = {
  "too-large": "Prévia: o código principal é grande demais para analisar antes de instalar.",
  unavailable: "Prévia: a fonte não publica os arquivos do pacote (ou falhou); o código só é analisado depois de instalar.",
};

export function classifyPreview(p: Preflight, platform: string, installedIds: ReadonlySet<string>, caps: Capabilities): CompatibilityReport {
  const report = classify({ manifest: p.manifest, targetPlatform: p.targetPlatform, hostPlatform: platform, apiScan: p.apiScan, installedIds }, caps);
  const extra: Reason[] = [];
  const note = CODE_NOTE[p.code];
  if (note) extra.push({ severity: "info", code: "preview-code", message: p.codeError ? `${note} (${p.codeError})` : note });
  const reasons = report.reasons.map((r) =>
    r.code === "code-truncated" && p.codeGaps.length
      ? { ...r, message: `Prévia incompleta (o que ficou de fora: ${p.codeGaps.slice(0, 3).join("; ")}). A análise completa roda depois de instalar.` }
      : r,
  );
  return { ...report, reasons: [...reasons, ...extra] };
}
