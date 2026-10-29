#!/usr/bin/env python3
"""Harness de desenvolvimento (Linux): renderiza o webview REAL de uma extensão
num WebKitGTK offscreen — o mesmo motor do Tauri no Linux — sem abrir o app.

Faz o papel do Fluent Coder: sobe `tools/ext-host/main.js`, carrega/ativa a
extensão, resolve a view e coloca o HTML servido num <iframe> dentro de uma
página "pai" que implementa o mesmo relay do `ExtensionWebview.tsx`
(acquireVsCodeApi ↔ host). Ao final imprime um relatório JSON (mensagens nos
dois sentidos, texto visível, erros de console) e salva um PNG da tela.

Uso:
  python3 tools/ext-host/scripts/webkit-harness.py claude|codex [--seconds 15] [--png out.png]

Não envia prompts a modelos. Dica: rode com CLAUDE_CONFIG_DIR/CODEX_HOME
temporários para não tocar a configuração real.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time

# Offscreen sem GL: renderização por software (evita "GDK is not able to create a GL context").
os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
os.environ.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MAIN = os.path.join(HERE, "..", "main.js")
TARGETS = {
    "claude": ("anthropic.claude-code", ["claudeVSCodeSidebarSecondary", "claudeVSCodeSidebar"]),
    "codex": ("openai.chatgpt", ["chatgpt.sidebarSecondaryView", "chatgpt.sidebarView"]),
}

PARENT_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#1f2630}iframe{border:0;width:100%;height:100%;background:transparent}</style>
</head><body><iframe id="f" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"></iframe>
<script>
let HANDLE = null; const THEME = __THEME__;
// Mesmo codec binário do app (src/extensions/bincodec.ts): o host manda binário
// como {__fluentBin, b64} e espera o mesmo de volta.
const BIN = '__fluentBin';
const b64e = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000))); return btoa(s); };
const b64d = (b) => { const s = atob(b); const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; };
const walk = (v, fn) => Array.isArray(v) ? v.map(fn) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fn(x)]));
const enc = (v) => v === null || typeof v !== 'object' ? v : v instanceof ArrayBuffer ? {[BIN]: 'ArrayBuffer', b64: b64e(new Uint8Array(v))} : ArrayBuffer.isView(v) ? {[BIN]: v.constructor.name, b64: b64e(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))} : walk(v, enc);
const dec = (v) => { if (v === null || typeof v !== 'object') return v; if (!Array.isArray(v) && typeof v[BIN] === 'string') { const u = b64d(v.b64); return v[BIN] === 'ArrayBuffer' ? u.buffer : v[BIN] === 'Uint8Array' ? u : new globalThis[v[BIN]](u.buffer); } return walk(v, dec); };
const f = document.getElementById('f');
const toPy = (o) => window.webkit.messageHandlers.relay.postMessage(JSON.stringify(o));
let ready = false; const queue = [];
window.addEventListener('message', (e) => {
  if (e.source !== f.contentWindow) return;
  const d = e.data; if (!d || d.__fluentExt !== 1 || d.handle !== HANDLE) return;
  if (d.type === 'ready') {
    f.contentWindow.postMessage({__fluentCtl: 1, type: 'theme', vars: THEME, kind: 'dark'}, '*');
    ready = true; queue.splice(0).forEach((m) => f.contentWindow.postMessage(m, '*'));
  }
  if (d.type === 'message') d.message = enc(d.message);
  toPy(d);
});
window.openView = (url, handle) => { HANDLE = handle; f.src = url; };
window.deliver = (m) => { m = dec(m); if (ready) f.contentWindow.postMessage(m, '*'); else queue.push(m); };
</script></body></html>"""


