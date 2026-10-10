/**
 * Runtime GLOBAL do host de extensões (montado uma vez no App, independente da
 * sidebar de agentes estar aberta):
 *
 * - **prewarm**: sobe o processo Node + servidor de recursos logo após o
 *   startup (ocioso); as extensões só ativam ao abrir a view (ou ao passar o
 *   ponteiro na aba — `extHost.prewarm`);
 * - **editor**: espelho Monaco ↔ `TextDocument`/`TextEditor` (editorBridge);
 * - **terminais**: `window.createTerminal` → terminal integrado (terminalBridge);
 * - **diffs**: `vscode.diff` → revisão do Monaco (ClaudeDiffReview, via diffs.ts);
 * - **pedidos de UI**: mensagens/quick pick/input/diálogos de arquivo;
 * - **saída**: output channels das extensões e log do host na aba "Saída";
 * - **barra de status**: `createStatusBarItem`/`setStatusBarMessage`/`withProgress`;
 * - **deep links** `fluent-coder://<extensão>/…` → `registerUriHandler`;
 * - **atalhos** contribuídos (best effort) e os vindos dos webviews.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { QuickPick } from "../components/QuickPick";
import { QuickInput } from "../components/QuickInput";
import { termWrite } from "../api";
import { appendOutput } from "../output/outputStore";
import { extHost, extLog, hostOutput } from "./client";
import { ExtensionDiffDialog, type ExtDocumentView } from "./ExtensionDiffDialog";
import { startEditorBridge, type EditorBridgeHost } from "./editorBridge";
import { configureTerminalBridge, handleTerminalEvent } from "./terminalBridge";
import { addExtDiff, clearExtDiffs, removeExtDiff } from "./diffs";
import { applyStatusBarItem, applyStatusMessage, clearStatusItems } from "./statusBar";
import { editorKeybindingListener, setContributedKeybindings } from "./keys";
import { themeColorVar } from "./editorModel";
import { readFluentThemeVars } from "./theme";
import type { ContributedKeybinding, ExtensionDiffEvent, HostEvent, InstalledExtension, PlainRange, StatusBarItemEvent } from "./protocol";

export interface ExtensionHostRuntimeProps {
  rootPath: string | null;
  /** Falso em janela remota (SSH): as extensões rodam localmente. */
  enabled?: boolean;
  /** Abas abertas (todas as grupos) — `window.tabGroups` das extensões. */
  files: { path: string; dirty: boolean }[];
  activePath: string | null;
  openFile(path: string, opts?: { selection?: PlainRange; preserveFocus?: boolean; preview?: boolean }): Promise<void> | void;
  bufferChanged(path: string, content: string): void;
  saveFile(path: string): Promise<boolean>;
  closeFile?(path: string): void;
  showTerminalPanel(): void;
  showOutput?(channel: string): void;
  revealInExplorer?(path: string): void;
  filesChanged?(paths: string[]): void;
  /** A extensão pediu para mostrar a view dela (`<view>.focus`): abrir a sidebar de agentes. */
  revealAgentsSidebar?(): void;
  /** Comandos do workbench pedidos pela extensão (`workbench.action.*`, terminal, formatar…). */
  appCommand?(command: string, args: unknown[]): void;
}

interface PendingRequest {
  requestId: number;
  kind: string;
  params: Record<string, unknown>;
}

const UI_REQUESTS = new Set(["showMessage", "quickPick", "inputBox", "openDialog", "saveDialog"]);
/** Espera após o startup antes de subir o Node (não disputa CPU com a UI). */
const PREWARM_DELAY_MS = 1200;

