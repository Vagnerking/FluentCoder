import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { QuickPick } from "../components/QuickPick";
import { QuickInput } from "../components/QuickInput";
import { extHost, extLog } from "./client";
import { ExtensionDiffDialog, type ExtDocumentView } from "./ExtensionDiffDialog";
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
  /** Abre um arquivo no editor (linha 1-based opcional). */
  onOpenFile: (path: string, line?: number) => void;
  /** Snapshot do editor ativo publicado como `activeTextEditor` às extensões. */
  readEditorState: () => EditorStatePayload;
}

interface PendingRequest {
  requestId: number;
  kind: string;
  params: Record<string, unknown>;
}

interface Tab {
  key: string;
  label: string;
  /** Extensão instalada (aba de view) ou painel criado pela extensão. */
  extensionId: string;
  viewIds?: string[];
  panel?: WebviewInfo;
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
 */
export function ExtensionDock({ rootPath, agentsNode, nativeTabs, requestedTab, onOpenFile, readEditorState }: Props) {
  const natives: NativeDockTab[] =
    nativeTabs ?? [{ key: AGENTS_TAB, label: "Agentes", node: agentsNode }];
  const defaultTab = natives[0]?.key ?? AGENTS_TAB;
  const [tab, setTab] = useState<string>(readTab);
  const [installed, setInstalled] = useState<InstalledExtension[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, WebviewInfo | { error: string } | "loading">>({});
  const [panels, setPanels] = useState<WebviewInfo[]>([]);
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [toast, setToast] = useState<{ severity: string; message: string } | null>(null);
  const [docView, setDocView] = useState<ExtDocumentView | null>(null);
  const readEditorRef = useRef(readEditorState);
  readEditorRef.current = readEditorState;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
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

  // Sobe o host (barato: só Node + servidor HTTP; nada é ativado ainda).
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

  // Eventos globais do host.
  useEffect(() => {
    return extHost.on((ev: HostEvent) => {
      switch (ev.event) {
        case "request":
          setRequest(ev as unknown as PendingRequest);
          break;
        case "openFile": {
          const e = ev as { path: string; selection?: { start: { line: number } } };
          onOpenFileRef.current(e.path, e.selection ? e.selection.start.line + 1 : undefined);
          break;
        }
        case "diff": {
          const e = ev as unknown as Extract<HostEvent, { event: "diff" }>;
          setDocView({ kind: "diff", title: e.title, left: e.left, right: e.right });
          break;
        }
        case "closeDiff":
          setDocView((d) => (d && d.kind === "diff" ? null : d));
          break;
        case "openVirtualDocument": {
          const e = ev as unknown as Extract<HostEvent, { event: "openVirtualDocument" }>;
          setDocView({ kind: "document", title: e.title, content: e.content, path: e.uri });
          break;
        }
        case "openExternal":
          void invoke("ext_host_open_external", { url: (ev as { url: string }).url }).catch((err) =>
            setToast({ severity: "error", message: String(err) }),
          );
          break;
        case "clipboardWrite":
          void navigator.clipboard?.writeText((ev as { text: string }).text).catch(() => {});
          break;
        case "webviewPanelCreated": {
          const info = ev as unknown as WebviewInfo;
          setPanels((p) => (p.some((x) => x.handle === info.handle) ? p : [...p, info]));
          selectTab(`panel:${info.handle}`);
          break;
        }
        case "webviewHtml": {
          const info = ev as unknown as WebviewInfo;
          setPanels((p) => p.map((x) => (x.handle === info.handle ? { ...x, url: info.url } : x)));
          break;
        }
        case "webviewTitle": {
          const e = ev as { handle: string; title: string };
          setPanels((p) => p.map((x) => (x.handle === e.handle ? { ...x, title: e.title } : x)));
          break;
        }
        case "webviewDisposed": {
          const h = (ev as { handle: string }).handle;
          setPanels((p) => p.filter((x) => x.handle !== h));
          break;
        }
        case "revealView": {
          const viewId = (ev as { viewId?: string }).viewId;
          const owner = viewId && installed.find((e) => e.viewIds.includes(viewId));
          if (owner) selectTab(owner.id);
          break;
        }
        case "hostExit":
          setHostError("O host de extensões foi encerrado.");
          requestedRef.current.clear();
          setViews({});
          setPanels([]);
          break;
        default:
          break;
      }
    });
  }, [installed, selectTab]);

  // Resolve a view da aba selecionada (ativa a extensão na 1ª vez).
  useEffect(() => {
    const ext = installed.find((e) => e.id === tab);
    if (!ext || requestedRef.current.has(ext.id)) return;
    requestedRef.current.add(ext.id);
    setViews((v) => ({ ...v, [ext.id]: "loading" }));
    (async () => {
      const loaded = await extHost.loadExtension(ext.id);
      const viewId = ext.viewIds.find((id) => loaded.views.some((v) => v.id === id)) ?? loaded.views[0]?.id;
      if (!viewId) throw new Error("A extensão não contribui nenhuma view de webview.");
      const info = await extHost.resolveView(viewId);
      setViews((v) => ({ ...v, [ext.id]: info }));
    })().catch((err) => {
      requestedRef.current.delete(ext.id);
      setViews((v) => ({ ...v, [ext.id]: { error: String(err instanceof Error ? err.message : err) } }));
    });
  }, [tab, installed]);

  // Publica o editor ativo (arquivo + seleção) enquanto o host roda.
  useEffect(() => {
    let last = "";
    const t = window.setInterval(() => {
      if (!extHost.running) return;
      const state = readEditorRef.current();
      const key = JSON.stringify(state);
      if (key === last) return;
      last = key;
      extHost.publishEditorState(state);
    }, 400);
    return () => window.clearInterval(t);
  }, []);

  const respond = (result: unknown) => {
    if (!request) return;
    void extHost.notify("respond", { requestId: request.requestId, result });
    setRequest(null);
  };

  // Diálogos de arquivo vão direto ao plugin de diálogo do Tauri.
  useEffect(() => {
    if (!request || (request.kind !== "openDialog" && request.kind !== "saveDialog")) return;
    const p = request.params;
    const done = (result: unknown) => {
      void extHost.notify("respond", { requestId: request.requestId, result });
      setRequest(null);
    };
    if (request.kind === "openDialog") {
      openDialog({ directory: !!p.canSelectFolders, multiple: !!p.canSelectMany, title: p.title as string | undefined })
        .then((r) => done({ paths: r == null ? [] : Array.isArray(r) ? r : [r] }))
        .catch(() => done({ paths: [] }));
    } else {
      saveDialog({ title: p.title as string | undefined, defaultPath: p.defaultPath as string | undefined })
        .then((r) => done({ path: r ?? null }))
        .catch(() => done({ path: null }));
    }
  }, [request]);

  // Mensagens sem botões não bloqueiam: viram aviso e respondem na hora.
  useEffect(() => {
    if (!request || request.kind !== "showMessage") return;
    const items = (request.params.items as string[]) ?? [];
    if (items.length === 0 && !request.params.modal) {
      setToast({ severity: String(request.params.severity), message: String(request.params.message) });
      void extHost.notify("respond", { requestId: request.requestId, result: null });
      setRequest(null);
    }
  }, [request]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const tabs: Tab[] = [
    ...installed.map((e) => ({ key: e.id, label: e.label, extensionId: e.id, viewIds: e.viewIds })),
    ...panels.map((p) => ({ key: `panel:${p.handle}`, label: p.title || p.viewType, extensionId: p.extensionId, panel: p })),
  ];
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
              <button
                role="tab"
                aria-selected={activeTab === t.key}
                className={`ext-dock-tab${activeTab === t.key ? " active" : ""}`}
                title={t.panel ? t.label : `${t.label} — extensão do VS Code instalada`}
                onClick={() => selectTab(t.key)}
              >
                {t.label}
              </button>
              {t.panel && (
                <button
                  className="ext-dock-tab-close"
                  aria-label={`Fechar ${t.label}`}
                  onClick={() => {
                    void extHost.notify("disposeWebview", { handle: t.panel!.handle });
                    setPanels((p) => p.filter((x) => x.handle !== t.panel!.handle));
                    if (activeTab === t.key) selectTab(t.extensionId);
                  }}
                >
                  ×
                </button>
              )}
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
          const state = t.panel ?? views[t.extensionId];
          // Só monta depois de aberta (e mantém montada: retainContextWhenHidden).
          if (!state) return null;
          return (
            <div key={t.key} className="ext-dock-pane" hidden={!isActive}>
              {state === "loading" ? (
                <div className="ext-webview-status">Iniciando {t.label}…</div>
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
            <button className="ext-dock-retry" onClick={start}>
              Tentar novamente
            </button>
          </div>
        )}
        {toast && (
          <div className={`ext-dock-toast ${toast.severity}`} role="status" onClick={() => setToast(null)}>
            {toast.message}
          </div>
        )}
      </div>

      {request?.kind === "showMessage" && ((request.params.items as string[])?.length > 0 || !!request.params.modal) && (
        <ConfirmDialog<number>
          title={request.params.severity === "error" ? "Erro" : request.params.severity === "warning" ? "Aviso" : "Informação"}
          message={[request.params.message, request.params.detail].filter(Boolean).join("\n\n")}
          buttons={[
            ...((request.params.items as string[]) ?? []).map((label, index) => ({
              label,
              variant: (index === 0 ? "primary" : "secondary") as "primary" | "secondary",
              value: index,
              default: index === 0,
            })),
            { label: "Fechar", variant: "secondary" as const, value: -1 },
          ]}
          onChoice={(v) => respond({ index: v ?? -1 })}
        />
      )}
      {request?.kind === "quickPick" && (
        <QuickPick
          title={(request.params.title as string) || undefined}
          placeholder={(request.params.placeHolder as string) || "Selecione uma opção"}
          items={((request.params.items as { label: string; description?: string; detail?: string }[]) ?? []).map((it, i) => ({
            id: String(i),
            label: it.label,
            description: it.description,
            detail: it.detail,
          }))}
          onPick={(item) => respond({ index: Number(item.id) })}
          onClose={() => respond(null)}
        />
      )}
      {request?.kind === "inputBox" && (
        <QuickInput
          title={(request.params.title as string) || undefined}
          placeholder={(request.params.placeHolder as string) || undefined}
          prompt={(request.params.prompt as string) || undefined}
          password={!!request.params.password}
          onSubmit={(value) => respond({ value })}
          onClose={() => respond(null)}
        />
      )}
      {docView && <ExtensionDiffDialog view={docView} onClose={() => setDocView(null)} />}
    </div>
  );
}
