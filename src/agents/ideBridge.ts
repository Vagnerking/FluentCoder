/**
 * Lado frontend da ponte IDE do Claude Code (backend em
 * `src-tauri/src/agents/ide_bridge.rs`, decisão no ADR 0006).
 *
 * - **Publica** o estado do editor para o backend (`ide_bridge_update`):
 *   pastas do workspace, abas abertas (com dirty), seleção do editor com foco
 *   (debounce de 150ms — vira a notificação `selection_changed` do CLI) e
 *   diagnósticos dos markers do Monaco (debounce de 300ms).
 * - **Atende** as ferramentas que exigem UI (`ide-bridge://request`):
 *   `openDiff` entra na fila de revisão (o `ClaudeDiffReview` mostra o diff e o
 *   usuário decide), `openFile` e `saveDocument` delegam ao `App`.
 *
 * Linhas/colunas seguem o protocolo (0-based) — conversões puras em
 * `ideBridgeModel.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as monaco from "monaco-editor";
import { whenMonacoReady } from "../monaco-loader";
import { readFile, writeFile } from "../api";
import type { Eol } from "../types";
import { fromFileUri, toFileUri } from "../lsp/uri";
import { languageForFile } from "../language";
import {
  diffAcceptedResult,
  diffRejectedResult,
  errorResult,
  filesToIdeTabs,
  findTextRange,
  markersToDiagnostics,
  parseOpenDiffArgs,
  saveDocumentResult,
  textResult,
  toIdeSelection,
  type IdeBridgeRequest,
  type IdeSelection,
  type MonacoRange,
  type ToolResult,
} from "./ideBridgeModel";

const SELECTION_DEBOUNCE_MS = 150;
const DIAGNOSTICS_DEBOUNCE_MS = 300;

/** Uma alteração proposta pelo Claude aguardando Aceitar/Rejeitar. */
export interface PendingDiff {
  id: string;
  tabName: string;
  oldPath: string;
  newPath: string;
  /** Conteúdo atual em disco (vazio para arquivo novo). */
  original: string;
  proposed: string;
  isNewFile: boolean;
  encoding?: string;
  eol?: Eol;
  bom?: boolean;
  /** Falha ao gravar no Aceitar — mantém o diff aberto com o erro. */
  error?: string;
}

/** O que o `App` oferece à ponte. */
export interface IdeBridgeHost {
  /** Falso em janela remota (SSH): o CLI local não enxerga esses caminhos. */
  enabled: boolean;
  workspaceFolders: string[];
  files: { path: string; name: string; dirty: boolean }[];
  activePath: string | null;
  /** Abre/foca o arquivo, opcionalmente selecionando a faixa (1-based). */
  openFile: (path: string, range: MonacoRange | null) => Promise<boolean>;
  /** Salva a aba aberta do arquivo; lança em caso de falha. */
  saveFile: (path: string) => Promise<void>;
  /** O Aceitar gravou o arquivo: atualiza abas abertas dele. */
  fileWritten: (path: string, content: string) => void;
}

function update(patch: Record<string, unknown>) {
  return invoke("ide_bridge_update", { patch }).catch(() => {});
}

function respond(id: string, result: ToolResult) {
  return invoke("ide_bridge_respond", { id, result }).catch(() => {});
}

/** Seleção do editor de texto (`file://`) com foco mais recente. */
function currentSelection(ed: monaco.editor.ICodeEditor | null): IdeSelection | null {
  const model = ed?.getModel();
  const sel = ed?.getSelection();
  if (!ed || !model || !sel || model.uri.scheme !== "file") return null;
  return toIdeSelection(fromFileUri(model.uri.toString()), model.getValueInRange(sel), sel);
}

