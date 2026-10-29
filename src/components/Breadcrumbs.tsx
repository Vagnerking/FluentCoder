import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { editor } from "monaco-editor";
import type { FileNode, OpenFile } from "../types";
import { readDir, sshListDir } from "../api";
import { samePath } from "../paths";
import { FileIcon } from "../icon-theme/material/FileIcon";
import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";
import {
  breadcrumbPathBudget,
  collapseCrumbs,
  parentPath,
  pathCrumbs,
  rootForPath,
  sortDirEntries,
  symbolIcon,
  symbolSiblings,
  type BreadcrumbRoot,
  type PathCrumb,
  type SymbolNode,
} from "../editor/breadcrumbs";
import { useBreadcrumbSymbols } from "../editor/useBreadcrumbSymbols";
import { BreadcrumbPicker, type BreadcrumbPickerItem } from "./editor/BreadcrumbPicker";
import type { Rect } from "./ui/menuLogic";

interface BreadcrumbsProps {
  file: OpenFile | null;
  /** Raízes do workspace (multi-root/SSH) — a 1ª segmentação usa a mais específica. */
  roots: readonly BreadcrumbRoot[];
  /** Editor Monaco do grupo (símbolos sob o cursor); null fora do modo texto. */
  editor: editor.IStandaloneCodeEditor | null;
  /** Abre um arquivo escolhido no seletor (mesma origem remota do atual). */
  onOpenFile: (path: string, workspaceRemote?: OpenFile["workspaceRemote"]) => void;
}

/** Segmento exibido: caminho, símbolo ou o "…" de caminhos longos. */
type Segment =
  | { kind: "path"; crumb: PathCrumb; next: PathCrumb | null }
  | { kind: "ellipsis"; hidden: PathCrumb[] }
  | { kind: "symbol"; symbol: SymbolNode; depth: number };

type PickerState =
  | { segment: number; anchor: Rect; mode: "dir"; dir: string; current: string | null }
  | { segment: number; anchor: Rect; mode: "list"; items: BreadcrumbPickerItem[]; label: string };

/** Máximo de segmentos de caminho antes de colapsar o meio em "…". */
const MAX_PATH_SEGMENTS = 5;

