/**
 * Ações do título do editor para as extensões hospedadas (como o
 * `editor/title` do VS Code): um botão por extensão com view (ícone dela) que
 * revela a view onde ela estiver, e os demais comandos `editor/title`
 * contribuídos (grupo navigation) no menu "Mais ações", filtrados pelo `when`
 * avaliado no host (best effort). Puro (testado em editorTitleActions.test.ts).
 */
import type { ContributedEditorTitleAction, InstalledExtension } from "./protocol";

export interface PlannedEditorAction {
  id: string;
  label: string;
  /** Data URI do ícone da extensão (máscara), quando houver. */
  iconImage?: string;
  extensionId: string;
  kind: "reveal" | "command";
  /** `reveal`: comandos de "abrir a sidebar" que a extensão contribui e valem agora. */
  commands: string[];
  group: "primary" | "overflow";
  order: number;
}

export function whenKey(extensionId: string, command: string): string {
  return `${extensionId}|${command}`;
}

/** Comando que só abre/mostra a view de sidebar da extensão (= o nosso "revelar"). */
export function isSidebarCommand(a: Pick<ContributedEditorTitleAction, "command" | "title">): boolean {
  return /sidebar/i.test(a.command) || /\bsidebar\b|barra lateral/i.test(a.title);
}

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

/**
 * `whenResults[whenKey(ext, cmd)]`: resultado do `when` no host; ausente =
 * ainda não avaliado (só passa quem não tem `when`).
 */
export function planExtensionEditorActions(
  installed: readonly InstalledExtension[],
  whenResults: Readonly<Record<string, boolean>>,
): PlannedEditorAction[] {
  const out: PlannedEditorAction[] = [];
  const applies = (ext: InstalledExtension, a: ContributedEditorTitleAction) => {
    const r = whenResults[whenKey(ext.id, a.command)];
    return r === undefined ? !a.when : r;
  };
  installed
    .filter((e) => e.supported)
    .forEach((ext, i) => {
      const contributed = ext.editorTitle ?? [];
      if (ext.viewIds.length > 0) {
        out.push({
          id: `ext-view-${slug(ext.id)}`,
          label: `Mostrar ${ext.label}`,
          iconImage: ext.icon,
          extensionId: ext.id,
          kind: "reveal",
          commands: contributed.filter((a) => isSidebarCommand(a) && applies(ext, a)).map((a) => a.command),
          group: "primary",
          order: 20 + i,
        });
      }
      contributed
        .filter((a) => !(ext.viewIds.length > 0 && isSidebarCommand(a)) && applies(ext, a))
        .forEach((a, j) => {
          out.push({
            id: `ext-cmd-${slug(a.command)}`,
            label: a.title,
            iconImage: a.icon && "src" in a.icon ? a.icon.src : ext.icon,
            extensionId: ext.id,
            kind: "command",
            commands: [a.command],
            group: "overflow",
            order: 30 + i * 10 + j,
          });
        });
    });
  return out;
}
