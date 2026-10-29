/**
 * Porta de entrada de arquivos LOCAIS no editor de texto: sonda tamanho e
 * binário (`probe_file`, 8 KB) ANTES de ler tudo, pergunta quando preciso e
 * devolve como abrir. Ver `fileOpenPolicy.ts` para os limites.
 */

import { ask } from "@tauri-apps/plugin-dialog";
import { probeFile } from "../api";
import { decideOpen, formatSize, openLimitsFromSettings } from "./fileOpenPolicy";
import { settings } from "../settings/instance";

export interface OpenGate {
  /** Pode ler acima do limite de 50 MB (o usuário aceitou). */
  allowLarge: boolean;
  /** Abre em modo de arquivo grande (sem LSP/recursos pesados). */
  largeFile: boolean;
  /** Abre somente leitura (arquivos enormes). */
  readOnly: boolean;
  /** Rótulo da faixa somente leitura. */
  sourceLabel?: string;
}

/** `null` = o usuário desistiu (ou a sonda falhou e já foi reportada pelo chamador). */
export async function gateLocalTextOpen(path: string, name: string): Promise<OpenGate | null> {
  let probe;
  try {
    probe = await probeFile(path);
  } catch {
    // Sem sonda (arquivo novo/virtual): segue o caminho normal; o read_file
    // ainda recusa o que passar do limite.
    return { allowLarge: false, largeFile: false, readOnly: false };
  }
  // Sonda vazia (backend sem resposta): caminho normal.
  if (!probe) return { allowLarge: false, largeFile: false, readOnly: false };
  const decision = decideOpen(
    probe,
    openLimitsFromSettings(settings.get("fluent.editor.largeFileThresholdMB"), settings.get("files.maxMemoryForLargeFilesMB")),
  );
  const size = formatSize(probe.size);
  switch (decision.kind) {
    case "normal":
      return { allowLarge: false, largeFile: false, readOnly: false };
    case "large":
      return { allowLarge: false, largeFile: true, readOnly: false };
    case "confirm-huge": {
      const ok = await ask(
        `"${name}" tem ${size}. Abrir somente leitura, em modo de arquivo grande (sem realce, IntelliSense e outros recursos pesados)?`,
        { title: "Arquivo muito grande", kind: "warning", okLabel: "Abrir somente leitura", cancelLabel: "Cancelar" },
      );
      return ok
        ? { allowLarge: true, largeFile: true, readOnly: true, sourceLabel: `Arquivo grande (${size}) — somente leitura` }
        : null;
    }
    case "confirm-binary": {
      const ok = await ask(`"${name}" parece ser um arquivo binário (${size}). Abrir mesmo assim como texto?`, {
        title: "Arquivo binário",
        kind: "warning",
        okLabel: "Abrir como texto",
        cancelLabel: "Cancelar",
      });
      if (!ok) return null;
      return {
        allowLarge: true,
        largeFile: true,
        readOnly: true,
        sourceLabel: `Arquivo binário (${size}) aberto como texto — somente leitura`,
      };
    }
  }
}
