// Servidor HTTP local (127.0.0.1, porta preferida persistida ou aleatória):
//   GET /<token>/res/<caminho absoluto>     → recursos (asWebviewUri)
//   GET /<token>/wv/<handle>/index.html     → HTML do webview + preâmbulo
//
// Regras de segurança (ver docs/context/extensoes-vscode.md):
// - só escuta em 127.0.0.1; token aleatório de 128 bits por sessão no caminho
//   (sem ele: 404 — outras páginas/processos locais não adivinham URLs);
// - recursos só de raízes permitidas (pasta da extensão, localResourceRoots,
//   pastas do workspace), checadas no caminho normalizado E no realpath
//   (symlink apontando para fora → 403); NUL/`..` codificados não escapam;
// - CORS só para a própria origem (os iframes dos webviews); nada de `*`;
// - só GET/HEAD; `nosniff`; HTML do webview sem cache, recursos da pasta da
//   extensão (caminho versionado) com cache longo dentro da sessão.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
};

/** Converte caminho absoluto do FS no segmento de URL (sempre com `/`). */
function fsPathToUrlPath(fsPath) {
  let p = String(fsPath).replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p; // C:/x → /C:/x
  return p.split('/').map(encodeURIComponent).join('/');
}

/** Inverso de fsPathToUrlPath. Lança em NUL ou separador codificado. */
function urlPathToFsPath(urlPath) {
  const segs = urlPath.split('/').map((s) => decodeURIComponent(s));
  // `%2F`/`%5C` dentro de um segmento ou NUL: tentativa de enganar a checagem.
  if (segs.some((s) => s.includes('/') || s.includes('\\') || s.includes('\0'))) throw new Error('caminho inválido');
  let p = segs.join('/');
  if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1); // /C:/x → C:/x
  return path.normalize(p);
}

function isInside(child, root) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realpathOr(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

class ResourceServer {
  /**
   * @param {{getWebviewHtml?:(handle:string)=>string|null, log?:(m:string)=>void,
   *   preferredPort?:number}} opts
   */
  constructor({ getWebviewHtml, log, preferredPort } = {}) {
    this.token = crypto.randomBytes(16).toString('hex');
    this.roots = new Map(); // raiz resolvida → { real, extensionId? }
    this.getWebviewHtml = getWebviewHtml || (() => null);
    this.log = log || (() => {});
    this.preferredPort = preferredPort || 0;
    this.port = 0;
    this.server = http.createServer((req, res) => this._handle(req, res));
    // Sem keep-alive eterno: o processo encerra rápido ao sair.
    this.server.keepAliveTimeout = 5000;
  }
  listen() {
    const tryListen = (port) =>
      new Promise((resolve, reject) => {
        const onErr = (err) => {
          this.server.removeListener('listening', onOk);
          reject(err);
        };
        const onOk = () => {
          this.server.removeListener('error', onErr);
          this.port = this.server.address().port;
          resolve(this.port);
        };
        this.server.once('error', onErr);
        this.server.once('listening', onOk);
        this.server.listen(port, '127.0.0.1');
      });
    // Porta estável entre sessões quando livre (origem do webview estável).
    return this.preferredPort ? tryListen(this.preferredPort).catch(() => tryListen(0)) : tryListen(0);
  }
  close() {
    return new Promise((r) => {
      if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
      this.server.close(() => r());
    });
  }
  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }
  allowRoot(fsPath, extensionId) {
    if (!fsPath) return;
    const abs = path.resolve(fsPath);
    const prev = this.roots.get(abs);
    this.roots.set(abs, { real: realpathOr(abs), extensionId: extensionId || (prev && prev.extensionId) });
  }
  /** Raiz que contém o caminho (normalizado E realpath), ou null. */
  rootFor(fsPath) {
    const abs = path.resolve(fsPath);
    let best = null;
    for (const [root, info] of this.roots) {
      if (isInside(abs, root) && (!best || root.length > best.root.length)) best = { root, ...info };
    }
    if (!best) return null;
    const real = realpathOr(abs);
    // O alvo real também precisa estar numa raiz permitida (symlink para fora → negado).
    for (const [, info] of this.roots) if (isInside(real, info.real)) return best;
    return null;
  }
  isAllowed(fsPath) {
    return this.rootFor(fsPath) !== null;
  }
  resourceUrl(fsPath) {
    return `${this.origin}/${this.token}/res${fsPathToUrlPath(fsPath)}`;
  }
  webviewUrl(handle, version) {
    return `${this.origin}/${this.token}/wv/${encodeURIComponent(handle)}/index.html?v=${version || 0}`;
  }

  _headers(req) {
    const h = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-site' };
    // CORS só para a própria origem (iframes dos webviews; módulos `crossorigin`).
    if (req.headers.origin === this.origin) {
      h['Access-Control-Allow-Origin'] = this.origin;
      h['Vary'] = 'Origin';
    }
    return h;
  }

  _handle(req, res) {
    let url;
    try {
      url = new URL(req.url, this.origin);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const prefix = `/${this.token}/`;
    const common = this._headers(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...common, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !url.pathname.startsWith(prefix)) {
      res.writeHead(404, common);
      return res.end();
    }
    const rest = url.pathname.slice(prefix.length);
    if (rest.startsWith('wv/')) {
      const m = /^wv\/([^/]+)\/index\.html$/.exec(rest);
      const html = m ? this.getWebviewHtml(decodeURIComponent(m[1])) : null;
      if (html == null) {
        res.writeHead(404, common);
        return res.end();
      }
      res.writeHead(200, { ...common, 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    if (rest.startsWith('res/')) {
      let fsPath;
      try {
        fsPath = urlPathToFsPath(rest.slice(3));
      } catch {
        res.writeHead(400, common);
        return res.end();
      }
      const root = this.rootFor(fsPath);
      if (!root) {
        this.log(`[server] 403 fora das raízes permitidas: ${fsPath}`);
        res.writeHead(403, common);
        return res.end();
      }
      fs.stat(fsPath, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404, common);
          return res.end();
        }
        const type = MIME[path.extname(fsPath).toLowerCase()] || 'application/octet-stream';
        const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
        // Pasta da extensão = conteúdo versionado (imutável na sessão); o resto
        // (workspace) revalida sempre.
        const immutable = !!root.extensionId;
        const headers = { ...common, 'Content-Type': type, ETag: etag, 'Cache-Control': immutable ? 'private, max-age=86400, immutable' : 'no-cache' };
        // Service workers de webview precisam do escopo liberado.
        if (/service-worker/i.test(fsPath)) headers['Service-Worker-Allowed'] = '/';
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, headers);
          return res.end();
        }
        headers['Content-Length'] = st.size;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(fsPath).pipe(res);
      });
      return;
    }
    res.writeHead(404, common);
    res.end();
  }
}

module.exports = { ResourceServer, fsPathToUrlPath, urlPathToFsPath, isInside };
