import type {
  EditorDiffPresentation,
  GitDiffSide,
  GitFileStatus,
} from "../types";

/** Grupo do Controle de Código em que o item foi clicado. */
export type ScmGroup = "changes" | "staged" | "conflict";

/** Como abrir um item do SCM: texto normal ou comparação com lados explícitos. */
export type ScmOpenTarget =
  | { kind: "text" }
  | { kind: "diff"; view: "working" | "staged"; diff: EditorDiffPresentation };

function indexCode(code: string): string {
  return code.charAt(0) || " ";
}
function worktreeCode(code: string): string {
  return code.charAt(1) || " ";
}

/**
 * Decide o que clicar num item do Controle de Código abre (estilo VS Code):
 *
 * - conflito → o arquivo (com os marcadores), não um diff;
 * - não rastreado → o arquivo (não há lado anterior para comparar);
 * - preparado (index) → HEAD ↔ Index (adicionado no index: vazio ↔ Index;
 *   removido no index: HEAD ↔ vazio);
 * - alteração não preparada → Index ↔ Working tree quando o arquivo também tem
 *   algo preparado; senão HEAD ↔ Working tree (removido: … ↔ vazio).
 */
export function scmOpenTarget(file: Pick<GitFileStatus, "code" | "untracked" | "conflicted">, group: ScmGroup): ScmOpenTarget {
  if (group === "conflict" || file.conflicted) return { kind: "text" };
  if (file.untracked || file.code === "??") return { kind: "text" };
  const x = indexCode(file.code);
  const y = worktreeCode(file.code);
  if (group === "staged") {
    return {
      kind: "diff",
      view: "staged",
      diff: {
        original: x === "A" || x === "C" ? "empty" : "HEAD",
        modified: x === "D" ? "empty" : "index",
      },
    };
  }
  const stagedToo = x !== " " && x !== "?";
  return {
    kind: "diff",
    view: "working",
    diff: {
      original: stagedToo ? "index" : "HEAD",
      modified: y === "D" ? "empty" : "workingTree",
    },
  };
}

/** Rótulo de um lado da comparação, exibido acima do diff e no nome da aba. */
export function diffSideLabel(side: GitDiffSide): string {
  switch (side) {
    case "HEAD":
      return "HEAD";
    case "index":
      return "Index";
    case "workingTree":
      return "Working tree";
    case "empty":
      return "(vazio)";
  }
}

/** Nome da aba de comparação: `arquivo.ts (Index ↔ Working tree)`. */
export function diffTabName(fileName: string, diff: EditorDiffPresentation): string {
  return `${fileName} (${diffSideLabel(diff.original)} ↔ ${diffSideLabel(diff.modified)})`;
}