/** Acompanha foco/seleção de todos os editores e os markers do Monaco. */
function trackMonaco(enabledRef: { current: boolean }): () => void {
  let disposed = false;
  let lastEditor: monaco.editor.ICodeEditor | null = null;
  let selTimer: number | undefined;
  let diagTimer: number | undefined;
  const subs: monaco.IDisposable[] = [];

  const pushSelection = () => {
    window.clearTimeout(selTimer);
    selTimer = window.setTimeout(() => {
      if (!disposed && enabledRef.current) void update({ selection: currentSelection(lastEditor) });
    }, SELECTION_DEBOUNCE_MS);
  };
  const pushDiagnostics = () => {
    window.clearTimeout(diagTimer);
    diagTimer = window.setTimeout(() => {
      if (disposed || !enabledRef.current) return;
      const markers = monaco.editor
        .getModelMarkers({})
        .filter((m) => m.resource.scheme === "file")
        .map((m) => {
          const path = fromFileUri(m.resource.toString());
          return { ...m, path, uri: toFileUri(path) };
        });
      void update({ diagnostics: markersToDiagnostics(markers) });
    }, DIAGNOSTICS_DEBOUNCE_MS);
  };

  const track = (ed: monaco.editor.ICodeEditor) => {
    subs.push(
      ed.onDidFocusEditorText(() => {
        lastEditor = ed;
        pushSelection();
      }),
      ed.onDidChangeCursorSelection(() => {
        if (ed === lastEditor || ed.hasTextFocus()) {
          lastEditor = ed;
          pushSelection();
        }
      }),
      ed.onDidChangeModel(() => {
        if (ed === lastEditor) pushSelection();
      }),
      ed.onDidDispose(() => {
        if (ed === lastEditor) {
          lastEditor = null;
          pushSelection();
        }
      })
    );
  };

  void whenMonacoReady.then(() => {
    if (disposed) return;
    monaco.editor.getEditors().forEach(track);
    subs.push(monaco.editor.onDidCreateEditor(track));
    subs.push(monaco.editor.onDidChangeMarkers(pushDiagnostics));
    pushDiagnostics();
  });

  return () => {
    disposed = true;
    window.clearTimeout(selTimer);
    window.clearTimeout(diagTimer);
    subs.forEach((s) => s.dispose());
  };
}

