/**
 * Modelo puro do grafo de commits (testado em `graphModel.test.ts`): refs
 * por commit (pílulas), provedor de hospedagem a partir do remoto, mensagem
 * (corpo sem trailers + markdown leve), estatísticas por extenso e o resumo
 * da linhagem de uma branch.
 */
import { branchColor, branchColorKey } from "./graphLayout.ts";
import type { BranchLineage, GraphHeader, GraphRef, GraphRemote } from "./graphApi.ts";

// ---------------------------------------------------------------- refs

/** Uma pílula: local + remota de mesmo nome no mesmo commit viram uma só. */
export interface RefPill {
  key: string;
  label: string;
  kind: "head" | "branch" | "remote" | "tag";
  /** Também existe a remota (`origin/x`) no mesmo commit. */
  remote: string | null;
  /** Nome curto da ref para linhagem/checkout (`main`, `origin/x`, `v1`). */
  ref: string;
  color: number;
  title: string;
}

export interface RefIndex {
  byHash: Map<string, RefPill[]>;
  /** Chave de cor da ref "dona" de cada commit (para as lanes). */
  colorKey: Map<string, string>;
  remotes: string[];
}

const KIND_ORDER = { head: 0, branch: 1, remote: 2, tag: 3 } as const;

export function buildRefIndex(header: Pick<GraphHeader, "refs" | "head" | "remotes"> | null): RefIndex {
  const byHash = new Map<string, RefPill[]>();
  const colorKey = new Map<string, string>();
  const remotes = header?.remotes.map((r) => r.name) ?? [];
  if (!header) return { byHash, colorKey, remotes };
  const head = header.head;
  const groups = new Map<string, GraphRef[]>();
  for (const ref of header.refs) {
    const list = groups.get(ref.target) ?? [];
    list.push(ref);
    groups.set(ref.target, list);
  }
  for (const [hash, refs] of groups) {
    const pills: RefPill[] = [];
    const consumedRemotes = new Set<string>();
    for (const ref of refs.filter((r) => r.kind === "branch")) {
      const isHead = !head.detached && head.branch === ref.short;
      const remote = refs.find(
        (r) => r.kind === "remote" && (r.short === ref.upstream || branchColorKey(r.short, "remote", remotes) === ref.short)
      );
      if (remote) consumedRemotes.add(remote.short);
      pills.push({
        key: ref.name,
        label: ref.short,
        kind: isHead ? "head" : "branch",
        remote: remote?.short ?? null,
        ref: ref.short,
        color: branchColor(ref.short),
        title: [
          isHead ? `${ref.short} (branch atual)` : `Branch ${ref.short}`,
          remote ? `remota ${remote.short}` : ref.upstream ? `upstream ${ref.upstream}` : "",
          ref.ahead || ref.behind ? `↑${ref.ahead} ↓${ref.behind}` : "",
          ref.gone ? "upstream apagado" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    for (const ref of refs.filter((r) => r.kind === "remote" && !consumedRemotes.has(r.short))) {
      const key = branchColorKey(ref.short, "remote", remotes);
      pills.push({
        key: ref.name,
        label: ref.short,
        kind: "remote",
        remote: null,
        ref: ref.short,
        color: branchColor(key),
        title: `Branch remota ${ref.short}`,
      });
    }
    for (const ref of refs.filter((r) => r.kind === "tag")) {
      pills.push({
        key: ref.name,
        label: ref.short,
        kind: "tag",
        remote: null,
        ref: ref.short,
        color: branchColor(ref.short),
        title: `Tag ${ref.short}`,
      });
    }
    pills.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    byHash.set(hash, pills);
    const owner = pills.find((p) => p.kind === "head" || p.kind === "branch") ?? pills.find((p) => p.kind === "remote");
    if (owner) colorKey.set(hash, owner.kind === "remote" ? branchColorKey(owner.label, "remote", remotes) : owner.label);
  }
  // HEAD destacado sem branch (detached) ganha pílula própria.
  if (head.hash && head.detached) {
    const list = byHash.get(head.hash) ?? [];
    list.unshift({
      key: "HEAD",
      label: "HEAD",
      kind: "head",
      remote: null,
      ref: "HEAD",
      color: branchColor("HEAD"),
      title: "HEAD destacado",
    });
    byHash.set(head.hash, list);
  }
  return { byHash, colorKey, remotes };
}

// ---------------------------------------------------------------- hospedagem

export type HostingProvider = "github" | "gitlab" | "bitbucket" | "azure" | "generic";

export interface HostingRemote {
  provider: HostingProvider;
  /** "GitHub", "GitLab"… para "Abrir no …". */
  label: string;
  /** `https://github.com/dono/repo`. */
  webBase: string;
}

const PROVIDER_LABEL: Record<HostingProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure DevOps",
  generic: "navegador",
};

/** URL do remoto (`git@`, `ssh://`, `https://`, com usuário/porta) → web. */
export function hostingFromRemote(url: string | null | undefined): HostingRemote | null {
  if (!url) return null;
  let raw = url.trim();
  if (!raw) return null;
  let host = "";
  let path = "";
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw.replace(/^git\+/, ""));
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return null;
    }
  } else if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    return null;
  }
  path = path.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "");
  if (!host || !path) return null;
  const lower = host.toLowerCase();
  let provider: HostingProvider = "generic";
  if (lower === "github.com" || lower.startsWith("github.")) provider = "github";
  else if (lower.includes("gitlab")) provider = "gitlab";
  else if (lower.includes("bitbucket")) provider = "bitbucket";
  else if (lower.endsWith("dev.azure.com") || lower.endsWith("visualstudio.com")) provider = "azure";
  if (provider === "azure") {
    // ssh.dev.azure.com:v3/org/proj/repo → dev.azure.com/org/proj/_git/repo
    const parts = path.replace(/^v3\//, "").split("/");
    if (parts.length >= 3 && !parts.includes("_git")) {
      const [org, project, ...repo] = parts;
      return { provider, label: PROVIDER_LABEL.azure, webBase: `https://dev.azure.com/${org}/${project}/_git/${repo.join("/")}` };
    }
    return { provider, label: PROVIDER_LABEL.azure, webBase: `https://dev.azure.com/${path}` };
  }
  if (lower.startsWith("ssh.")) host = host.slice(4);
  raw = `https://${host}/${path}`;
  return { provider, label: PROVIDER_LABEL[provider], webBase: raw };
}

