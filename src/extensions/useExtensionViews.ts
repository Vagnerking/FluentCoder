import { useCallback, useEffect, useRef, useState } from "react";
import { extHost, extLog } from "./client";
import type { HostEvent, InstalledExtension, WebviewInfo } from "./protocol";
import { extensionViewId, viewRegistry } from "../workbench/viewRegistry";

export type ExtensionViewState = WebviewInfo | { error: string } | "loading";

export interface ExtensionViewsModel {
  /** Extensões liberadas no portão que contribuem view de webview. */
  installed: InstalledExtension[];
  /** Estado da view de cada extensão (ausente = ainda não aberta). */
  states: Record<string, ExtensionViewState>;
  /** Ativa a extensão e resolve a view preferida (1ª vez que fica visível). */
  ensureResolved: (extensionId: string) => void;
  hostError: string | null;
  retry: () => void;
  /** Extensão dona de um handle de webview de view (para `revealWebview`). */
  extensionOfHandle: (handle: string) => string | null;
}

/** Ordem padrão das views de extensão na sidebar secundária (depois do Fluent Chat). */
const EXT_ORDER_BASE = 10;

/**
 * Views de sidebar das extensões hospedadas como views INDEPENDENTES do
 * registro (`ext:<id>`): uma por extensão liberada que contribui webview,
 * padrão na sidebar secundária, cada uma movível para qualquer região.
 *
 * O ciclo de vida do webview (resolve → iframe → relay) não depende da região:
 * o handle fica aqui e o iframe numa camada fixa (`ExtensionWebviewLayer`), de
 * modo que mover a view nunca re-resolve nem recarrega a UI da extensão.
 * `revealView`/`revealWebview` do host chegam pelo `ExtensionHostRuntime`
 * (`revealExtensionView`). Contratos: docs/context/extensoes-vscode.md.
 */
export function useExtensionViews(rootPath: string | null): ExtensionViewsModel {
  const [installed, setInstalled] = useState<InstalledExtension[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, ExtensionViewState>>({});
  // Dedupe síncrono (ref): o StrictMode roda os efeitos 2× antes do setState valer.
  const requested = useRef(new Set<string>());
  const installedRef = useRef(installed);
  installedRef.current = installed;
  const statesRef = useRef(states);
  statesRef.current = states;

  const withViews = (list: InstalledExtension[]) => list.filter((e) => e.supported && e.viewIds.length > 0);

  // Sobe o host (normalmente já está quente: o runtime o inicia no startup).
  const start = useCallback(() => {
    setHostError(null);
    extHost
      .ensureStarted(rootPath)
      .then((r) => setInstalled(withViews(r.extensions)))
      .catch((err) => {
        extLog("host indisponível", err);
        setHostError(String(err instanceof Error ? err.message : err));
      });
  }, [rootPath]);
  useEffect(start, [start]);

  // Uma view no registro por extensão.
  useEffect(() => {
    const offs = installed.map((e, i) =>
      viewRegistry.register({
        id: extensionViewId(e.id),
        title: e.label,
        icon: e.icon ? { src: e.icon } : { codicon: "extensions" },
        defaultRegion: "secondarySidebar",
        defaultOrder: EXT_ORDER_BASE + i,
        retainWhenHidden: true,
        extensionId: e.id,
      }),
    );
    return () => offs.forEach((off) => off());
  }, [installed]);

  useEffect(
    () =>
      extHost.on((ev: HostEvent) => {
        switch (ev.event) {
          case "hostExit":
            setHostError("O host de extensões foi encerrado. Reiniciando…");
            requested.current.clear();
            setStates({});
            break;
          case "installedChanged":
            setInstalled(withViews(extHost.info?.extensions ?? []));
            break;
          case "hostRestarted":
            // As views visíveis voltam sozinhas (ensureResolved pelo ExtensionView).
            setHostError(null);
            requested.current.clear();
            setStates({});
            start();
            break;
          default:
            break;
        }
      }),
    [start],
  );

  const ensureResolved = useCallback((extensionId: string) => {
    const ext = installedRef.current.find((e) => e.id === extensionId);
    if (!ext || requested.current.has(ext.id)) return;
    requested.current.add(ext.id);
    setStates((v) => ({ ...v, [ext.id]: "loading" }));
    const t0 = performance.now();
    (async () => {
      const loaded = await extHost.loadExtension(ext.id);
      const viewId = ext.viewIds.find((id) => loaded.views.some((v) => v.id === id)) ?? loaded.views[0]?.id;
      if (!viewId) throw new Error("A extensão não contribui nenhuma view de webview.");
      const info = await extHost.resolveView(viewId);
      extHost.timings[`resolve:${ext.id}`] = Math.round(performance.now() - t0);
      setStates((v) => ({ ...v, [ext.id]: info }));
    })().catch((err) => {
      requested.current.delete(ext.id);
      setStates((v) => ({ ...v, [ext.id]: { error: String(err instanceof Error ? err.message : err) } }));
    });
  }, []);

  const extensionOfHandle = useCallback((handle: string) => {
    for (const [id, s] of Object.entries(statesRef.current)) {
      if (s !== "loading" && "handle" in s && s.handle === handle) return id;
    }
    return null;
  }, []);

  const retry = useCallback(() => void extHost.restart().catch(() => {}), []);

  return { installed, states, ensureResolved, hostError, retry, extensionOfHandle };
}
