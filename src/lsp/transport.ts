import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
  type IWebSocket,
} from "vscode-ws-jsonrpc";
import type { MessageReader, MessageWriter } from "vscode-jsonrpc";
import { lspLog } from "./debug";

/**
 * A reader/writer pair bound to the bridge WebSocket. Returned by
 * {@link createTransport} and consumed by `monaco-languageclient`'s
 * connection provider in `client.ts`.
 */
export interface LspTransport {
  reader: MessageReader;
  writer: MessageWriter;
  socket: WebSocket;
}

/**
 * Adapts a browser {@link WebSocket} to the `IWebSocket` interface expected by
 * `vscode-ws-jsonrpc`'s `WebSocketMessageReader`/`WebSocketMessageWriter`.
 *
 * In `vscode-ws-jsonrpc@3` the old `toSocket` helper was dropped, so we provide
 * the thin adapter here. Keeping it in `transport.ts` means the rest of the LSP
 * wiring never touches the raw WebSocket — if the transport ever moves to
 * Tauri invoke/event, only this file changes.
 */
function toSocket(ws: WebSocket): IWebSocket {
  return {
    send: (content) => ws.send(content),
    onMessage: (cb) => {
      ws.onmessage = (ev) => cb(ev.data);
    },
    onError: (cb) => {
      ws.onerror = (ev) => {
        if (ev instanceof ErrorEvent && ev.message) {
          cb(ev.message);
        } else {
          cb("WebSocket error");
        }
      };
    },
    onClose: (cb) => {
      ws.onclose = (ev) => {
        lspLog("WS onclose", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
        cb(ev.code, ev.reason);
      };
    },
    dispose: () => {
      lspLog("WS dispose() called (someone is closing the socket)", new Error().stack?.split("\n").slice(1, 4).join(" | "));
      ws.close();
    },
  };
}

/**
 * Connects to the local LSP bridge WebSocket and returns JSON-RPC
 * reader/writer transports.
 *
 * The bridge listens on `127.0.0.1:{port}` (ephemeral port) and authenticates
 * the connection with a per-session `token` passed as a query parameter — see
 * `src-tauri/src/lsp/bridge.rs` (ISSUE-21).
 *
 * Resolves once the socket is `open`; rejects if the connection fails before
 * opening.
 */
export function createTransport(port: number, token: string): Promise<LspTransport> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);

    const onOpenError = (ev: Event) => {
      ws.removeEventListener("open", onOpen);
      reject(new Error(`Failed to connect to LSP bridge at ${url}: ${String(ev)}`));
    };
    const onOpen = () => {
      ws.removeEventListener("error", onOpenError);
      const socket = toSocket(ws);
      resolve({
        reader: new WebSocketMessageReader(socket),
        writer: new WebSocketMessageWriter(socket),
        socket: ws,
      });
    };

    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onOpenError, { once: true });
  });
}
