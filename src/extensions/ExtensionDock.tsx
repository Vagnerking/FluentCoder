import { Tooltip } from "../components/Tooltip";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { extHost, extLog } from "./client";
import { ExtensionWebview } from "./ExtensionWebview";
import type { EditorStatePayload, HostEvent, InstalledExtension, WebviewInfo } from "./protocol";

const TAB_KEY = "ui.agentsDockTab";
const AGENTS_TAB = "agents";

/** Aba nativa do app no topo da sidebar (ex.: "Chat", "Agentes" do Fluent Chat). */
export interface NativeDockTab {
  key: string;
  label: string;
  node: ReactNode;
}

interface Props {
  rootPath: string | null;
  /** Conteúdo nativo da aba "Agentes" (legado; use `nativeTabs`). */
  agentsNode?: ReactNode;
  /** Abas nativas, antes das abas das extensões. A primeira é a padrão. */
  nativeTabs?: NativeDockTab[];
  /** Pedido externo para focar uma aba (ex.: Paleta → "Gerenciar agentes"). */
  requestedTab?: { key: string; nonce: number } | null;
  /**
   * @deprecated Abrir arquivos agora é do `ExtensionHostRuntime` (global).
   * Mantido para estabilidade da API do componente.
   */
  onOpenFile?: (path: string, line?: number) => void;
  /**
   * @deprecated O editor é espelhado por eventos do Monaco (editorBridge), sem
   * snapshot/polling. Mantido para estabilidade da API do componente.
   */
  readEditorState?: () => EditorStatePayload;
}

interface Tab {
  key: string;
  label: string;
  /** Extensão instalada (aba da view de sidebar dela). */
  extensionId: string;
  viewIds?: string[];
}

function readTab(): string {
  try {
    return localStorage.getItem(TAB_KEY) || AGENTS_TAB;
  } catch {
    return AGENTS_TAB;
  }
}

/**
 * Sidebar secundária com abas: "Agentes" (chat nativo) + a UI REAL das
 * extensões VS Code instaladas (Claude Code, Codex), hospedadas pelo
 * mini extension host (`tools/ext-host`). Ver docs/context/extensoes-vscode.md.
 *
 * Diálogos, diffs, terminais, editor e deep links ficam no
 * `ExtensionHostRuntime` (global): funcionam com a sidebar fechada.
 */
