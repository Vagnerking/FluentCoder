// Servidor HTTP local (127.0.0.1, porta aleatória) que serve:
//   GET /<token>/res/<caminho absoluto>     → recursos (asWebviewUri)
//   GET /<token>/wv/<handle>/index.html     → HTML do webview + preâmbulo
// O token aleatório por sessão no caminho impede que outras páginas/processos
// locais adivinhem URLs; os recursos só são servidos de raízes permitidas
// (pasta da extensão, localResourceRoots e pastas do workspace).
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

/** Inverso de fsPathToUrlPath. */
function urlPathToFsPath(urlPath) {
  let p = urlPath.split('/').map((s) => decodeURIComponent(s)).join('/');
  if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1); // /C:/x → C:/x
  return path.normalize(p);
}

function isInside(child, root) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

class ResourceServer {
  constructor({ getWebviewHtml, log } = {}) {
    this.token = crypto.randomBytes(16).toString('hex');
    this.roots = new Set();
    this.getWebviewHtml = getWebviewHtml || (() => null);
    this.log = log || (() => {});
    this.port = 0;
    this.server = http.createServer((req, res) => this._handle(req, res));
  }
  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }
  close() {
    return new Promise((r) => this.server.close(() => r()));
  }
  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }
  allowRoot(fsPath) {
    if (fsPath) this.roots.add(path.resolve(fsPath));
  }
  isAllowed(fsPath) {
    for (const r of this.roots) if (isInside(fsPath, r)) return true;
    return false;
  }
  resourceUrl(fsPath) {
    return `${this.origin}/${this.token}/res${fsPathToUrlPath(fsPath)}`;
  }
  webviewUrl(handle, version) {
    return `${this.origin}/${this.token}/wv/${encodeURIComponent(handle)}/index.html?v=${version || 0}`;
  }

  _handle(req, res) {
    const url = new URL(req.url, this.origin);
    const prefix = `/${this.token}/`;
    const common = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...common, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': '*' });
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
      res.writeHead(200, { ...common, 'Content-Type': MIME['.html'] });
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
      if (!this.isAllowed(fsPath)) {
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
        const headers = { ...common, 'Content-Type': type, 'Content-Length': st.size };
        // Service workers de webview precisam do escopo liberado.
        if (/service-worker/i.test(fsPath)) headers['Service-Worker-Allowed'] = '/';
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
