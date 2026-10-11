/**
 * Snippets no formato do VS Code (`contributes.snippets`, `<config>/snippets/
 * *.json`, `.vscode/*.code-snippets`): leitura do arquivo e o parser da
 * sintaxe TextMate de snippets — tabstops (`$1`, `${1}`), placeholders
 * (`${1:texto}`, aninháveis), escolhas (`${1|a,b|}`), variáveis (`$TM_FILENAME`,
 * `${CURRENT_YEAR}`, `${VAR:padrão}`, `${VAR/regex/formato/opções}`) e
 * escapes (`\$`, `\}`, `\\`). A inserção ao vivo é do SnippetController do
 * Monaco; aqui ficam a validação, a prévia e a resolução das variáveis que o
 * app conhece. Puro.
 */

export type SnippetNode =
  | { kind: "text"; value: string }
  | { kind: "tabstop"; index: number }
  | { kind: "placeholder"; index: number; children: SnippetNode[] }
  | { kind: "choice"; index: number; options: string[] }
  | { kind: "variable"; name: string; children: SnippetNode[]; transform?: string };

/** Parser tolerante: o que não for sintaxe válida vira texto (como no VS Code). */
export function parseSnippet(body: string): SnippetNode[] {
  let i = 0;
  const n = body.length;

  function text(stopAt: string): SnippetNode[] {
    const out: SnippetNode[] = [];
    let buf = "";
    const flush = () => {
      if (buf) out.push({ kind: "text", value: buf });
      buf = "";
    };
    while (i < n) {
      const c = body[i];
      if (c === "\\" && i + 1 < n && "$}\\,|".includes(body[i + 1])) {
        buf += body[i + 1];
        i += 2;
        continue;
      }
      if (stopAt.includes(c)) break;
      if (c === "$") {
        const start = i;
        const node = dollar();
        if (node) {
          flush();
          out.push(node);
          continue;
        }
        i = start + 1;
        buf += "$";
        continue;
      }
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  function dollar(): SnippetNode | null {
    i++; // $
    const m = /^(\d+)/.exec(body.slice(i, i + 8));
    if (m) {
      i += m[1].length;
      return { kind: "tabstop", index: +m[1] };
    }
    const v = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(body.slice(i, i + 64));
    if (v) {
      i += v[1].length;
      return { kind: "variable", name: v[1], children: [] };
    }
    if (body[i] !== "{") return null;
    i++;
    const idx = /^(\d+)/.exec(body.slice(i, i + 8));
    if (idx) {
      i += idx[1].length;
      const index = +idx[1];
      if (body[i] === "}") {
        i++;
        return { kind: "tabstop", index };
      }
      if (body[i] === ":") {
        i++;
        const children = text("}");
        if (body[i] !== "}") return null;
        i++;
        return { kind: "placeholder", index, children };
      }
      if (body[i] === "|") {
        i++;
        const options: string[] = [];
        let cur = "";
        while (i < n) {
          const c = body[i];
          if (c === "\\" && i + 1 < n) {
            cur += body[i + 1];
            i += 2;
            continue;
          }
          if (c === ",") {
            options.push(cur);
            cur = "";
            i++;
            continue;
          }
          if (c === "|" && body[i + 1] === "}") {
            options.push(cur);
            i += 2;
            return { kind: "choice", index, options };
          }
          cur += c;
          i++;
        }
        return null;
      }
      return null;
    }
    const name = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(body.slice(i, i + 64));
    if (!name) return null;
    i += name[1].length;
    if (body[i] === "}") {
      i++;
      return { kind: "variable", name: name[1], children: [] };
    }
    if (body[i] === ":") {
      i++;
      const children = text("}");
      if (body[i] !== "}") return null;
      i++;
      return { kind: "variable", name: name[1], children };
    }
    if (body[i] === "/") {
      // Transformação: guarda o texto cru até o `}` que fecha (o Monaco aplica).
      const start = i;
      let depth = 0;
      while (i < n) {
        if (body[i] === "\\") {
          i += 2;
          continue;
        }
        if (body[i] === "{") depth++;
        if (body[i] === "}") {
          if (depth === 0) break;
          depth--;
        }
        i++;
      }
      if (body[i] !== "}") return null;
      const transform = body.slice(start, i);
      i++;
      return { kind: "variable", name: name[1], children: [], transform };
    }
    return null;
  }

  return text("");
}

/** Escapa texto literal para dentro de um snippet. */
export function escapeSnippetText(s: string): string {
  return s.replace(/[\\$}]/g, "\\$&");
}

/**
 * Substitui as variáveis conhecidas (`values`) pelo valor (escapado); as
 * desconhecidas, as com transformação e as que o Monaco resolve sozinho
 * (seleção, área de transferência) ficam como estão.
 */
export function resolveSnippetVariables(body: string, values: Record<string, string>): string {
  return body.replace(/(\\.)|\$([A-Za-z_][A-Za-z0-9_]*)\b|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::((?:\\.|[^\\}$])*))?\}/g, (m, esc: string | undefined, bare: string | undefined, braced: string | undefined) => {
    if (esc) return m;
    const name = bare ?? braced!;
    return Object.prototype.hasOwnProperty.call(values, name) ? escapeSnippetText(values[name]) : m;
  });
}