/** Remoto para links: o do upstream da branch atual, depois origin, depois o 1º. */
export function pickHostingRemote(remotes: readonly GraphRemote[], upstream: string | null | undefined): HostingRemote | null {
  const upstreamRemote = upstream?.includes("/") ? upstream.slice(0, upstream.indexOf("/")) : null;
  const ordered = [
    ...remotes.filter((r) => r.name === upstreamRemote),
    ...remotes.filter((r) => r.name === "origin"),
    ...remotes,
  ];
  for (const remote of ordered) {
    const hosting = hostingFromRemote(remote.url);
    if (hosting) return hosting;
  }
  return null;
}

export function commitWebUrl(hosting: HostingRemote, hash: string): string {
  switch (hosting.provider) {
    case "gitlab":
      return `${hosting.webBase}/-/commit/${hash}`;
    case "bitbucket":
      return `${hosting.webBase}/commits/${hash}`;
    default:
      return `${hosting.webBase}/commit/${hash}`;
  }
}

export function pullRequestWebUrl(hosting: HostingRemote, pr: number): string {
  switch (hosting.provider) {
    case "gitlab":
      return `${hosting.webBase}/-/merge_requests/${pr}`;
    case "bitbucket":
      return `${hosting.webBase}/pull-requests/${pr}`;
    case "azure":
      return `${hosting.webBase}/pullrequest/${pr}`;
    default:
      return `${hosting.webBase}/pull/${pr}`;
  }
}

// ---------------------------------------------------------------- mensagem

const TRAILER = /^([A-Za-z][A-Za-z0-9-]*): .+$/;

/** Mensagem → corpo sem o assunto e sem o bloco final de trailers. */
export function splitCommitMessage(message: string): { subject: string; body: string; trailers: string[] } {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const subject = lines[0] ?? "";
  const rest = lines.slice(1);
  // Último parágrafo só com "Chave: valor" = trailers (git interpret-trailers).
  let end = rest.length;
  while (end > 0 && rest[end - 1].trim() === "") end--;
  let start = end;
  while (start > 0 && rest[start - 1].trim() !== "" && TRAILER.test(rest[start - 1].trim())) start--;
  const isBlock = start < end && (start === 0 || rest[start - 1].trim() === "");
  const trailers = isBlock ? rest.slice(start, end).map((l) => l.trim()) : [];
  const bodyLines = isBlock ? rest.slice(0, start) : rest.slice(0, end);
  return { subject, body: bodyLines.join("\n").trim(), trailers };
}

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "issue"; text: string; number: number }
  | { kind: "link"; text: string; href: string };

export type MessageBlock =
  | { kind: "paragraph"; inline: InlineToken[] }
  | { kind: "list"; items: InlineToken[][] };

