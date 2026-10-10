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
 * - **comentários**: `vscode.comments` → widgets no Monaco (comments.ts +
 *   commentWidgets.tsx; ex.: barra Aceitar/Rejeitar por hunk do Claude Code);
 * - **pedidos de UI**: mensagens/diálogos de arquivo; QuickPick/InputBox
 *   completos pelo evento `quickInput` (ExtQuickInput.tsx);
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
import { termWrite } from "../api";
import { appendOutput } from "../output/outputStore";
import { extHost, extLog, hostOutput } from "./client";
import { ExtensionDiffDialog, type ExtDocumentView } from "./ExtensionDiffDialog";
import { startEditorBridge, type EditorBridgeHost } from "./editorBridge";
import { configureTerminalBridge, feedPtyData, handleTerminalEvent } from "./terminalBridge";
import { addExtDiff, clearExtDiffs, removeExtDiff } from "./diffs";
import { ExtQuickInput } from "./ExtQuickInput";
import {
  clearWebviewPanels,
  hasWebviewPanel,
  isWebviewTabPath,
  patchWebviewPanel,
  removeWebviewPanel,
  upsertWebviewPanel,
  webviewTabPath,
} from "./webviewTabs";
import { loadPersistedPanels, restoreOrder, savePersistedPanels } from "./panelRestore";
import { hideQuickInput, setQuickInput, type QuickInputState } from "./quickInputModel";
import { clearCommentThreads, removeCommentThread, upsertCommentThread, type CommentThreadInfo } from "./comments";
import { applyProgressItem, applyStatusBarItem, applyStatusMessage, clearStatusItems } from "./statusBar";
import { clearProgress, endProgress, progressFromEvent, progressLabel, upsertProgress } from "./progress";
import { ExtProgressToasts } from "./ExtProgressToasts";
import { editorKeybindingListener, setContributedKeybindings } from "./keys";
import { themeColorVar } from "./editorModel";
import { readFluentThemeVars } from "./theme";
import type { ContributedKeybinding, ExtensionDiffEvent, HostEvent, InstalledExtension, PlainRange, StatusBarItemEvent, WebviewInfo } from "./protocol";

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
  /**
   * Painéis de webview (`createWebviewPanel`/custom editors) como abas da
   * grade de editores: abrir (na coluna pedida), focar, renomear e fechar a
   * aba `extwebview:<handle>` (ver webviewTabs.ts).
   */
  openWebviewTab?(tab: { path: string; title: string; viewColumn?: number; preserveFocus?: boolean }): void;
  revealWebviewTab?(path: string, opts: { viewColumn?: number; preserveFocus?: boolean }): void;
  retitleWebviewTab?(path: string, title: string): void;
  closeWebviewTab?(path: string): void;
}

interface PendingRequest {
  requestId: number;
  kind: string;
  params: Record<string, unknown>;
}