export function useIdeBridge(host: IdeBridgeHost) {
  const hostRef = useRef(host);
  hostRef.current = host;
  const enabledRef = useRef(host.enabled);
  enabledRef.current = host.enabled;

  const [clients, setClients] = useState(0);
  const [diffs, setDiffs] = useState<PendingDiff[]>([]);
  const diffsRef = useRef(diffs);
  diffsRef.current = diffs;

  // Pastas do workspace: vazio (janela remota/sem pasta) tira a janela do
  // lock file.
  const foldersKey = JSON.stringify(host.enabled ? host.workspaceFolders : []);
  useEffect(() => {
    void update({ workspaceFolders: JSON.parse(foldersKey) });
  }, [foldersKey]);

  // Abas: o layout muda a cada tecla (conteúdo), então só publica quando o
  // conjunto caminho/dirty/ativa muda de fato.
  const tabs = useMemo(
    () =>
      host.enabled
        ? filesToIdeTabs(host.files, host.activePath, toFileUri, languageForFile)
        : [],
    [host.enabled, host.files, host.activePath]
  );
  const tabsKey = JSON.stringify(tabs);
  useEffect(() => {
    void update({ openEditors: JSON.parse(tabsKey) });
  }, [tabsKey]);

  // Foco da janela decide para quem vão getCurrentSelection/getOpenEditors.
  useEffect(() => {
    const onFocus = () => void update({ focused: true });
    if (document.hasFocus()) onFocus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => trackMonaco(enabledRef), []);

  // Clientes conectados → indicador "Claude conectado" na status bar.
  useEffect(() => {
    let alive = true;
    invoke<{ clients: number }>("ide_bridge_status")
      .then((s) => alive && setClients(s.clients))
      .catch(() => {});
    const un = listen<{ clients: number }>("ide-bridge://status", (e) =>
      setClients(e.payload.clients)
    );
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);

  const handleRequest = useCallback(async (req: IdeBridgeRequest) => {
    const h = hostRef.current;
    const path = typeof req.args.filePath === "string" ? req.args.filePath : "";
    switch (req.tool) {
      case "openDiff": {
        const args = parseOpenDiffArgs(req.args);
        if (!args) return respond(req.id, errorResult("openDiff: argumentos inválidos"));
        let original = "";
        let meta: Pick<PendingDiff, "encoding" | "eol" | "bom"> = {};
        let isNewFile = false;
        try {
          const decoded = await readFile(args.oldPath);
          original = decoded.content;
          meta = { encoding: decoded.encoding, eol: decoded.eol, bom: decoded.bom };
        } catch {
          isNewFile = true;
        }
        const diff: PendingDiff = {
          id: req.id,
          tabName: args.tabName,
          oldPath: args.oldPath,
          newPath: args.newPath,
          original,
          proposed: args.newContents,
          isNewFile,
          ...meta,
        };
        setDiffs((prev) => [...prev.filter((d) => d.id !== diff.id), diff]);
        return;
      }
      case "openFile": {
        try {
          let range: MonacoRange | null = null;
          const startText = typeof req.args.startText === "string" ? req.args.startText : "";
          if (startText) {
            const endText = typeof req.args.endText === "string" ? req.args.endText : undefined;
            range = findTextRange((await readFile(path)).content, startText, endText);
          }
          const ok = await h.openFile(path, range);
          return respond(
            req.id,
            ok ? textResult(`Opened file: ${path}`) : errorResult(`Failed to open file: ${path}`)
          );
        } catch (err) {
          return respond(req.id, errorResult(`Failed to open file: ${path}: ${err}`));
        }
      }
      case "saveDocument": {
        try {
          await h.saveFile(path);
          return respond(req.id, saveDocumentResult(path, true));
        } catch (err) {
          return respond(req.id, saveDocumentResult(path, false, String(err)));
        }
      }
      default:
        return respond(req.id, errorResult(`Ferramenta não suportada: ${req.tool}`));
    }
  }, []);

  // Requests vêm endereçados a ESTA janela (emit_to pelo label).
  useEffect(() => {
    const win = getCurrentWindow();
    const unReq = win.listen<IdeBridgeRequest>("ide-bridge://request", (e) => {
      void handleRequest(e.payload);
    });
    // O CLI fechou o diff (close_tab/closeAllDiffTabs) ou caiu.
    const unDismiss = win.listen<{ id: string }>("ide-bridge://dismiss", (e) => {
      setDiffs((prev) => prev.filter((d) => d.id !== e.payload.id));
    });
    return () => {
      void unReq.then((f) => f());
      void unDismiss.then((f) => f());
    };
  }, [handleRequest]);

  /** Aceitar: grava (preservando encoding/EOL/BOM) e responde `FILE_SAVED`. */
  const acceptDiff = useCallback(async (id: string, finalText: string) => {
    const diff = diffsRef.current.find((d) => d.id === id);
    if (!diff) return;
    try {
      await writeFile(diff.newPath, finalText, {
        encoding: diff.encoding,
        eol: diff.eol,
        bom: diff.bom,
      });
    } catch (err) {
      setDiffs((prev) =>
        prev.map((d) =>
          d.id === id ? { ...d, error: `Não foi possível salvar o arquivo: ${err}` } : d
        )
      );
      return;
    }
    hostRef.current.fileWritten(diff.newPath, finalText);
    setDiffs((prev) => prev.filter((d) => d.id !== id));
    await respond(id, diffAcceptedResult(finalText));
  }, []);

  const rejectDiff = useCallback((id: string) => {
    setDiffs((prev) => prev.filter((d) => d.id !== id));
    void respond(id, diffRejectedResult());
  }, []);

  /** Reinicia o servidor (porta/token novos) e republica o estado. */
  const restart = useCallback(async () => {
    await invoke("ide_bridge_restart");
    const h = hostRef.current;
    await update({
      workspaceFolders: h.enabled ? h.workspaceFolders : [],
      focused: document.hasFocus(),
    });
  }, []);

  return { clients, diffs, acceptDiff, rejectDiff, restart };
}
