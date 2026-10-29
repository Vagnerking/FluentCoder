import type { FileDecoration, GitAnnotationMode, OpenFile } from "../../types";
import { toggleAnnotationMode } from "../../editor/git/gitAnnotations";
import type { MenuItemSpec } from "../ui/Menu";
import type { EditorActionItem } from "./editorActionRegistry";

export interface GitEditorActionsOptions {
  /** Anotação ligada neste editor (padrão "off"). */
  mode: GitAnnotationMode;
  onModeChange: (path: string, mode: GitAnnotationMode) => void;
  /** O arquivo tem blame (rastreado num repositório). */
  hasBlame: (path: string) => boolean;
  decorationFor: (path: string) => FileDecoration | undefined;
  /** Abre a comparação (HEAD ↔ Working tree) do arquivo. */
  onCompareChanges?: (path: string) => void;
  onShowFileHistory?: (path: string) => void;
}

const GIT_CHANGE_KINDS = new Set<FileDecoration["kind"]>([
  "modified",
  "added",
  "deleted",
  "untracked",
  "conflict",
]);

/** Arquivo de texto real (não revisão/diff/untitled/preview de mídia). */
export function isGitAnnotatableFile(file: OpenFile | null): file is OpenFile {
  return Boolean(
    file &&
      !file.readOnly &&
      (file.mode ?? "text") === "text" &&
      !file.path.startsWith("untitled:") &&
      !file.path.startsWith("fluentcoder://")
  );
}

/**
 * Menu Git discreto nas ações do editor: Comparar alterações, Histórico do
 * arquivo e os toggles de anotação (autoria por linha / mapa de recência).
 * Substitui a barra Off|Blame|Heatmap que ficava sempre visível. Aparece só
 * para arquivos versionados; nada liga sozinho.
 */
export function gitEditorAction(opts: GitEditorActionsOptions): EditorActionItem {
  return {
    id: "git",
    icon: "sourceControl",
    label: "Git",
    order: 50,
    when: ({ file }) =>
      isGitAnnotatableFile(file) && (opts.hasBlame(file.path) || !!opts.decorationFor(file.path)),
    pressed: () => opts.mode !== "off",
    menu: ({ file }): MenuItemSpec[] => {
      if (!file) return [];
      const path = file.path;
      const deco = opts.decorationFor(path);
      const changed = !!deco && GIT_CHANGE_KINDS.has(deco.kind) && deco.kind !== "untracked";
      const tracked = opts.hasBlame(path);
      const untrackedHint = "Disponível para arquivos rastreados pelo Git.";
      return [
        {
          id: "git-compare",
          label: "Comparar alterações",
          icon: "openChanges",
          disabled: !changed || !opts.onCompareChanges,
          title: changed ? undefined : "Sem alterações em relação ao HEAD.",
          onSelect: () => opts.onCompareChanges?.(path),
        },
        {
          id: "git-history",
          label: "Histórico do arquivo",
          icon: "fileHistory",
          disabled: !tracked || !opts.onShowFileHistory,
          title: tracked ? undefined : untrackedHint,
          onSelect: () => opts.onShowFileHistory?.(path),
        },
        { id: "git-sep", separator: true },
        {
          id: "git-blame",
          label: "Autoria por linha (blame)",
          icon: "annotationBlame",
          checked: opts.mode === "blame",
          disabled: !tracked,
          title: tracked ? undefined : untrackedHint,
          onSelect: () => opts.onModeChange(path, toggleAnnotationMode(opts.mode, "blame")),
        },
        {
          id: "git-heatmap",
          label: "Mapa de recência (heatmap)",
          icon: "annotationHeatmap",
          checked: opts.mode === "heatmap",
          disabled: !tracked,
          title: tracked ? undefined : untrackedHint,
          onSelect: () => opts.onModeChange(path, toggleAnnotationMode(opts.mode, "heatmap")),
        },
      ];
    },
  };
}
