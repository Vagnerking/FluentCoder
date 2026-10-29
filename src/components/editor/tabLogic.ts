/**
 * Regras puras das abas do editor (testadas em tabLogic.test.ts): foco
 * itinerante por teclado, desambiguação de nomes iguais, aba de preview e
 * abas fixadas.
 */
import type { OpenFile } from "../../types";

/**
 * Próximo índice de foco itinerante numa tablist horizontal (WAI-ARIA, com
 * ativação manual: as setas só movem o foco; Enter/Espaço ativam). Retorna
 * null para teclas que não navegam.
 */
export function tabRovingIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  const i = Math.min(Math.max(current, 0), count - 1);
  switch (key) {
    case "ArrowRight":
      return (i + 1) % count;
    case "ArrowLeft":
      return (i - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

function dirSegments(path: string): string[] {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop(); // o próprio arquivo
  return parts;
}

/**
 * Sufixo (pasta pai, esmaecido) para abas com o mesmo nome — como o VS Code:
 * `index.ts  src/git` vs `index.ts  src/styles`. Usa o menor número de pastas
 * finais que distingue cada arquivo dos homônimos; nomes únicos não recebem
 * sufixo. Caminhos virtuais usam `sourcePath` quando houver.
 */
export function tabDescriptions(
  files: readonly Pick<OpenFile, "path" | "name" | "sourcePath">[]
): Map<string, string> {
  const byName = new Map<string, Pick<OpenFile, "path" | "name" | "sourcePath">[]>();
  for (const f of files) {
    const key = f.name.toLocaleLowerCase();
    const list = byName.get(key);
    if (list) list.push(f);
    else byName.set(key, [f]);
  }
  const out = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const dirs = group.map((f) => dirSegments(f.sourcePath ?? f.path));
    const maxDepth = Math.max(...dirs.map((d) => d.length));
    group.forEach((f, idx) => {
      const mine = dirs[idx];
      let suffix = "";
      for (let k = 1; k <= Math.max(1, maxDepth); k++) {
        const tail = mine.slice(-k).join("/");
        const clash = dirs.some((other, j) => j !== idx && other.slice(-k).join("/") === tail);
        suffix = tail;
        if (!clash || k >= mine.length) break;
      }
      // Mostra só o fim distintivo; prefixo "…/" quando há pastas acima.
      const depthShown = suffix ? suffix.split("/").length : 0;
      out.set(f.path, depthShown && depthShown < mine.length ? `…/${suffix}` : suffix);
    });
  }
  return out;
}

/**
 * Abre `tab` na lista. Como preview (`preview: true`), substitui no mesmo
 * lugar a aba de preview existente que não esteja suja; senão acrescenta.
 */
export function openTabInList(files: readonly OpenFile[], tab: OpenFile): OpenFile[] {
  if (tab.preview) {
    const i = files.findIndex((f) => f.preview && !f.dirty && f.path !== tab.path);
    if (i >= 0) {
      const next = [...files];
      next[i] = tab;
      return next;
    }
  }
  return [...files, tab];
}

/**
 * Fixa/desafixa uma aba. Fixadas ficam no bloco inicial (na ordem em que
 * foram fixadas); fixar também tira do modo preview.
 */
export function setTabPinned(files: readonly OpenFile[], path: string, pinned: boolean): OpenFile[] {
  const i = files.findIndex((f) => f.path === path);
  if (i < 0) return [...files];
  const tab: OpenFile = { ...files[i], pinned: pinned || undefined, preview: pinned ? undefined : files[i].preview };
  const rest = files.filter((_, j) => j !== i);
  const pinnedCount = rest.filter((f) => f.pinned).length;
  // Fixar: fim do bloco fixado. Desafixar: logo após ele.
  const at = pinnedCount;
  return [...rest.slice(0, at), tab, ...rest.slice(at)];
}

export type CloseScope = "others" | "left" | "right" | "all";

/**
 * Abas que FICAM após "Fechar outras/à esquerda/à direita/todas" a partir de
 * `path`. Abas fixadas nunca são fechadas por esses comandos em lote.
 */
export function tabsKeptAfterClose(files: readonly OpenFile[], path: string | null, scope: CloseScope): OpenFile[] {
  const idx = path ? files.findIndex((f) => f.path === path) : -1;
  return files.filter((f, i) => {
    if (f.pinned) return true;
    switch (scope) {
      case "others":
        return f.path === path;
      case "left":
        return idx < 0 || i >= idx;
      case "right":
        return idx < 0 || i <= idx;
      case "all":
        return false;
    }
  });
}