class Harness:
    def __init__(self, target, seconds, png, theme, warm_ms=1500, data_dir=None):
        self.data_dir = data_dir or os.path.join("/tmp", "fluent-ext-harness-%d" % os.getpid())
        self.cross_origin = False
        self.warm_ms = warm_ms
        self.ext_id, self.view_ids = TARGETS[target]
        self.seconds = seconds
        self.png = png
        self.theme = theme
        self.next_id = 0
        self.waiters = {}
        self.handle = None
        self.report = {"target": target, "up": [], "down": [], "console": [], "errors": [], "timings": {}}
        self.t_click = None
        self.proc = subprocess.Popen(
            ["node", MAIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1
        )
        threading.Thread(target=self._read, daemon=True).start()

    # ---------------------------------------------------------------- host
    def _read(self):
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            GLib.idle_add(self._on_host, msg)

    def _on_host(self, msg):
        if "id" in msg and msg["id"] in self.waiters:
            self.waiters.pop(msg["id"])(msg)
        elif msg.get("event") == "postMessage" and msg.get("handle") == self.handle:
            self.mark("firstDown")
            self.report["down"].append(summarize(msg["message"]))
            self.view.evaluate_javascript("window.deliver(%s)" % json.dumps(msg["message"]), -1, None, None, None, None, None)
        elif msg.get("event") == "request":
            # Sem UI de diálogos aqui: cancela (o app real mostra o diálogo).
            self.send({"method": "respond", "params": {"requestId": msg["requestId"], "result": None}})
        return False

    def send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def call(self, method, params, cb):
        self.next_id += 1
        self.waiters[self.next_id] = cb
        self.send({"id": self.next_id, "method": method, "params": params})

    # ------------------------------------------------------------- fluxo
    def start(self):
        self.window = Gtk.OffscreenWindow()
        self.window.set_default_size(480, 860)
        manager = WebKit2.UserContentManager()
        manager.register_script_message_handler("relay")
        manager.connect("script-message-received::relay", self._on_relay)
        self.view = WebKit2.WebView.new_with_user_content_manager(manager)
        settings = self.view.get_settings()
        settings.set_enable_developer_extras(True)
        settings.set_enable_write_console_messages_to_stdout(False)
        self.window.add(self.view)
        self.window.show_all()
        self.call(
            "initialize",
            {"workspaceFolders": [os.getcwd()], "appConnected": True, "dataDir": self.data_dir},
            self._after_init,
        )

    def _after_init(self, msg):
        if "error" in msg:
            return self.fail("initialize: " + msg["error"]["message"])
        self.send({"method": "setTheme", "params": {"vars": self.theme, "kind": "dark"}})
        # Página pai já carregada (o app já está aberto) na MESMA origem do
        # iframe: permite inspecionar o DOM dele.
        origin = msg["result"]["origin"] + "/"
        # --cross-origin: página pai em OUTRA origem, como no app (localhost:1420 /
        # tauri://) — pega UIs que filtram mensagens por event.origin (o Codex).
        # O DOM do iframe fica inacessível nesse modo (só contadores/erros).
        if self.cross_origin:
            origin = "http://localhost:1420/"
        self.view.load_html(PARENT_HTML.replace("__THEME__", json.dumps(self.theme)), origin)
        # Host "quente": o app sobe o sidecar no startup; o clique na aba vem depois.
        GLib.timeout_add(self.warm_ms, self._click)

    def _click(self):
        self.t_click = time.monotonic()
        self.call("loadExtension", {"id": self.ext_id}, self._after_load)
        return False

    def mark(self, name):
        if self.t_click is not None and name not in self.report["timings"]:
            self.report["timings"][name] = round((time.monotonic() - self.t_click) * 1000)

    def _after_load(self, msg):
        if "error" in msg:
            return self.fail("loadExtension: " + msg["error"]["message"])
        self.mark("activated")
        views = [v["id"] for v in msg["result"]["views"]]
        view_id = next((v for v in self.view_ids if v in views), views[0] if views else None)
        self.report["viewId"] = view_id
        self.call("resolveView", {"viewId": view_id}, self._after_resolve)

    def _after_resolve(self, msg):
        if "error" in msg:
            return self.fail("resolveView: " + msg["error"]["message"])
        info = msg["result"]
        self.mark("resolved")
        self.handle = info["handle"]
        self.report["url"] = info["url"]
        self.view.evaluate_javascript("window.openView(%s, %s)" % (json.dumps(info["url"]), json.dumps(self.handle)), -1, None, None, None, None, None)
        GLib.timeout_add_seconds(self.seconds, self._inspect)

    def _on_relay(self, _manager, js_result):
        try:
            value = js_result.get_js_value().to_string()
        except AttributeError:
            value = js_result.to_string()
        d = json.loads(value)
        if d.get("type") == "message":
            self.report["up"].append(summarize(d.get("message")))
            self.send({"method": "webviewMessage", "params": {"handle": self.handle, "message": d.get("message")}})
        elif d.get("type") == "setState":
            self.send({"method": "webviewState", "params": {"handle": self.handle, "state": d.get("state")}})
        elif d.get("type") == "log":
            # Erros/avisos do JS do webview (repassados pelo preâmbulo).
            self.report["errors"].append("[%s] %s" % (d.get("level"), d.get("text")))
        elif d.get("type") == "ready":
            self.report["iframeReady"] = True
            self.mark("iframeReady")
            GLib.timeout_add(25, self._poll_interactive)

    def _poll_interactive(self):
        # Interativo = a UI da extensão montou controles (login ou chat).
        js = """(() => { const d = document.getElementById('f').contentDocument;
          return d ? d.querySelectorAll('button,textarea,input,[contenteditable=true]').length : 0 })()"""

        def done(view, result):
            try:
                n = int(view.evaluate_javascript_finish(result).to_double())
            except Exception:  # noqa: BLE001
                n = 0
            if n > 0:
                self.mark("interactive")
            elif self.t_click is not None and time.monotonic() - self.t_click < 20:
                GLib.timeout_add(25, self._poll_interactive)

        self.view.evaluate_javascript(js, -1, None, None, None, done)
        return False

    def _inspect(self):
        js = """(() => { const d = document.getElementById('f').contentDocument; if (!d) return JSON.stringify({noDoc: true});
          const b = d.body; const err = d.getElementById('claude-error');
          return JSON.stringify({ title: d.title, bodyClass: b && b.className, text: (b ? b.innerText : '').slice(0, 1500),
            elements: d.querySelectorAll('*').length, claudeError: err ? err.textContent.slice(0, 500) : null,
            fg: getComputedStyle(d.documentElement).getPropertyValue('--vscode-foreground'),
            perf: (() => { const w = document.getElementById('f').contentWindow; const n = w.performance.getEntriesByType('navigation')[0] || {};
              return { nav: { responseEnd: Math.round(n.responseEnd || 0), domInteractive: Math.round(n.domInteractive || 0), dcl: Math.round(n.domContentLoadedEventEnd || 0) },
                res: w.performance.getEntriesByType('resource').slice(0, 12).map((r) => [r.name.split('/').pop().slice(0, 40), Math.round(r.startTime), Math.round(r.responseEnd)]) }; })(),
            accent: getComputedStyle(d.documentElement).getPropertyValue('--vscode-focusBorder') }); })()"""
        self.view.evaluate_javascript(js, -1, None, None, None, self._on_inspect)
        return False

    def _on_inspect(self, view, result):
        try:
            value = view.evaluate_javascript_finish(result)
            self.report["dom"] = json.loads(value.to_string())
        except Exception as exc:  # noqa: BLE001
            self.report["errors"].append("inspect: %s" % exc)
        if self.png:
            # Pixbuf da janela offscreen (dispensa o python3-gi-cairo).
            try:
                self.window.get_pixbuf().savev(self.png, "png", [], [])
                self.report["png"] = self.png
            except Exception as exc:  # noqa: BLE001
                self.report["errors"].append("snapshot: %s" % exc)
        self.finish()

    def fail(self, why):
        self.report["errors"].append(why)
        self.finish()

    def finish(self):
        self.report["upCount"] = len(self.report["up"])
        self.report["downCount"] = len(self.report["down"])
        self.report["up"] = self.report["up"][:15]
        self.report["down"] = self.report["down"][:15]
        print(json.dumps(self.report, indent=2, ensure_ascii=False))
        try:
            self.send({"id": 999999, "method": "shutdown"})
        except Exception:  # noqa: BLE001
            pass
        GLib.timeout_add(800, Gtk.main_quit)


def summarize(m):
    if not isinstance(m, dict):
        return str(m)[:80]
    inner = m.get("message") if isinstance(m.get("message"), dict) else {}
    req = (inner.get("request") or m.get("request") or {}) if isinstance(inner.get("request") or m.get("request") or {}, dict) else {}
    resp = inner.get("response") if isinstance(inner.get("response"), dict) else {}
    return "/".join(str(x) for x in [m.get("type"), inner.get("type"), req.get("type"), resp.get("type")] if x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", choices=sorted(TARGETS))
    ap.add_argument("--seconds", type=int, default=15)
    ap.add_argument("--png")
    ap.add_argument("--theme", help="JSON com variáveis --vscode-* (padrão: nenhuma)")
    ap.add_argument("--theme-file", help="arquivo JSON com as variáveis --vscode-* (ex.: gerado de src/extensions/theme.ts)")
    ap.add_argument("--data-dir", help="pasta de dados do host (reutilizar = cache de compilação quente)")
    ap.add_argument("--warm-ms", type=int, default=1500, help="espera após o initialize antes do 'clique' (host quente)")
    ap.add_argument("--cross-origin", action="store_true", help="página pai em outra origem, como no app (o DOM do iframe fica inacessível)")
    args = ap.parse_args()
    theme = json.loads(args.theme) if args.theme else {}
    if args.theme_file:
        with open(args.theme_file, encoding="utf-8") as fh:
            theme.update(json.load(fh))
    h = Harness(args.target, args.seconds, args.png, theme, args.warm_ms, args.data_dir)
    h.cross_origin = args.cross_origin
    h.start()
    GLib.timeout_add_seconds(args.seconds + 30, lambda: (h.fail("timeout"), False)[1])
    Gtk.main()


if __name__ == "__main__":
    sys.exit(main())