function toRect(r: DOMRect): Rect {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/**
 * Breadcrumbs navegáveis (estilo VS Code) sob as abas:
 * `raiz › pasta › … › arquivo › símbolo › símbolo`. Cada segmento é um botão
 * que abre um seletor: pastas listam o conteúdo (o próximo segmento
 * destacado), o arquivo lista os irmãos, símbolos listam os símbolos irmãos e
 * navegam até eles. Teclado: ←/→/Home/End entre segmentos, Enter/Espaço/↓
 * abrem o seletor.
 */
export function Breadcrumbs({ file, roots, editor: ed, onOpenFile }: BreadcrumbsProps) {
  const { symbols, chain } = useBreadcrumbSymbols(ed);
  const [focusIndex, setFocusIndex] = useState(-1);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [dirItems, setDirItems] = useState<{ dir: string; items: BreadcrumbPickerItem[] | null; error: string | null }>({
    dir: "",
    items: null,
    error: null,
  });
  const navRef = useRef<HTMLElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const realPath = file ? file.sourcePath ?? file.path : null;
  const remote = file?.workspaceRemote;
  const root = useMemo(
    () => (realPath ? rootForPath(realPath, roots, remote?.folderId) : null),
    [realPath, roots, remote?.folderId]
  );

  // Largura da barra: num grupo estreito o meio do caminho colapsa em "…"
  // (em vez de cada pasta encolher até sobrar só o separador).
  const [navWidth, setNavWidth] = useState(0);
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const read = () => setNavWidth(Math.round(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [realPath]);
  const pathBudget = breadcrumbPathBudget(navWidth, chain.length, MAX_PATH_SEGMENTS);

  const segments = useMemo<Segment[]>(() => {
    if (!realPath) return [];
    const crumbs = pathCrumbs(realPath, roots, { preferRootId: remote?.folderId });
    const out: Segment[] = collapseCrumbs(crumbs, pathBudget).map((d) =>
      d.kind === "ellipsis"
        ? { kind: "ellipsis", hidden: d.hidden }
        : { kind: "path", crumb: d.crumb, next: crumbs[d.index + 1] ?? null }
    );
    chain.forEach((symbol, depth) => out.push({ kind: "symbol", symbol, depth }));
    return out;
  }, [realPath, roots, remote?.folderId, chain, pathBudget]);

  // Mantém o índice focável válido quando o caminho muda.
  useEffect(() => {
    setFocusIndex((i) => (i >= segments.length ? segments.length - 1 : i));
  }, [segments.length]);

  useEffect(() => setPicker(null), [realPath]);

  // Carrega a pasta do seletor (local ou SSH, como o Explorer).
  const pickerDir = picker?.mode === "dir" ? picker.dir : null;
  useEffect(() => {
    if (!pickerDir) return;
    let alive = true;
    setDirItems({ dir: pickerDir, items: null, error: null });
    const list: Promise<FileNode[]> = remote?.connId ? sshListDir(remote.connId, pickerDir) : readDir(pickerDir);
    list.then(
      (entries) => {
        if (!alive) return;
        const items: BreadcrumbPickerItem[] = sortDirEntries(entries).map((e) => ({
          id: e.path,
          label: e.name,
          iconPath: e.path,
          isDir: e.isDir,
        }));
        setDirItems({ dir: pickerDir, items, error: null });
      },
      (err) => {
        if (alive) setDirItems({ dir: pickerDir, items: null, error: `Não foi possível listar a pasta. ${String(err)}` });
      }
    );
    return () => {
      alive = false;
    };
  }, [pickerDir, remote?.connId]);

  const revealSymbol = useCallback(
    (s: SymbolNode) => {
      if (!ed) return;
      const r = s.selectionRange;
      ed.setPosition({ lineNumber: r.startLineNumber, column: r.startColumn });
      ed.revealRangeInCenterIfOutsideViewport(r);
      ed.focus();
    },
    [ed]
  );

  const openSegment = (index: number) => {
    const seg = segments[index];
    const btn = buttonRefs.current[index];
    if (!seg || !btn) return;
    const anchor = toRect(btn.getBoundingClientRect());
    if (seg.kind === "ellipsis") {
      setPicker({
        segment: index,
        anchor,
        mode: "list",
        label: "Pastas ocultas do caminho",
        items: seg.hidden.map((c) => ({ id: c.path, label: c.name, iconPath: c.path, isDir: true })),
      });
    } else if (seg.kind === "symbol") {
      const siblings = symbolSiblings(symbols, chain, seg.depth);
      setPicker({
        segment: index,
        anchor,
        mode: "list",
        label: "Símbolos",
        items: siblings.map((s, i) => ({
          id: `${i}:${s.name}`,
          label: s.name,
          icon: symbolIcon(s.kind) as IconAction,
          current: s === seg.symbol,
        })),
      });
    } else if (seg.crumb.kind === "file") {
      const dir = parentPath(seg.crumb.path);
      if (dir) setPicker({ segment: index, anchor, mode: "dir", dir, current: seg.crumb.path });
    } else {
      setPicker({ segment: index, anchor, mode: "dir", dir: seg.crumb.path, current: seg.next?.path ?? null });
    }
  };

  const onPick = (item: BreadcrumbPickerItem) => {
    if (!picker) return;
    const seg = segments[picker.segment];
    if (picker.mode === "list" && seg?.kind === "symbol") {
      const siblings = symbolSiblings(symbols, chain, seg.depth);
      const target = siblings[Number(item.id.split(":")[0])];
      setPicker(null);
      if (target) revealSymbol(target);
      return;
    }
    if (item.id === ".." && picker.mode === "dir") {
      const up = parentPath(picker.dir);
      if (up) setPicker({ segment: picker.segment, anchor: picker.anchor, mode: "dir", dir: up, current: picker.dir });
      return;
    }
    if (item.isDir) {
      setPicker({ segment: picker.segment, anchor: picker.anchor, mode: "dir", dir: item.id, current: null });
      return;
    }
    setPicker(null);
    onOpenFile(item.id, remote);
  };

  const pickerItems: BreadcrumbPickerItem[] | null = useMemo(() => {
    if (!picker) return null;
    if (picker.mode === "list") return picker.items;
    if (dirItems.dir !== picker.dir || !dirItems.items) return null;
    const cur = picker.current;
    const items = dirItems.items.map((i) => (cur && samePath(i.id, cur) ? { ...i, current: true } : i));
    // "Subir" sem sair da raiz do workspace (fora dela, até a raiz do sistema).
    const up = parentPath(picker.dir);
    const canGoUp = !!up && (!root || !!rootForPath(up, [root]));
    return canGoUp ? [{ id: "..", label: "..", icon: "chevronLeft" as IconAction }, ...items] : items;
  }, [picker, dirItems, root]);

  if (!file || segments.length === 0) return null;

  const tabStop = focusIndex >= 0 ? focusIndex : segments.length - 1;
  const focusAt = (i: number) => {
    const n = segments.length;
    const next = (i + n) % n;
    setFocusIndex(next);
    buttonRefs.current[next]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(segments.length - 1);
        break;
      case "ArrowDown":
      case "Enter":
      case " ":
        e.preventDefault();
        openSegment(index);
        break;
    }
  };

  const pickerSeg = picker ? segments[picker.segment] : null;
  const pickerLabel =
    picker?.mode === "list"
      ? picker.label
      : picker?.mode === "dir"
        ? `Itens em ${picker.dir.split(/[\\/]/).filter(Boolean).pop() ?? picker.dir}`
        : "";

  return (
    <nav className="breadcrumbs" aria-label="Caminho do arquivo e símbolo" ref={navRef}>
      <ol className="breadcrumb-list">
        {segments.map((seg, i) => {
          const last = i === segments.length - 1;
          const label =
            seg.kind === "ellipsis" ? "…" : seg.kind === "symbol" ? seg.symbol.name : seg.crumb.name;
          const aria =
            seg.kind === "ellipsis"
              ? `${seg.hidden.length} pastas ocultas`
              : seg.kind === "symbol"
                ? `Símbolo ${seg.symbol.name}`
                : seg.crumb.kind === "root"
                  ? `Raiz ${seg.crumb.name}`
                  : seg.crumb.name;
          return (
            <li key={`${seg.kind}-${i}-${label}`} className="breadcrumb-item">
              <button
                type="button"
                ref={(el) => {
                  buttonRefs.current[i] = el;
                }}
                className={
                  `breadcrumb-segment${last ? " last" : ""}` +
                  (seg.kind === "symbol" ? " symbol" : "") +
                  (picker?.segment === i ? " open" : "")
                }
                data-kind={seg.kind === "path" ? seg.crumb.kind : seg.kind}
                tabIndex={i === tabStop ? 0 : -1}
                aria-label={aria}
                aria-haspopup="listbox"
                aria-expanded={picker?.segment === i}
                aria-current={seg.kind === "path" && seg.crumb.kind === "file" ? "page" : undefined}
                onFocus={() => setFocusIndex(i)}
                onKeyDown={(e) => onKeyDown(e, i)}
                onClick={() => (picker?.segment === i ? setPicker(null) : openSegment(i))}
              >
                {seg.kind === "path" && seg.crumb.kind === "root" && (
                  <Codicon name="workspaceRoot" size={14} className="crumb-icon" />
                )}
                {seg.kind === "path" && seg.crumb.kind === "file" && (
                  <FileIcon path={seg.crumb.path} className="crumb-icon" />
                )}
                {seg.kind === "symbol" && (
                  <Codicon name={symbolIcon(seg.symbol.kind) as IconAction} size={14} className="crumb-icon crumb-symbol-icon" />
                )}
                <span className="crumb-label">{label}</span>
              </button>
              {!last && <Codicon name="chevronRight" size={12} className="crumb-sep" />}
            </li>
          );
        })}
      </ol>
      {picker && pickerSeg && (
        <BreadcrumbPicker
          anchor={picker.anchor}
          ariaLabel={pickerLabel}
          items={pickerItems}
          error={picker.mode === "dir" && dirItems.dir === picker.dir ? dirItems.error : null}
          emptyText={picker.mode === "dir" ? "Pasta vazia." : "Nenhum símbolo."}
          onPick={onPick}
          onClose={() => setPicker(null)}
          isInside={(t) => !!buttonRefs.current[picker.segment]?.contains(t)}
        />
      )}
    </nav>
  );
}