function resolveColor(c: StatusBarItemEvent["color"]): string | undefined {
  if (!c) return undefined;
  if (typeof c === "string") return /^[#\w(),.\s%-]+$/.test(c) ? c : undefined;
  return readFluentThemeVars()[themeColorVar(c.themeColor)];
}

export function ExtensionHostRuntime(props: ExtensionHostRuntimeProps) {
  const { rootPath, enabled = true } = props;
  const propsRef = useRef(props);
  propsRef.current = props;
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [toast, setToast] = useState<{ severity: string; message: string } | null>(null);
  const [docView, setDocView] = useState<ExtDocumentView | null>(null);
  const keybindingsRef = useRef<ContributedKeybinding[]>([]);

  // ---- prewarm: Node + servidor de recursos sobem com o app (ocioso).
  useEffect(() => {
    if (!enabled) return;
    const t = window.setTimeout(() => {
      void extHost
        .ensureStarted(rootPath)
        .then((r) => {
          const kbs = r.extensions.filter((e: InstalledExtension) => e.supported).flatMap((e) => e.keybindings ?? []);
          keybindingsRef.current = kbs;
          setContributedKeybindings(kbs);
        })
        .catch((err) => extLog("prewarm falhou", err));
    }, extHost.running ? 0 : PREWARM_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [enabled, rootPath]);

  // ---- editor (eventos do Monaco) e terminais.
  const bridgeRef = useRef<ReturnType<typeof startEditorBridge> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const hostRef: { current: EditorBridgeHost } = {
      get current(): EditorBridgeHost {
        const p = propsRef.current;
        return {
          getTabs: () => p.files.map((f) => ({ path: f.path, dirty: f.dirty, active: f.path === p.activePath })),
          openFile: (path, opts) => p.openFile(path, opts),
          bufferChanged: (path, content) => p.bufferChanged(path, content),
          saveFile: (path) => p.saveFile(path),
          closeFile: (path) => p.closeFile?.(path),
        };
      },
    };
    const bridge = startEditorBridge(hostRef);
    bridgeRef.current = bridge;
    configureTerminalBridge({
      write: (ptyId, data) => void termWrite(ptyId, data).catch((err) => extLog("termWrite falhou", err)),
      notify: (method, params) => void extHost.notify(method, params),
    });
    return () => {
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [enabled]);

  const tabsKey = JSON.stringify([props.files.map((f) => [f.path, f.dirty]), props.activePath]);
  useEffect(() => {
    bridgeRef.current?.tabsChanged();
  }, [tabsKey]);

  // ---- atalhos contribuídos digitados no editor (Alt+K do Claude Code etc.).
  useEffect(() => {
    if (!enabled) return;
    const onKey = editorKeybindingListener(() => keybindingsRef.current);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);

  // ---- eventos globais do host.
  useEffect(() => {
    if (!enabled) return;
    return extHost.on((ev: HostEvent) => {
      const p = propsRef.current;
      if (handleTerminalEvent(ev, () => p.showTerminalPanel())) return;
      switch (ev.event) {
        case "request": {
          const r = ev as unknown as PendingRequest;
          if (UI_REQUESTS.has(r.kind)) setRequest(r);
          break;
        }
        case "openFile": {
          const e = ev as { path: string; selection?: PlainRange; preserveFocus?: boolean; preview?: boolean };
          void p.openFile(e.path, { selection: e.selection, preserveFocus: e.preserveFocus, preview: e.preview });
          break;
        }
        case "openVirtualDocument": {
          const e = ev as { uri: string; title: string; content: string };
          setDocView({ kind: "document", title: e.title, content: e.content, path: e.uri });
          break;
        }
        case "diff":
          addExtDiff(ev as ExtensionDiffEvent);
          break;
        case "closeDiff":
          removeExtDiff((ev as { diffId: string }).diffId);
          break;
        case "openExternal":
          void invoke("ext_host_open_external", { url: (ev as { url: string }).url }).catch((err) =>
            setToast({ severity: "error", message: String(err) }),
          );
          break;
        case "clipboardWrite":
          void navigator.clipboard?.writeText((ev as { text: string }).text).catch(() => {});
          break;
        case "output": {
          const e = ev as { channel: string; text: string };
          appendOutput(e.channel, e.text.replace(/\n$/, ""));
          break;
        }
        case "outputShow":
          p.showOutput?.((ev as { channel: string }).channel);
          break;
        case "statusBarItem":
          applyStatusBarItem(ev as StatusBarItemEvent, resolveColor);
          break;
        case "statusMessage":
          applyStatusMessage(ev as { id: string; extensionId: string; text: string | null; progress?: boolean });
          break;
        case "filesChanged":
          p.filesChanged?.((ev as { paths: string[] }).paths);
          break;
        case "revealInExplorer":
          p.revealInExplorer?.((ev as unknown as { path: string }).path);
          break;
        case "revealView": {
          // Sidebar fechada: o dock monta já na aba da extensão (lê ui.agentsDockTab).
          const viewId = (ev as { viewId?: string }).viewId;
          const owner = viewId ? extHost.info?.extensions.find((e) => e.viewIds.includes(viewId)) : undefined;
          if (owner) {
            try {
              localStorage.setItem("ui.agentsDockTab", owner.id);
            } catch {
              /* ignora */
            }
          }
          p.revealAgentsSidebar?.();
          break;
        }
        case "revealWebview":
          p.revealAgentsSidebar?.();
          break;
        case "appCommand": {
          const e = ev as { command: string; args: unknown[] };
          p.appCommand?.(e.command, e.args ?? []);
          break;
        }
        case "extensionLoaded":
        case "extensionActivated": {
          const ext = (ev as { extension: { keybindings?: ContributedKeybinding[] } }).extension;
          if (ext.keybindings?.length) {
            const merged = [...keybindingsRef.current, ...ext.keybindings.filter((k) => !keybindingsRef.current.some((x) => x.command === k.command && x.key === k.key))];
            keybindingsRef.current = merged;
            setContributedKeybindings(merged);
          }
          break;
        }
        case "hostExit":
          clearExtDiffs();
          clearStatusItems();
          setRequest(null);
          break;
        default:
          break;
      }
    });
  }, [enabled]);

  // ---- deep links fluent-coder://<extensão>/… (Rust: ext_host/deep_link.rs).
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    // O mesmo link pode chegar pelo evento E pela fila (corrida no startup).
    const recent = new Map<string, number>();
    const handle = async (url: string) => {
      const last = recent.get(url);
      if (last !== undefined && Date.now() - last < 3000) return;
      recent.set(url, Date.now());
      try {
        await extHost.ensureStarted(propsRef.current.rootPath);
        const ok = await extHost.call("handleUri", { uri: url });
        hostOutput(ok ? `Link aberto: ${url.split("?")[0]}` : `Nenhuma extensão tratou o link ${url.split("?")[0]}`);
      } catch (err) {
        hostOutput(`Falha ao abrir o link ${url.split("?")[0]}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        void invoke("deep_link_ack", { url }).catch(() => {});
      }
    };
    const un = listen<string>("deep-link://open", (e) => alive && void handle(e.payload));
    // Links que chegaram antes de montar (app aberto pelo próprio link).
    void invoke<string[]>("deep_link_take_pending")
      .then((urls) => urls.forEach((u) => alive && void handle(u)))
      .catch(() => {});
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, [enabled]);

  // ---- pedidos de UI.
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

  if (!enabled) return null;
  return (
    <>
      {toast && (
        <div className={`ext-dock-toast ext-runtime-toast ${toast.severity}`} role="status" onClick={() => setToast(null)}>
          {toast.message}
        </div>
      )}
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
    </>
  );
}
