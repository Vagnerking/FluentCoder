/**
 * Seletores de tema (Paleta "Preferências: Tema de Cores" / "Tema de Ícones
 * de Arquivo" / "Tema de Ícones do Produto" e os botões "Aplicar tema" /
 * "Aplicar ícones" do view Extensões). Como no VS Code: as setas aplicam o
 * tema em PRÉVIA ao vivo; Enter salva; Esc volta ao tema salvo.
 *
 * `openThemePicker(kind, { extensionId })` pode ser chamado de qualquer lugar;
 * `<ThemePickerHost />` (montado uma vez no App) desenha o seletor.
 */
import { useSyncExternalStore } from "react";
import { QuickPick, type QuickPickItem } from "../components/QuickPick";
import { themeRegistry, type ThemeEntry, type ThemeKind } from "./registry";

interface PickerRequest {
  kind: ThemeKind;
  extensionId?: string;
}

let request: PickerRequest | null = null;
const listeners = new Set<() => void>();
const set = (r: PickerRequest | null) => {
  request = r;
  for (const l of [...listeners]) l();
};

const TITLE: Record<ThemeKind, string> = {
  color: "Tema de Cores",
  fileIcon: "Tema de Ícones de Arquivo",
  productIcon: "Tema de Ícones do Produto",
};

/** Abre o seletor; com `extensionId`, só os temas daquela extensão. */
export function openThemePicker(kind: ThemeKind, opts: { extensionId?: string } = {}): void {
  set({ kind, extensionId: opts.extensionId });
}

/** Temas de uma extensão (para o view Extensões decidir se mostra o botão). */
export function extensionThemes(kind: ThemeKind, extensionId: string): ThemeEntry[] {
  return themeRegistry.list(kind).filter((e) => e.origin.type === "extension" && e.origin.extensionId === extensionId);
}

function groupLabel(e: ThemeEntry): string {
  if (e.kind !== "color") return e.origin.type === "builtin" ? "Embutido" : e.origin.extensionName;
  const base = e.uiTheme === "vs" ? "claro" : e.uiTheme === "hc-black" || e.uiTheme === "hc-light" ? "alto contraste" : "escuro";
  return e.origin.type === "builtin" ? `Embutido · ${base}` : `${e.origin.extensionName} · ${base}`;
}

function toItems(kind: ThemeKind, extensionId?: string): QuickPickItem[] {
  const list = themeRegistry.list(kind).filter((e) => !extensionId || (e.origin.type === "extension" && e.origin.extensionId === extensionId));
  // Como no VS Code: claros, escuros e alto contraste juntos; embutidos primeiro.
  const order = (e: ThemeEntry) =>
    kind === "color" ? (e.uiTheme === "vs" ? 0 : e.uiTheme === "hc-black" || e.uiTheme === "hc-light" ? 2 : 1) : e.id === "Nenhum" ? 1 : 0; // "Nenhum" por último
  const sorted = [...list].sort((a, b) => order(a) - order(b) || (a.origin.type === "builtin" ? -1 : 1) - (b.origin.type === "builtin" ? -1 : 1) || a.label.localeCompare(b.label));
  return sorted.map((e) => ({ id: e.id, label: e.label, description: groupLabel(e), icon: kind === "color" ? "agentPaintcan" : "symbolFile", keywords: e.id }));
}

export function themePaletteCommands(): { id: string; title: string; detail: string; run: () => void }[] {
  return [
    { id: "workbench.action.selectTheme", title: "Preferências: Tema de Cores", detail: "Preferências", run: () => openThemePicker("color") },
    { id: "workbench.action.selectIconTheme", title: "Preferências: Tema de Ícones de Arquivo", detail: "Preferências", run: () => openThemePicker("fileIcon") },
    { id: "workbench.action.selectProductIconTheme", title: "Preferências: Tema de Ícones do Produto", detail: "Preferências", run: () => openThemePicker("productIcon") },
  ];
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const snapshot = () => request;

export function ThemePickerHost() {
  const req = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!req) return null;
  const items = toItems(req.kind, req.extensionId);
  const current = themeRegistry.active(req.kind).id;
  const close = () => {
    set(null);
    void themeRegistry.restore(req.kind).catch(() => {});
  };
  if (!items.length) {
    return (
      <QuickPick
        title={TITLE[req.kind]}
        placeholder="Nenhum tema disponível"
        items={[{ id: "__none", label: "Esta extensão não tem temas aplicáveis (desabilitada ou bloqueada).", icon: "info" }]}
        onPick={() => set(null)}
        onClose={() => set(null)}
      />
    );
  }
  return (
    <QuickPick
      title={TITLE[req.kind]}
      placeholder="Selecione um tema (↑/↓ para pré-visualizar)"
      items={items}
      initialId={items.some((i) => i.id === current) ? current : undefined}
      onActiveChange={(it) => void themeRegistry.apply(req.kind, it.id, { preview: true }).catch(() => {})}
      onPick={(it) => {
        set(null);
        void themeRegistry.apply(req.kind, it.id).catch((err) => alert(`Não foi possível aplicar o tema:\n${err instanceof Error ? err.message : String(err)}`));
      }}
      onClose={close}
    />
  );
}
