import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EXT_DEBUG, extHost, extLog } from "./client";
import type { WebviewInfo } from "./protocol";
import { controlMessage, isExternalLink, originOf, parseIframeMessage } from "./relay";
import { readFluentThemeVars } from "./theme";

interface Props {
  /** Webview já resolvido (view da sidebar ou painel). */
  info: WebviewInfo;
  /** Se a aba está visível (repassado a `WebviewView.visible`). */
  visible: boolean;
}

/**
 * Renderiza o HTML de um webview de extensão num <iframe> servido pelo host
 * (http://127.0.0.1:<porta>/<token>/wv/<handle>/index.html) e faz o relay
 * iframe ↔ host. O iframe fica montado enquanto a aba existir
 * (equivalente a `retainContextWhenHidden`).
 */
export function ExtensionWebview({ info, visible }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState(info.url);
  const [stats, setStats] = useState({ up: 0, down: 0, lastUp: "", lastDown: "" });
  const handle = info.handle;

  // O HTML pode ser reatribuído pela extensão (webview.html = …) → nova URL.
  useEffect(() => {
    // Se o `html` foi definido antes de montarmos, o evento já passou: consulta.
    void (extHost.call("webviewUrl", { handle }) as Promise<WebviewInfo | null>)
      .then((r) => r?.url && setUrl((cur) => cur ?? r.url))
      .catch(() => {});
    return extHost.on((ev) => {
      if (ev.event === "webviewHtml" && (ev as WebviewInfo).handle === handle) {
        setUrl((ev as WebviewInfo).url);
      }
    });
  }, [handle]);

  useEffect(() => {
    if (!url) return;
    const origin = originOf(url);
    let detach: (() => void) | null = null;
    const onMessage = (e: MessageEvent) => {
      const msg = parseIframeMessage(
        e.data,
        { origin: e.origin, source: e.source },
        { origin, source: iframeRef.current?.contentWindow ?? null, handle },
      );
      if (!msg) return;
      const win = iframeRef.current?.contentWindow;
      switch (msg.type) {
        case "ready":
          extLog(`iframe pronto ${handle}`);
          win?.postMessage(controlMessage("theme", { vars: readFluentThemeVars(), kind: "dark" }), origin);
          detach?.();
          detach = extHost.attachSink(handle, (m) => iframeRef.current?.contentWindow?.postMessage(m, origin));
          break;
        case "message":
          extHost.sendToExtension(handle, msg.message);
          break;
        case "setState":
          void extHost.notify("webviewState", { handle, state: msg.state });
          break;
        case "link":
          if (isExternalLink(msg.href)) {
            void invoke("ext_host_open_external", { url: msg.href }).catch((err) => extLog("openExternal falhou", err));
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      detach?.();
    };
  }, [url, handle]);

  useEffect(() => {
    void extHost.notify("webviewVisible", { handle, visible });
    // Desmontar (sidebar fechada) = view oculta; reabrir reaproveita a mesma
    // WebviewView no host e o webview refaz o handshake (init/ready).
    return () => void extHost.notify("webviewVisible", { handle, visible: false });
  }, [handle, visible]);

  // Rodapé de debug (só em dev): prova visual do round trip.
  useEffect(() => {
    if (!EXT_DEBUG) return;
    const t = window.setInterval(() => setStats({ ...extHost.stats }), 500);
    return () => window.clearInterval(t);
  }, []);

  if (!url) {
    return <div className="ext-webview-status">Carregando a interface da extensão…</div>;
  }
  return (
    <div className="ext-webview">
      <iframe
        ref={iframeRef}
        className="ext-webview-frame"
        src={url}
        title={info.title ?? info.viewType}
        // Mesmo conjunto do VS Code. `allow-same-origin` é seguro aqui porque a
        // origem do iframe (127.0.0.1:<porta>) é diferente da do app.
        sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads allow-popups allow-modals"
        allow="clipboard-read; clipboard-write"
      />
      {EXT_DEBUG && (
        <div className="ext-webview-debug" title="Relay webview ↔ extensão (somente em desenvolvimento)">
          ↑ {stats.up} {stats.lastUp && `(${stats.lastUp})`} · ↓ {stats.down} {stats.lastDown && `(${stats.lastDown})`}
        </div>
      )}
    </div>
  );
}
