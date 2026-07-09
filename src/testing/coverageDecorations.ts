/**
 * Pinta a cobertura de linha de um run de testes nas margens dos editores Monaco
 * abertos (milestone #10). Linhas cobertas ganham uma faixa verde na gutter;
 * não cobertas, vermelha — como o "Coverage" do VS/Rider.
 *
 * O casamento arquivo→modelo é por SUFIXO de caminho: o coletor Cobertura grava
 * caminhos relativos ao projeto (ex.: `src/Calc.cs`), enquanto o modelo tem a URI
 * absoluta; casar pelo fim do caminho é robusto sem depender da raiz exata.
 */
import * as monaco from "monaco-editor";
import type { FileCoverage } from "../api";

/** Ids das decorations de cobertura por URI de modelo (para substituí-las). */
const decorationIds = new Map<string, string[]>();

/** Normaliza para comparação por sufixo (barras + minúsculas p/ Windows). */
function norm(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** True se o caminho absoluto do modelo termina com o caminho relativo do report. */
function matches(modelPath: string, coveragePath: string): boolean {
  const m = norm(modelPath);
  const c = norm(coveragePath).replace(/^\/+/, "");
  return m.endsWith(c) || m.endsWith("/" + c);
}

/**
 * Aplica as decorations de cobertura a todos os modelos abertos que casam com um
 * arquivo do report. Substitui qualquer cobertura anterior. Chamar com `[]`
 * (ou sem cobertura) limpa tudo — usado quando o toggle está off.
 */
export function applyCoverageDecorations(coverage: readonly FileCoverage[]): void {
  clearCoverageDecorations();
  if (coverage.length === 0) return;

  for (const model of monaco.editor.getModels()) {
    const modelPath = model.uri.fsPath ?? model.uri.path;
    const file = coverage.find((c) => matches(modelPath, c.path));
    if (!file) continue;
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
    const ids = model.deltaDecorations([], deco);
    decorationIds.set(model.uri.toString(), ids);
  }
}

/** Remove todas as decorations de cobertura. */
export function clearCoverageDecorations(): void {
  for (const [uri, ids] of decorationIds) {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model && !model.isDisposed()) model.deltaDecorations(ids, []);
  }
  decorationIds.clear();
}
