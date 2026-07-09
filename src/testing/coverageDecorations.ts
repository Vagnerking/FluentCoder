/**
 * Pinta a cobertura de linha de um run de testes nas margens dos editores Monaco
 * (milestone #10). Linhas cobertas ganham uma faixa verde na gutter; não cobertas,
 * vermelha — como o "Coverage" do VS/Rider.
 *
 * O backend agora grava caminho ABSOLUTO (juntando `<sources>` do report), então o
 * casamento arquivo→modelo é por igualdade normalizada; o sufixo fica só como
 * fallback para reports sem `<sources>`. A última cobertura é guardada e reaplicada
 * a modelos abertos DEPOIS do run (via `onDidCreateModel`).
 */
import * as monaco from "monaco-editor";
import type { FileCoverage } from "../api";

/** Ids das decorations de cobertura por URI de modelo (para substituí-las). */
const decorationIds = new Map<string, string[]>();
/** Última cobertura aplicada, para reaplicar em modelos abertos depois. */
let lastCoverage: readonly FileCoverage[] = [];
/** Listener de criação de modelo (registrado uma vez, sob demanda). */
let createListener: monaco.IDisposable | null = null;

/** Normaliza para comparação (barras + minúsculas p/ Windows). */
function norm(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** Casa por igualdade normalizada; fallback de sufixo numa fronteira de segmento
 *  (para reports sem `<sources>`, onde o path é relativo). */
function matches(modelPath: string, coveragePath: string): boolean {
  const m = norm(modelPath);
  const c = norm(coveragePath).replace(/^\/+/, "");
  return m === c || m.endsWith("/" + c);
}

/** Pinta a cobertura de UM modelo, guardando os ids. No-op se não houver match. */
function decorateModel(model: monaco.editor.ITextModel): void {
  if (model.isDisposed()) return;
  const modelPath = model.uri.fsPath ?? model.uri.path;
  const file = lastCoverage.find((c) => matches(modelPath, c.path));
  if (!file) return;
  const lineCount = model.getLineCount();
  const deco: monaco.editor.IModelDeltaDecoration[] = [];
  const push = (line: number, cls: string) => {
    if (line < 1 || line > lineCount) return;
    deco.push({
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: false, linesDecorationsClassName: cls },
    });
  };
  for (const l of file.coveredLines) push(l, "coverage-covered");
  for (const l of file.uncoveredLines) push(l, "coverage-uncovered");
  const prev = decorationIds.get(model.uri.toString()) ?? [];
  decorationIds.set(model.uri.toString(), model.deltaDecorations(prev, deco));
}

/**
 * Aplica as decorations de cobertura a todos os modelos abertos. Substitui a
 * cobertura anterior. Chamar com `[]` limpa tudo (toggle off).
 */
export function applyCoverageDecorations(coverage: readonly FileCoverage[]): void {
  clearCoverageDecorations();
  lastCoverage = coverage;
  if (coverage.length === 0) return;
  for (const model of monaco.editor.getModels()) decorateModel(model);
  // Modelos abertos DEPOIS do run também recebem a cobertura (padrão do repo).
  if (!createListener) {
    createListener = monaco.editor.onDidCreateModel((m) => decorateModel(m));
  }
}

/** Remove todas as decorations de cobertura e para de decorar novos modelos. */
export function clearCoverageDecorations(): void {
  for (const [uri, ids] of decorationIds) {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model && !model.isDisposed()) model.deltaDecorations(ids, []);
  }
  decorationIds.clear();
  lastCoverage = [];
  createListener?.dispose();
  createListener = null;
}