const UI_REQUESTS = new Set(["showMessage", "openDialog", "saveDialog"]);
/** Extensão que traz a própria ponte IDE do `claude` (lock em ~/.claude/ide). */
const CLAUDE_CODE_EXTENSION = "anthropic.claude-code";
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
          // Só arquivos: abas sintéticas (painéis de webview, grafo) não são documentos.
          getTabs: () =>
            p.files
              .filter((f) => !isWebviewTabPath(f.path) && !/^[a-z][\w+.-]*:\/\//i.test(f.path))
              .map((f) => ({ path: f.path, dirty: f.dirty, active: f.path === p.activePath })),
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
    // Saída dos PTYs das extensões → shell integration (OSC 633).
    const unData = listen<{ id: string; data: string }>("term-data", (e) => {
      if (e.payload.id.startsWith("ext-")) feedPtyData(e.payload.id, e.payload.data);
    });
    return () => {
      bridge.dispose();
      bridgeRef.current = null;
      void unData.then((f) => f());
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
        case "quickInput":
          setQuickInput(ev as unknown as QuickInputState);
          break;
        case "quickInputHide":
          hideQuickInput((ev as { id: string }).id);
          break;
        case "commentThread":
          upsertCommentThread(ev as unknown as CommentThreadInfo);
          break;
        case "commentThreadDisposed":
          removeCommentThread((ev as { handle: string }).handle);
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
        case "progress": {
          const pr = progressFromEvent(ev as Record<string, unknown>);
          if (!pr) break;
          upsertProgress(pr);
          if (pr.location !== "notification") applyProgressItem({ id: pr.id, extensionId: pr.extensionId, label: progressLabel(pr), cancellable: pr.cancellable });
          break;
        }
        case "progressEnd": {
          const id = String((ev as { id?: unknown }).id);
          endProgress(id);
          applyProgressItem({ id, end: true });
          break;
        }
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
        case "webviewPanelCreated": {
          const info = ev as unknown as WebviewInfo;
          upsertWebviewPanel(info);
          p.openWebviewTab?.({ path: webviewTabPath(info.handle), title: info.title || info.viewType, viewColumn: info.viewColumn, preserveFocus: info.preserveFocus });
          break;
        }
        case "webviewPanels":
          // Lista persistível dos painéis (serializer/custom editor) por workspace.
          savePersistedPanels(p.rootPath, (ev as { panels: unknown }).panels);
          break;
        case "hostReady": {
          // Host novo (startup ou reinício): os painéis da sessão anterior voltam.
          const panels = restoreOrder(loadPersistedPanels(p.rootPath));
          if (panels.length === 0) break;
          void extHost
            .call("restoreWebviewPanels", { panels })
            .then((r) => {
              const n = (r as { restored?: number } | null)?.restored ?? 0;
              if (n > 0) hostOutput(`${n} painel(is) de extensão restaurado(s) da sessão anterior.`);
            })
            .catch((err) => extLog("restaurar painéis falhou", err));
          break;
        }
        case "webviewHtml": {
          const info = ev as unknown as WebviewInfo;
          patchWebviewPanel(info.handle, { url: info.url });
          break;
        }
        case "webviewTitle": {
          const e = ev as { handle: string; title: string };
          patchWebviewPanel(e.handle, { title: e.title });
          if (hasWebviewPanel(e.handle)) p.retitleWebviewTab?.(webviewTabPath(e.handle), e.title);
          break;
        }
        case "webviewDisposed": {
          const h = (ev as { handle: string }).handle;
          if (removeWebviewPanel(h)) p.closeWebviewTab?.(webviewTabPath(h));
          break;
        }
        case "revealWebview": {
          const e = ev as { handle: string; preserveFocus: boolean; viewColumn?: number };
          // Painel = aba do editor; view de sidebar = abre o Fluent Chat.
          if (hasWebviewPanel(e.handle)) p.revealWebviewTab?.(webviewTabPath(e.handle), { viewColumn: e.viewColumn, preserveFocus: e.preserveFocus });
          else p.revealAgentsSidebar?.();
          break;
        }
        case "appCommand": {
          const e = ev as { command: string; args: unknown[] };
          p.appCommand?.(e.command, e.args ?? []);
          break;
        }
        case "extensionLoaded":
        case "extensionActivated": {
          const ext = (ev as { extension: { id?: string; keybindings?: ContributedKeybinding[] } }).extension;
          // A extensão Claude Code publica o próprio lock "Fluent Coder" em
          // ~/.claude/ide: a ponte nativa sai de cena para o `/ide` não listar
          // duas entradas (volta quando o host cai — ver `hostExit`).
          if (ev.event === "extensionActivated" && ext.id === CLAUDE_CODE_EXTENSION) {
            void invoke("ide_bridge_set_advertised", { advertised: false }).catch(() => {});
          }
          if (ext.keybindings?.length) {
            const merged = [...keybindingsRef.current, ...ext.keybindings.filter((k) => !keybindingsRef.current.some((x) => x.command === k.command && x.key === k.key))];
            keybindingsRef.current = merged;
            setContributedKeybindings(merged);
          }
          break;
        }
        case "hostExit":
          void invoke("ide_bridge_set_advertised", { advertised: true }).catch(() => {});
          clearExtDiffs();
          clearCommentThreads();
          setQuickInput(null);
          // O host caiu: os painéis morreram com ele (as abas fecham).
          for (const h of clearWebviewPanels()) p.closeWebviewTab?.(webviewTabPath(h));
          clearStatusItems();
          clearProgress();
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
      <ExtProgressToasts message={toast} onDismissMessage={() => setToast(null)} />
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
      <ExtQuickInput />
      {docView && <ExtensionDiffDialog view={docView} onClose={() => setDocView(null)} />}
    </>
  );
}
