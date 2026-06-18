import { useEffect, useRef, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { LspManager, lspLanguageIds } from "./manager";
import { serverIdForLanguage } from "./servers";
import type { LspWorkspaceInfo } from "./servers";

export type LspStatus = "starting" | "downloading" | "ready" | "error";

/** Per-server status plus the last error message (for the StatusBar tooltip). */
export interface LspManagerState {
  status: Map<string, LspStatus>;
  errors: Map<string, string>;
  workspaces: Map<string, LspWorkspaceInfo>;
}

/** Payload of the Tauri `lsp-download-progress` event (emitted by ISSUE-26). */
interface DownloadProgress {
  server: string;
  state: "downloading" | "extracting" | "ready" | "error";
  message?: string;
}

/**
 * Drives the {@link LspManager} from React state.
 *
 * - When `rootPath` changes, every previous client is stopped and servers for
 *   the currently-open languages are (re)started.
 * - When a new language with a registered server appears in `openedLanguages`,
 *   its server is started if not already running.
 * - Never restarts a server on keystrokes — only on workspace / language changes.
 *
 * Returns `{ status, errors, restart }` for the StatusBar (ISSUE-28).
 */
export function useLspManager(
  rootPath: string | null,
  openedLanguages: Set<string>
) {
  const managerRef = useRef<LspManager | null>(null);
  if (managerRef.current === null) {
    managerRef.current = new LspManager();
  }
  const manager = managerRef.current;

  const [state, setState] = useState<LspManagerState>({
    status: new Map(),
    errors: new Map(),
    workspaces: new Map(),
  });

  const setStatus = useCallback((serverId: string, status: LspStatus, error?: string) => {
    setState((prev) => {
      const nextStatus = new Map(prev.status);
      const nextErrors = new Map(prev.errors);
      nextStatus.set(serverId, status);
      if (error) nextErrors.set(serverId, error);
      else if (status === "ready") nextErrors.delete(serverId);
      return { ...prev, status: nextStatus, errors: nextErrors };
    });
  }, []);

  const setWorkspaceInfo = useCallback((info: LspWorkspaceInfo) => {
    setState((prev) => {
      const workspaces = new Map(prev.workspaces);
      workspaces.set(info.serverId, info);
      return { ...prev, workspaces };
    });
  }, []);

  const startLanguage = useCallback(
    async (language: string, root: string) => {
      // Several languages can map to one server (e.g. the four TS/JS dialects
      // share the "typescript" server), so resolve the real server id.
      const entry = serverIdForLanguage(language);
      if (!entry) return;
      const serverId = entry.serverId;
      if (manager.isActive(serverId)) return;
      setStatus(serverId, "starting");
      try {
        await manager.start(language, root, setWorkspaceInfo);
        setStatus(serverId, "ready");
      } catch (err) {
        setStatus(serverId, "error", err instanceof Error ? err.message : String(err));
      }
    },
    [manager, setStatus, setWorkspaceInfo]
  );

  // Listen for backend download-progress events and reflect them in the status.
  useEffect(() => {
    const unlisten = listen<DownloadProgress>("lsp-download-progress", (event) => {
      const { server, state: s, message } = event.payload;
      if (s === "downloading" || s === "extracting") setStatus(server, "downloading");
      else if (s === "error") setStatus(server, "error", message);
      // "ready" from download is not "server ready"; the start flow sets that.
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [setStatus]);

  // The workspace this hook last started servers for. Used to tear down only on
  // a REAL workspace change — not on every effect re-run. A cleanup-only effect
  // here would fire during React StrictMode's mount→cleanup→remount cycle and
  // kill the just-started LSP session (the "connect then immediately disconnect"
  // bug), so teardown is driven by comparing this ref instead.
  const lastRootRef = useRef<string | null>(null);

  // React to workspace + opened-languages changes.
  useEffect(() => {
    // Workspace actually changed (e.g. opened a different folder): tear the old
    // servers down before starting the new ones. On the initial mount and on
    // StrictMode's re-invoke, lastRootRef already equals rootPath, so we do NOT
    // stop the session we just started.
    if (lastRootRef.current !== null && lastRootRef.current !== rootPath) {
      void manager.stopAll();
    }
    lastRootRef.current = rootPath;

    if (!rootPath) {
      setState({
        status: new Map(),
        errors: new Map(),
        workspaces: new Map(),
      });
      return;
    }

    const supported = new Set(lspLanguageIds());
    const toStart = [...openedLanguages].filter((l) => supported.has(l));
    for (const lang of toStart) {
      void startLanguage(lang, rootPath);
    }
    // Servers for languages that left the tab set stay warm until the workspace
    // changes (handled above).
  }, [rootPath, openedLanguages, manager, startLanguage]);

  // Best-effort teardown on window close.
  useEffect(() => {
    const onUnload = () => {
      void manager.stopAll();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [manager]);

  /** Re-attempts starting a failed server (used by the StatusBar error action). */
  const restart = useCallback(
    async (serverId: string) => {
      if (!rootPath) return;
      await manager.stop(serverId);
      await startLanguage(serverId, rootPath);
    },
    [manager, rootPath, startLanguage]
  );

  return {
    status: state.status,
    errors: state.errors,
    workspaces: state.workspaces,
    restart,
  };
}
