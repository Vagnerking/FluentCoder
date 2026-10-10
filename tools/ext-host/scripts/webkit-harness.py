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
</head><body><iframe id="f" src="__URL__" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads allow-popups allow-modals"></iframe>
<script>
const HANDLE = __HANDLE__, THEME = __THEME__;
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
  toPy(d);
});
window.deliver = (m) => { if (ready) f.contentWindow.postMessage(m, '*'); else queue.push(m); };
</script></body></html>"""


class Harness:
    def __init__(self, target, seconds, png, theme):
        self.ext_id, self.view_ids = TARGETS[target]
        self.seconds = seconds
        self.png = png
        self.theme = theme
        self.next_id = 0
        self.waiters = {}
        self.handle = None
        self.report = {"target": target, "up": [], "down": [], "console": [], "errors": []}
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
            {"workspaceFolders": [os.getcwd()], "appConnected": True, "dataDir": os.path.join("/tmp", "fluent-ext-harness-%d" % os.getpid())},
            self._after_init,
        )

    def _after_init(self, msg):
        if "error" in msg:
            return self.fail("initialize: " + msg["error"]["message"])
        self.send({"method": "setTheme", "params": {"vars": self.theme, "kind": "dark"}})
        self.call("loadExtension", {"id": self.ext_id}, self._after_load)

    def _after_load(self, msg):
        if "error" in msg:
            return self.fail("loadExtension: " + msg["error"]["message"])
        views = [v["id"] for v in msg["result"]["views"]]
        view_id = next((v for v in self.view_ids if v in views), views[0] if views else None)
        self.report["viewId"] = view_id
        self.call("resolveView", {"viewId": view_id}, self._after_resolve)

    def _after_resolve(self, msg):
        if "error" in msg:
            return self.fail("resolveView: " + msg["error"]["message"])
        info = msg["result"]
        self.handle = info["handle"]
        self.report["url"] = info["url"]
        origin = "/".join(info["url"].split("/")[:3]) + "/"
        html = (
            PARENT_HTML.replace("__URL__", info["url"])
            .replace("__HANDLE__", json.dumps(self.handle))
            .replace("__THEME__", json.dumps(self.theme))
        )
        # Página pai na MESMA origem do iframe: permite inspecionar o DOM dele.
        self.view.load_html(html, origin)
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
        elif d.get("type") == "ready":
            self.report["iframeReady"] = True

    def _inspect(self):
        js = """(() => { const d = document.getElementById('f').contentDocument; if (!d) return JSON.stringify({noDoc: true});
          const b = d.body; const err = d.getElementById('claude-error');
          return JSON.stringify({ title: d.title, bodyClass: b && b.className, text: (b ? b.innerText : '').slice(0, 1500),
            elements: d.querySelectorAll('*').length, claudeError: err ? err.textContent.slice(0, 500) : null,
            fg: getComputedStyle(d.documentElement).getPropertyValue('--vscode-foreground'),
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
    args = ap.parse_args()
    theme = json.loads(args.theme) if args.theme else {}
    h = Harness(args.target, args.seconds, args.png, theme)
    h.start()
    GLib.timeout_add_seconds(args.seconds + 30, lambda: (h.fail("timeout"), False)[1])
    Gtk.main()


if __name__ == "__main__":
    sys.exit(main())