export function ExtensionDock({ rootPath, agentsNode, nativeTabs, requestedTab }: Props) {
  const natives: NativeDockTab[] =
    nativeTabs ?? [{ key: AGENTS_TAB, label: "Agentes", node: agentsNode }];
  const defaultTab = natives[0]?.key ?? AGENTS_TAB;
  const [tab, setTab] = useState<string>(readTab);
  const [installed, setInstalled] = useState<InstalledExtension[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, WebviewInfo | { error: string } | "loading">>({});
  // Dedupe síncrono (ref): o StrictMode roda os efeitos 2× antes do setState valer.
  const requestedRef = useRef(new Set<string>());

  const selectTab = useCallback((key: string) => {
    setTab(key);
    try {
      localStorage.setItem(TAB_KEY, key);
    } catch {
      /* ignora */
    }
  }, []);

  useEffect(() => {
    if (requestedTab) selectTab(requestedTab.key);
  }, [requestedTab, selectTab]);

  // Sobe o host (normalmente já está quente: o runtime o inicia no startup).
  const start = useCallback(() => {
    setHostError(null);
    extHost
      .ensureStarted(rootPath)
      .then((r) => setInstalled(r.extensions.filter((e) => e.supported)))
      .catch((err) => {
        extLog("host indisponível", err);
        setHostError(String(err instanceof Error ? err.message : err));
      });
  }, [rootPath]);
  useEffect(start, [start]);

  // Eventos de webview/painel do host.
  useEffect(() => {
    return extHost.on((ev: HostEvent) => {
      switch (ev.event) {
        case "revealView": {
          const viewId = (ev as { viewId?: string }).viewId;
          const owner = viewId && installed.find((e) => e.viewIds.includes(viewId));
          if (owner) selectTab(owner.id);
          break;
        }
        case "hostExit":
          setHostError("O host de extensões foi encerrado. Reiniciando…");
          requestedRef.current.clear();
          setViews({});
          break;
        case "hostRestarted":
          // As views voltam sozinhas (o efeito abaixo re-resolve a aba ativa).
          setHostError(null);
          requestedRef.current.clear();
          setViews({});
          start();
          break;
        default:
          break;
      }
    });
  }, [installed, selectTab, start]);

  // Resolve a view da aba selecionada (ativa a extensão na 1ª vez).
  useEffect(() => {
    const ext = installed.find((e) => e.id === tab);
    if (!ext || requestedRef.current.has(ext.id)) return;
    requestedRef.current.add(ext.id);
    setViews((v) => ({ ...v, [ext.id]: "loading" }));
    const t0 = performance.now();
    (async () => {
      const loaded = await extHost.loadExtension(ext.id);
      const viewId = ext.viewIds.find((id) => loaded.views.some((v) => v.id === id)) ?? loaded.views[0]?.id;
      if (!viewId) throw new Error("A extensão não contribui nenhuma view de webview.");
      const info = await extHost.resolveView(viewId);
      extHost.timings[`resolve:${ext.id}`] = Math.round(performance.now() - t0);
      setViews((v) => ({ ...v, [ext.id]: info }));
    })().catch((err) => {
      requestedRef.current.delete(ext.id);
      setViews((v) => ({ ...v, [ext.id]: { error: String(err instanceof Error ? err.message : err) } }));
    });
  }, [tab, installed]);

  // Painéis (`createWebviewPanel`/custom editors) abrem como abas da grade de
  // editores (webviewTabs.ts); aqui ficam só as views de sidebar.
  const tabs: Tab[] = installed.map((e) => ({ key: e.id, label: e.label, extensionId: e.id, viewIds: e.viewIds }));
  const isNative = (key: string) => natives.some((n) => n.key === key);
  const activeTab = isNative(tab) || tabs.some((t) => t.key === tab) ? tab : defaultTab;

  return (
    <div className="ext-dock">
      {(tabs.length > 0 || natives.length > 1) && (
        <div className="ext-dock-tabs" role="tablist" aria-label="Fluent Chat e extensões">
          {natives.map((n) => (
            <button
              key={n.key}
              role="tab"
              aria-selected={activeTab === n.key}
              className={`ext-dock-tab${activeTab === n.key ? " active" : ""}`}
              onClick={() => selectTab(n.key)}
            >
              {n.label}
            </button>
          ))}
          {tabs.map((t) => (
            <span key={t.key} className={`ext-dock-tab-wrap${activeTab === t.key ? " active" : ""}`}>
              <Tooltip label={`${t.label} — extensão do VS Code instalada`} placement="bottom">
              <button
                role="tab"
                aria-selected={activeTab === t.key}
                className={`ext-dock-tab${activeTab === t.key ? " active" : ""}`}
                // Ponteiro sobre a aba: ativa em segundo plano (o clique já encontra pronto).
                onPointerEnter={() => extHost.prewarm(t.extensionId)}
                onFocus={() => extHost.prewarm(t.extensionId)}
                onClick={() => selectTab(t.key)}
              >
                {t.label}
              </button>
              </Tooltip>
            </span>
          ))}
        </div>
      )}

      <div className="ext-dock-body">
        {natives.map((n) => (
          <div key={n.key} className="ext-dock-pane" hidden={activeTab !== n.key}>
            {n.node}
          </div>
        ))}
        {tabs.map((t) => {
          const isActive = activeTab === t.key;
          const state = views[t.extensionId];
          // Só monta depois de aberta (e mantém montada: retainContextWhenHidden).
          if (!state) return null;
          return (
            <div key={t.key} className="ext-dock-pane" hidden={!isActive}>
              {state === "loading" ? (
                <div className="ext-webview-status" role="status">
                  Iniciando {t.label}…
                </div>
              ) : "error" in state ? (
                <div className="ext-webview-status error" role="alert">
                  Não foi possível abrir {t.label}: {state.error}
                </div>
              ) : (
                <ExtensionWebview info={state} visible={isActive} />
              )}
            </div>
          );
        })}
        {hostError && !isNative(activeTab) && (
          <div className="ext-webview-status error" role="alert">
            {hostError}{" "}
            <button className="ext-dock-retry" onClick={() => void extHost.restart().catch(() => {})}>
              Tentar novamente
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
