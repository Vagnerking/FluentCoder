/**
 * Caminhos DENTRO da pasta de uma extensão. O manifesto e os JSONs de tema
 * usam caminhos relativos (`./themes/x.json`, `../icons/a.svg`, `include`);
 * aqui eles viram um caminho limpo relativo à raiz da extensão — ou `null` se
 * escapariam dela. O Rust confere de novo (realpath), isto é a 1ª trava.
 */

/** Normaliza `a/./b/../c` → `a/c`; `null` se sair da raiz, for absoluto ou tiver NUL/`\`. */
export function normalizeInside(path: string): string | null {
  if (!path || path.includes("\0") || path.includes("\\")) return null;
  if (path.startsWith("/") || /^[a-z]:/i.test(path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length ? out.join("/") : null;
}

/** Diretório (relativo à raiz) de um arquivo relativo à raiz. */
export function dirnameInside(file: string): string {
  const i = file.lastIndexOf("/");
  return i === -1 ? "" : file.slice(0, i);
}

/** Resolve `rel` a partir do arquivo `fromFile` (ambos relativos à raiz). */
export function resolveFrom(fromFile: string, rel: string): string | null {
  const base = dirnameInside(fromFile);
  return normalizeInside(base ? `${base}/${rel}` : rel);
}

/**
 * URL do protocolo de ativos das extensões (`fcext`, servido pelo Rust só da
 * pasta da extensão). No Windows o WebView2 usa `http://<esquema>.localhost`.
 */
export function extensionAssetUrl(extensionId: string, relPath: string, windows: boolean): string {
  const path = [extensionId, ...relPath.split("/")].map(encodeURIComponent).join("/");
  return windows ? `http://fcext.localhost/${path}` : `fcext://localhost/${path}`;
}
