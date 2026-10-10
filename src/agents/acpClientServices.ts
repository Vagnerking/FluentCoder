/**
 * Atendente da janela para as capacidades de cliente ACP de ARQUIVOS
 * (`fs/read_text_file`/`fs/write_text_file` — `src-tauri/src/agents/acp_client.rs`):
 *
 * - **ler**: arquivo com modelo aberto no Monaco → o texto do BUFFER (o agente
 *   vê as edições não salvas); senão a janela diz `open:false` e o backend lê
 *   do disco;
 * - **escrever**: arquivo aberto → a escrita entra como UMA edição desfazível
 *   no modelo (Ctrl+Z volta) e o app salva pelo caminho normal; fechado → o
 *   backend grava no disco.
 *
 * A janela se registra (`acp_client_register`) para o backend saber quantas
 * respostas esperar.
 */
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as monaco from "monaco-editor";
import { whenMonacoReady } from "../monaco-loader";
import { toFileUri } from "../lsp/uri";
import { minimalEdit } from "../extensions/textEdits";

export interface AcpClientHost {
  /** Buffer mudou por edição externa (aba fica suja/atualiza o estado). */
  bufferChanged(path: string, content: string): void;
  /** Salva a aba do arquivo pelo caminho normal do app, com este conteúdo. */
  saveFile(path: string, content: string): Promise<boolean>;
  /** Arquivos gravados no disco pelo agente (atualiza o Explorer). */
  filesChanged?(paths: string[]): void;
}

interface ClientRequest {
  id: string;
  op: "read" | "write";
  path: string;
  content?: string;
}

function openModel(path: string): monaco.editor.ITextModel | null {
  const m = monaco.editor.getModel(monaco.Uri.parse(toFileUri(path)));
  return m && !m.isDisposed() ? m : null;
}

/** Aplica `text` no modelo como uma edição desfazível (só o trecho que mudou). */
export function applyAsUndoableEdit(model: monaco.editor.ITextModel, text: string): void {
  const edit = minimalEdit(model.getValue(), text);
  if (!edit) return;
  const start = model.getPositionAt(edit.start);
  const end = model.getPositionAt(edit.end);
  model.pushStackElement();
  model.pushEditOperations([], [{ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: edit.text }], () => null);
  model.pushStackElement();
}

export function useAcpClientServices(host: AcpClientHost, enabled = true): void {
  const hostRef = useRef(host);
  hostRef.current = host;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const respond = (id: string, result: unknown) => void invoke("acp_client_respond", { id, result }).catch(() => {});
    const handle = async (req: ClientRequest) => {
      await whenMonacoReady;
      const model = openModel(req.path);
      if (req.op === "read") {
        respond(req.id, model ? { open: true, content: model.getValue() } : { open: false });
        return;
      }
      if (!model || typeof req.content !== "string") {
        respond(req.id, { applied: false });
        return;
      }
      applyAsUndoableEdit(model, req.content);
      const text = model.getValue();
      hostRef.current.bufferChanged(req.path, text);
      const saved = await hostRef.current.saveFile(req.path, text).catch(() => false);
      respond(req.id, { applied: true, saved });
    };
    const unReq = listen<ClientRequest>("acp-client://request", (e) => {
      if (alive) void handle(e.payload).catch(() => respond(e.payload.id, { open: false, applied: false }));
    });
    const unWritten = listen<{ path: string }>("acp-client://written", (e) => {
      if (alive) hostRef.current.filesChanged?.([e.payload.path]);
    });
    void invoke("acp_client_register", { active: true }).catch(() => {});
    return () => {
      alive = false;
      void invoke("acp_client_register", { active: false }).catch(() => {});
      void unReq.then((f) => f());
      void unWritten.then((f) => f());
    };
  }, [enabled]);
}