/** Texto de prévia (documentação do item): placeholders/escolhas viram o 1º valor. */
export function snippetPreview(nodes: SnippetNode[], values: Record<string, string> = {}): string {
  return nodes
    .map((nd) => {
      switch (nd.kind) {
        case "text":
          return nd.value;
        case "tabstop":
          return "";
        case "placeholder":
          return snippetPreview(nd.children, values);
        case "choice":
          return nd.options[0] ?? "";
        case "variable":
          return values[nd.name] ?? (nd.children.length ? snippetPreview(nd.children, values) : nd.name);
      }
    })
    .join("");
}

export interface SnippetDefinition {
  name: string;
  prefixes: string[];
  body: string;
  description?: string;
  /** Linguagens (ids); vazio = todas. */
  scopes: string[];
  /** Origem (extensão ou arquivo do usuário) para a UI. */
  source: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Arquivo de snippets → definições. `language` = a do arquivo (`rust.json`,
 * `contributes.snippets[].language`); `.code-snippets` usa o `scope` de cada
 * snippet (lista separada por vírgula). Tetos: 5 000 snippets, corpo ≤ 64 KB.
 */
export function readSnippetFile(json: unknown, opts: { language?: string; source: string }): SnippetDefinition[] {
  if (!isObj(json)) return [];
  const out: SnippetDefinition[] = [];
  for (const [name, raw] of Object.entries(json).slice(0, 5000)) {
    if (!isObj(raw)) continue;
    const prefixes = (typeof raw.prefix === "string" ? [raw.prefix] : Array.isArray(raw.prefix) ? raw.prefix : []).filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 128);
    const body = typeof raw.body === "string" ? raw.body : Array.isArray(raw.body) ? raw.body.filter((x) => typeof x === "string").join("\n") : null;
    if (!prefixes.length || body === null || body.length > 64 * 1024) continue;
    const scopeList = typeof raw.scope === "string" ? raw.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const scopes = opts.language ? [opts.language] : scopeList;
    out.push({ name, prefixes, body, description: typeof raw.description === "string" ? raw.description : Array.isArray(raw.description) ? raw.description.join("\n") : undefined, scopes, source: opts.source });
  }
  return out;
}

/** Variáveis de data/hora do VS Code (`CURRENT_*`) para um instante. */
export function timeVariables(d: Date, locale = "pt-BR"): Record<string, string> {
  const p2 = (x: number) => String(x).padStart(2, "0");
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, o).format(d);
  const off = -d.getTimezoneOffset();
  return {
    CURRENT_YEAR: String(d.getFullYear()),
    CURRENT_YEAR_SHORT: String(d.getFullYear()).slice(-2),
    CURRENT_MONTH: p2(d.getMonth() + 1),
    CURRENT_MONTH_NAME: fmt({ month: "long" }),
    CURRENT_MONTH_NAME_SHORT: fmt({ month: "short" }).replace(".", ""),
    CURRENT_DATE: p2(d.getDate()),
    CURRENT_DAY_NAME: fmt({ weekday: "long" }),
    CURRENT_DAY_NAME_SHORT: fmt({ weekday: "short" }).replace(".", ""),
    CURRENT_HOUR: p2(d.getHours()),
    CURRENT_MINUTE: p2(d.getMinutes()),
    CURRENT_SECOND: p2(d.getSeconds()),
    CURRENT_SECONDS_UNIX: String(Math.floor(d.getTime() / 1000)),
    CURRENT_TIMEZONE_OFFSET: `${off >= 0 ? "+" : "-"}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`,
  };
}

/** Variáveis de arquivo/workspace do VS Code. */
export function fileVariables(filePath: string, workspaceRoot?: string | null): Record<string, string> {
  const norm = filePath.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  const file = norm.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const root = workspaceRoot?.replace(/\\/g, "/").replace(/\/$/, "");
  const sep = filePath.includes("\\") ? "\\" : "/";
  const vars: Record<string, string> = {
    TM_FILENAME: file,
    TM_FILENAME_BASE: dot > 0 ? file.slice(0, dot) : file,
    TM_DIRECTORY: filePath.slice(0, Math.max(0, filePath.length - file.length - 1)),
    TM_DIRECTORY_BASE: norm.slice(0, Math.max(0, slash)).split("/").pop() ?? "",
    TM_FILEPATH: filePath,
    RELATIVE_FILEPATH: root && norm.startsWith(`${root}/`) ? norm.slice(root.length + 1).split("/").join(sep) : filePath,
  };
  if (root) {
    vars.WORKSPACE_FOLDER = workspaceRoot!;
    vars.WORKSPACE_NAME = root.split("/").pop() ?? root;
  }
  return vars;
}