/** Inline: `código`, **negrito**, #123 e URLs http(s). Sem HTML. */
export function parseInline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s)]+)|(^|[\s(])#(\d+)\b/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let start = m.index;
    if (m[5] !== undefined) start += m[4].length;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "bold", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "link", text: m[3], href: m[3] });
    else out.push({ kind: "issue", text: `#${m[5]}`, number: Number(m[5]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** Markdown leve do corpo: parágrafos e listas (`-`, `*`, `1.`). */
export function parseMessageBody(body: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list?.length) blocks.push({ kind: "list", items: list.map(parseInline) });
    list = null;
  };
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list = list ?? [];
      list.push(bullet[1]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (list && /^\s{2,}\S/.test(raw)) {
      // Continuação indentada do item.
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** "4 arquivos alterados, 93 inserções(+), 53 exclusões(-)". */
export function formatCommitStats(files: number, additions: number, deletions: number): string {
  const parts = [`${files} ${files === 1 ? "arquivo alterado" : "arquivos alterados"}`];
  if (additions) parts.push(`${additions} ${additions === 1 ? "inserção" : "inserções"}(+)`);
  if (deletions) parts.push(`${deletions} ${deletions === 1 ? "exclusão" : "exclusões"}(-)`);
  return parts.join(", ");
}

// ---------------------------------------------------------------- linhagem

export interface LineageSummary {
  /** "feat/x divergiu de main em abc1234 (há 3 dias)". */
  divergence: string | null;
  /** "5 commits à frente, 2 atrás de main". */
  distance: string;
  /** "mesclada em main via PR #108" / "integrada em main (fast-forward)". */
  merged: string | null;
  pr: number | null;
  mergeHash: string | null;
}

export function summarizeLineage(lineage: BranchLineage, relative: (unixMs: number) => string): LineageSummary {
  const short = (h: string | null) => (h ? h.slice(0, 7) : "");
  if (lineage.isBase) {
    return { divergence: null, distance: `${lineage.reference} é a branch base`, merged: null, pr: null, mergeHash: null };
  }
  const divergence = lineage.mergeBase
    ? `${lineage.reference} divergiu de ${lineage.base} em ${short(lineage.mergeBase)}${
        lineage.mergeBaseTime ? ` (${relative(lineage.mergeBaseTime * 1000)})` : ""
      }`
    : `${lineage.reference} não tem histórico em comum com ${lineage.base}`;
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const m = lineage.mergedInto;
  const distance =
    m && !m.fastForward
      ? `${n(m.commits, "commit levado", "commits levados")} pelo merge`
      : lineage.ahead === 0 && lineage.behind === 0
        ? `igual a ${lineage.base}`
        : `${n(lineage.ahead, "commit", "commits")} à frente, ${lineage.behind} atrás de ${lineage.base}`;
  const merged = m
    ? m.fastForward
      ? `integrada em ${lineage.base} sem merge (fast-forward) em ${short(m.hash)}`
      : `mesclada em ${lineage.base}${m.pr ? ` via PR #${m.pr}` : ""} em ${short(m.hash)}${
          m.time ? ` (${relative(m.time * 1000)})` : ""
        }`
    : null;
  return { divergence, distance, merged, pr: m?.pr ?? null, mergeHash: m?.hash ?? null };
}

// ---------------------------------------------------------------- árvore

export interface FileTreeEntry<T> {
  kind: "folder" | "file";
  /** Caminho (pasta: prefixo comprimido, ex. `src/git`). */
  path: string;
  label: string;
  depth: number;
  file?: T;
  /** Pasta: quantos arquivos abaixo. */
  count?: number;
}

/**
 * Lista de arquivos → linhas de árvore (pastas comprimidas como no VS Code:
 * `src/components/git` vira uma linha só quando cada nível tem um filho).
 * Pastas recolhidas (`collapsed`) escondem os descendentes.
 */
export function buildFileTree<T extends { path: string }>(files: readonly T[], collapsed: ReadonlySet<string> = new Set()): FileTreeEntry<T>[] {
  interface Node {
    name: string;
    path: string;
    dirs: Map<string, Node>;
    files: T[];
  }
  const root: Node = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, path, dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  const countOf = (n: Node): number => n.files.length + [...n.dirs.values()].reduce((s, d) => s + countOf(d), 0);
  const out: FileTreeEntry<T>[] = [];
  const walk = (node: Node, depth: number) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (let dir of dirs) {
      let label = dir.name;
      while (dir.files.length === 0 && dir.dirs.size === 1) {
        dir = [...dir.dirs.values()][0];
        label = `${label}/${dir.name}`;
      }
      out.push({ kind: "folder", path: dir.path, label, depth, count: countOf(dir) });
      if (!collapsed.has(dir.path)) walk(dir, depth + 1);
    }
    const sorted = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
    for (const file of sorted) {
      out.push({ kind: "file", path: file.path, label: file.path.slice(file.path.lastIndexOf("/") + 1), depth, file });
    }
  };
  walk(root, 0);
  return out;
}

/** First-parent a partir de `tip` dentro das linhas carregadas (base = tronco). */
export function firstParentChain(tip: string, parentsOf: (hash: string) => string[] | undefined, limit = 5000): string[] {
  const out: string[] = [];
  let cur: string | undefined = tip;
  const seen = new Set<string>();
  while (cur && !seen.has(cur) && out.length < limit) {
    seen.add(cur);
    out.push(cur);
    cur = parentsOf(cur)?.[0];
  }
  return out;
}
