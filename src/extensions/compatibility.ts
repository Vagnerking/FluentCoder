/**
 * Classificador de compatibilidade de extensões VS Code com ESTE host
 * (shim `require('vscode')` de tools/ext-host + o que o app honra).
 *
 * Entrada: manifesto (`package.json`) da versão, plataforma do pacote e deste
 * computador, versão da API do shim (`capabilities.hostVersion`) e — quando a
 * extensão já está instalada — a varredura estática do código Node
 * (`vscode.<api>` referenciados, feita no Rust). Saída: veredito + motivos.
 *
 *   compatible   — nada encontrado que falte; código analisado
 *   partial      — roda, com limitações listadas
 *   incompatible — algo essencial falta (motivos "blocker")
 *   unknown      — "Não avaliada": sem dados para afirmar (ex.: código ainda
 *                  não analisado). NUNCA vira positivo por omissão.
 *
 * Funções puras (sem React/Tauri): testadas em compatibility.test.ts. A tabela
 * do shim (`capabilities.json`) é gerada por
 * `node tools/ext-host/discovery/capabilities.js`.
 */

export type Verdict = "compatible" | "partial" | "incompatible" | "unknown";
export type Severity = "blocker" | "limit" | "info";
export type CapState = "implemented" | "partial" | "stub";
export type PointState = "supported" | "partial" | "ignored" | "unsupported";

export interface Reason {
  severity: Severity;
  code: string;
  message: string;
}

export interface Capabilities {
  hostVersion: string;
  proposedPrefixes: string[];
  apis: Record<string, CapState | string>;
  notes: Record<string, string>;
  contributionPoints: Record<string, { state: PointState | string; note?: string }>;
  activationEvents: Record<string, { state: PointState | string; note?: string }>;
}

export interface ApiScan {
  file?: string | null;
  bindings: number;
  paths: [string, number][];
  /** Caminhos chamados (`x.y(`); sem a lista, todo ausente conta como chamado. */
  called?: string[];
  filesWithApi?: number;
  truncated?: boolean;
  error?: string | null;
}

export interface ClassifyInput {
  manifest: Record<string, unknown> | null | undefined;
  /** Plataforma do pacote (`universal`, `linux-x64`, `web`…); vazio = universal. */
  targetPlatform?: string | null;
  /** Plataforma deste computador (`linux-x64`…). */
  hostPlatform: string;
  /** Varredura do código; null/undefined = ainda não analisado (não instalada). */
  apiScan?: ApiScan | null;
  /** Ids (minúsculos) instalados — para `extensionDependencies`. */
  installedIds?: ReadonlySet<string>;
  /** Claude Code / Codex: validadas com o host real (flows-check). */
  builtin?: boolean;
}

export interface ContributionItem {
  key: string;
  label: string;
  detail: string;
  state: PointState | "code";
}

export interface CompatibilityReport {
  verdict: Verdict;
  reasons: Reason[];
  /** O que a extensão contribui (resumo "tipo permissões"). */
  contributes: ContributionItem[];
  analyzed: { manifest: boolean; code: boolean };
  hostVersion: string;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  compatible: "Compatível",
  partial: "Parcial",
  incompatible: "Incompatível",
  unknown: "Não avaliada",
};

/** Vereditos que liberam a execução no host (o portão). */
export const RUNNABLE: ReadonlySet<Verdict> = new Set<Verdict>(["compatible", "partial"]);

// ------------------------------------------------------------------- semver

type Ver = [number, number, number];

function parseVer(s: string): Ver | null {
  const m = /^\s*v?(\d+)\.(\d+|x|\*)(?:\.(\d+|x|\*))?(?:-[\w.]+)?\s*$/i.exec(s);
  if (!m) return null;
  const n = (x: string | undefined) => (x === undefined || x === "x" || x === "*" ? 0 : parseInt(x, 10));
  return [n(m[1]), n(m[2]), n(m[3])];
}

function cmp(a: Ver, b: Ver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * `version` satisfaz a faixa de `engines.vscode`? (`^1.94.0`, `>=1.80.0`,
 * `~1.2.3`, `1.x`, `*`, combinações com espaço e `||`). null = faixa não reconhecida.
 */
export function satisfiesEngine(version: string, range: string): boolean | null {
  const v = parseVer(version);
  if (!v) return null;
  const alternatives = range.split("||").map((r) => r.trim()).filter(Boolean);
  if (!alternatives.length) return null;
  let anyParsed = false;
  for (const alt of alternatives) {
    const comps = alt.split(/\s+/).filter(Boolean);
    let ok = true;
    let parsed = true;
    for (const c of comps) {
      const r = checkComparator(v, c);
      if (r === null) {
        parsed = false;
        break;
      }
      if (!r) ok = false;
    }
    if (!parsed) continue;
    anyParsed = true;
    if (ok) return true;
  }
  return anyParsed ? false : null;
}

function checkComparator(v: Ver, c: string): boolean | null {
  if (c === "*" || c === "x" || c === "X") return true;
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(c);
  if (!m) return null;
  const op = m[1] ?? "";
  const raw = m[2];
  const t = parseVer(raw);
  if (!t) return null;
  const wildMinor = /^\s*v?\d+\.(x|\*)/i.test(raw) || /^\s*v?\d+$/.test(raw);
  const wildPatch = /^\s*v?\d+\.\d+(\.(x|\*))?(?:-[\w.]+)?\s*$/i.test(raw) && !/^\s*v?\d+\.\d+\.\d+/.test(raw);
  switch (op) {
    case "^":
      // Semântica do VS Code: ^1.94.0 = >=1.94.0 <2.0.0 (^0.y.z = <0.(y+1).0).
      if (cmp(v, t) < 0) return false;
      return t[0] > 0 ? v[0] === t[0] : v[0] === 0 && v[1] === t[1];
    case "~":
      return cmp(v, t) >= 0 && v[0] === t[0] && v[1] === t[1];
    case ">=":
      return cmp(v, t) >= 0;
    case ">":
      return cmp(v, t) > 0;
    case "<=":
      return cmp(v, t) <= 0;
    case "<":
      return cmp(v, t) < 0;
    default:
      if (wildMinor) return v[0] === t[0];
      if (wildPatch) return v[0] === t[0] && v[1] === t[1];
      return cmp(v, t) === 0;
  }
}

// ---------------------------------------------------------------- helpers

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function listNames(names: string[], max = 5): string {
  const shown = names.slice(0, max).map((n) => `\`${n}\``).join(", ");
  return names.length > max ? `${shown} e mais ${names.length - max}` : shown;
}

/** APIs que, implementadas, mostram que a extensão tem função própria aqui. */
const FEATURE_APIS = new Set([
  "commands.registerCommand",
  "commands.registerTextEditorCommand",
  "window.createWebviewPanel",
  "window.registerWebviewViewProvider",
  "window.registerCustomEditorProvider",
  "window.createTextEditorDecorationType",
  "window.createStatusBarItem",
  "window.createTerminal",
  "window.createOutputChannel",
  "languages.registerCodeLensProvider",
  "languages.createDiagnosticCollection",
  "comments.createCommentController",
  "tasks.registerTaskProvider",
  "workspace.registerFileSystemProvider",
  "workspace.registerTextDocumentContentProvider",
]);

const CONTRIB_LABEL: Record<string, string> = {
  commands: "Comandos",
  configuration: "Configurações",
  keybindings: "Atalhos",
  menus: "Menus",
  views: "Views",
  viewsContainers: "Contêineres de views",
  customEditors: "Editores personalizados",
  languages: "Linguagens",
  grammars: "Gramáticas",
  snippets: "Snippets",
  themes: "Temas de cor",
  iconThemes: "Temas de ícones",
  debuggers: "Depuradores",
  notebooks: "Notebooks",
  taskDefinitions: "Tipos de tarefa",
  jsonValidation: "Validação JSON",
  authentication: "Autenticação",
  terminal: "Perfis de terminal",
  walkthroughs: "Guias",
};

function countOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (isObj(v)) {
    // configuration: { properties } ou [{ properties }]; menus/views: { loc: [] }
    if (isObj(v.properties)) return Object.keys(v.properties).length;
    return Object.values(v).reduce<number>((n, x) => n + (Array.isArray(x) ? x.length : isObj(x) ? 1 : 0), 0);
  }
  return v ? 1 : 0;
}

function configCount(v: unknown): number {
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + (isObj(x) && isObj(x.properties) ? Object.keys(x.properties).length : 0), 0);
  return countOf(v);
}

/** Resumo do que a extensão contribui (para o painel de detalhes). */
export function summarizeContributions(manifest: Record<string, unknown>, caps: Capabilities): ContributionItem[] {
  const out: ContributionItem[] = [];
  if (typeof manifest.main === "string") out.push({ key: "main", label: "Código Node", detail: `executa ${manifest.main} no host de extensões (processo Node local, sem sandbox)`, state: "code" });
  else if (typeof manifest.browser === "string") out.push({ key: "browser", label: "Código web", detail: `só ${manifest.browser} (navegador)`, state: "unsupported" });
  const contributes = isObj(manifest.contributes) ? manifest.contributes : {};
  for (const [key, value] of Object.entries(contributes)) {
    const point = caps.contributionPoints[key];
    const n = key === "configuration" ? configCount(value) : countOf(value);
    const state = (point?.state as PointState | undefined) ?? "unsupported";
    if (state === "ignored" && !CONTRIB_LABEL[key]) continue;
    out.push({ key, label: CONTRIB_LABEL[key] ?? key, detail: `${n} ${n === 1 ? "item" : "itens"}${point?.note ? ` · ${point.note}` : ""}`, state });
  }
  const deps = strList(manifest.extensionDependencies);
  if (deps.length) out.push({ key: "extensionDependencies", label: "Depende de", detail: deps.join(", "), state: "partial" });
  const pack = strList(manifest.extensionPack);
  if (pack.length) out.push({ key: "extensionPack", label: "Pacote de extensões", detail: pack.join(", "), state: "partial" });
  return out;
}

// --------------------------------------------------------------- classificar

export function classify(input: ClassifyInput, caps: Capabilities): CompatibilityReport {
  const reasons: Reason[] = [];
  const add = (severity: Severity, code: string, message: string) => reasons.push({ severity, code, message });
  const m = input.manifest;
  if (!isObj(m)) {
    add("info", "no-manifest", "Manifesto (package.json) indisponível no catálogo: não dá para avaliar.");
    return { verdict: "unknown", reasons, contributes: [], analyzed: { manifest: false, code: false }, hostVersion: caps.hostVersion };
  }
  const contributes = isObj(m.contributes) ? m.contributes : {};
  const hasMain = typeof m.main === "string" && m.main.length > 0;
  const hasBrowser = typeof m.browser === "string" && m.browser.length > 0;

  // engines.vscode × versão da API do shim
  const engines = isObj(m.engines) ? m.engines : {};
  const range = typeof engines.vscode === "string" ? engines.vscode : "";
  if (!range) add("blocker", "no-engine", "Sem `engines.vscode` no manifesto: não é uma extensão VS Code válida.");
  else {
    const ok = satisfiesEngine(caps.hostVersion, range);
    if (ok === false) add("blocker", "engine", `Requer VS Code ${range}; este host implementa a API ${caps.hostVersion}.`);
    else if (ok === null) add("limit", "engine-unknown", `Faixa de versão \`${range}\` não reconhecida; o host implementa a API ${caps.hostVersion}.`);
  }

  // plataforma
  const tp = (input.targetPlatform || "universal").toLowerCase();
  if (tp === "web") add("blocker", "web-only", "Pacote só para VS Code na web.");
  else if (tp !== "universal" && tp !== input.hostPlatform) add("blocker", "platform", `Pacote para ${tp}; este computador é ${input.hostPlatform}.`);

  // ponto de entrada
  if (!hasMain && hasBrowser) add("blocker", "browser-only", "Só tem código para navegador (`browser`); este host roda código Node (`main`).");

  // propostas
  const proposals = strList(m.enabledApiProposals);
  if (proposals.length) add("limit", "proposed-api", `Declara APIs propostas (${listNames(proposals)}): elas não existem neste host e a extensão precisa tratar a ausência.`);

  // contribuições
  let supportedContrib = 0;
  const unsupportedContrib: string[] = [];
  for (const [key, value] of Object.entries(contributes)) {
    const point = caps.contributionPoints[key];
    const state = point?.state ?? "unknown";
    if (key === "views") {
      const views = isObj(value) ? Object.values(value).flatMap((l) => (Array.isArray(l) ? l : [])) : [];
      const tree = views.filter((v) => isObj(v) && v.type !== "webview").map((v) => String((v as Record<string, unknown>).name ?? (v as Record<string, unknown>).id ?? "?"));
      const web = views.length - tree.length;
      if (web > 0) supportedContrib++;
      if (tree.length) add("limit", "tree-views", `Views em árvore não são exibidas aqui: ${listNames(tree)}.`);
      continue;
    }
    if (key === "menus" && isObj(value)) {
      const honored = new Set(["commandPalette", "editor/title"]);
      const ignored = Object.keys(value).filter((k) => !honored.has(k) && !k.startsWith("comments/"));
      if (ignored.length) add("info", "menus", `Menus ${listNames(ignored)} não aparecem no app (os comandos seguem na Paleta).`);
      continue;
    }
    if (state === "supported" || state === "partial") {
      if (key !== "configuration") supportedContrib++;
      if (state === "partial" && point?.note && key !== "viewsContainers") add("info", `contrib-${key}`, `${CONTRIB_LABEL[key] ?? key}: ${point.note}.`);
    } else if (state === "unsupported") {
      unsupportedContrib.push(key);
    } else if (state === "unknown") {
      add("info", `contrib-unknown-${key}`, `Ponto de contribuição \`${key}\` não avaliado.`);
    }
  }
  if (unsupportedContrib.length) {
    const notes = unsupportedContrib.map((k) => caps.contributionPoints[k]?.note).filter(Boolean);
    const msg = `Contribui ${listNames(unsupportedContrib.map((k) => CONTRIB_LABEL[k] ?? k))}, que o Fluent Coder não usa${notes.length ? ` (${notes[0]})` : ""}.`;
    // Sem código e sem nada suportado: a extensão não faz nada aqui.
    if (!hasMain && supportedContrib === 0) add("blocker", "unsupported-contrib", msg);
    else add("limit", "unsupported-contrib", msg);
  }
  if (!hasMain && !hasBrowser && supportedContrib === 0 && !unsupportedContrib.length) {
    add("blocker", "nothing", "Sem código e sem contribuições que o Fluent Coder use.");
  }

  // eventos de ativação
  if (hasMain) {
    const events = strList(m.activationEvents);
    const hasCommands = Array.isArray(contributes.commands) && contributes.commands.length > 0;
    let canActivate = hasCommands || (isObj(contributes.customEditors) || Array.isArray(contributes.customEditors));
    const unsupportedEv: string[] = [];
    for (const ev of events) {
      const kind = ev.split(":")[0];
      const st = caps.activationEvents[kind]?.state;
      if (st === "supported" || st === "partial") {
        if (kind !== "onView" || hasWebviewViews(contributes)) canActivate = true;
      } else if (st === "unsupported") unsupportedEv.push(ev);
    }
    if (unsupportedEv.length) {
      const msg = `Eventos de ativação não disparados aqui: ${listNames(unsupportedEv)}.`;
      add(canActivate ? "limit" : "blocker", "activation", canActivate ? `${msg} A extensão ativa por outro caminho (comando, view ou startup).` : `${msg} Ela nunca seria ativada neste host.`);
    } else if (!canActivate && !hasWebviewViews(contributes) && events.length === 0) {
      add("limit", "activation-none", "Nenhum evento de ativação que este host dispare (ativa só por comando contribuído).");
    }
  }

  // dependências
  const deps = strList(m.extensionDependencies).map((d) => d.toLowerCase());
  const missing = deps.filter((d) => !input.installedIds?.has(d));
  if (missing.length) add("blocker", "dependencies", `Depende de ${listNames(missing)}, que não está instalada.`);
  else if (deps.length) add("info", "dependencies-ok", `Depende de ${listNames(deps)} (instalada).`);
  const pack = strList(m.extensionPack);
  if (pack.length) add("info", "extension-pack", `Pacote de extensões: as ${pack.length} extensões do pacote não são instaladas automaticamente.`);

  // workspaces virtuais/remotos
  const capsField = isObj(m.capabilities) ? m.capabilities : {};
  if (isObj(capsField.virtualWorkspaces) && capsField.virtualWorkspaces.supported === "limited") add("info", "virtual-ws", "Declara suporte limitado a workspaces virtuais.");
  const kinds = strList(m.extensionKind);
  if (kinds.length === 1 && kinds[0] === "workspace" && hasMain) add("info", "kind-workspace", "Feita para rodar no lado do workspace (remoto); aqui roda local.");

  // código (varredura estática do bundle)
  let codeAnalyzed = !hasMain; // sem `main` não há código Node a analisar
  if (hasMain) {
    const scan = input.apiScan;
    if (!scan) add("info", "code-not-analyzed", "Código ainda não analisado: instale para verificar as APIs usadas.");
    else if (scan.error) add("info", "code-error", `Não foi possível analisar o código: ${scan.error}.`);
    else if (scan.bindings === 0) add("info", "code-opaque", "Não encontramos `require(\"vscode\")` no código (bundle não analisável): não dá para afirmar a compatibilidade.");
    else {
      codeAnalyzed = !scan.truncated;
      if (scan.truncated) add("info", "code-truncated", "Análise do código incompleta (pacote grande demais).");
      classifyApis(scan, caps, add, supportedContrib > 0);
    }
  }

  if (input.builtin) add("info", "builtin", "Embutida: validada com o host real (fluxos do Claude Code/Codex em `flows-check`).");

  const blockers = reasons.some((r) => r.severity === "blocker");
  const limits = reasons.some((r) => r.severity === "limit");
  let verdict: Verdict;
  if (blockers) verdict = "incompatible";
  else if (!codeAnalyzed) verdict = "unknown";
  else if (limits) verdict = "partial";
  else verdict = "compatible";
  // Ordem: bloqueios, limitações, informações.
  const order: Record<Severity, number> = { blocker: 0, limit: 1, info: 2 };
  reasons.sort((a, b) => order[a.severity] - order[b.severity]);
  return { verdict, reasons, contributes: summarizeContributions(m, caps), analyzed: { manifest: true, code: codeAnalyzed }, hostVersion: caps.hostVersion };
}

function hasWebviewViews(contributes: Record<string, unknown>): boolean {
  const views = isObj(contributes.views) ? Object.values(contributes.views).flatMap((l) => (Array.isArray(l) ? l : [])) : [];
  return views.some((v) => isObj(v) && v.type === "webview");
}

function classifyApis(scan: ApiScan, caps: Capabilities, add: (s: Severity, c: string, m: string) => void, hasSupportedContrib: boolean): void {
  const proposed: string[] = [];
  const absent: string[] = [];
  const absentRead: string[] = [];
  const called = scan.called ? new Set(scan.called) : null;
  const partial: string[] = [];
  const stubRegs: string[] = [];
  const stubEvents: string[] = [];
  let features = 0;
  const namespaces = new Set(Object.keys(caps.apis).filter((k) => k.includes(".")).map((k) => k.split(".")[0]));
  for (const [path] of scan.paths) {
    const [first, second] = path.split(".");
    // `vscode.window` sozinho (apelido de namespace): os membros vêm à parte.
    // `vscode.version.split`: membro de um VALOR (string), não API.
    if (second && /^[a-z]/.test(first) && !namespaces.has(first) && caps.apis[first] !== undefined) continue;
    if (!second && /^[a-z]/.test(first)) {
      if (!namespaces.has(first) && caps.apis[first] === undefined && !caps.proposedPrefixes.some((p) => p.startsWith(`${first}.`))) absent.push(first);
      else if (caps.proposedPrefixes.some((p) => p === `${first}.`)) proposed.push(first);
      continue;
    }
    if (caps.proposedPrefixes.some((p) => path.startsWith(p))) {
      proposed.push(path);
      continue;
    }
    const state = caps.apis[path];
    if (state === undefined) {
      // Classe/enum ausente, namespace desconhecido ou membro CHAMADO → erro certo;
      // só lido (`if (window.x)`) → fica `undefined`.
      if (/^[A-Z]/.test(first) || !namespaces.has(first) || !called || called.has(path)) absent.push(path);
      else absentRead.push(path);
      continue;
    }
    if (FEATURE_APIS.has(path) && state !== "stub") features++;
    if (state === "partial") partial.push(path);
    else if (state === "stub") {
      if (/^[a-z]+\.on[A-Z]/.test(path)) stubEvents.push(path);
      else stubRegs.push(path);
    }
  }
  if (absent.length) add("blocker", "api-absent", `Usa APIs que não existem neste host: ${listNames(absent)}. Chamá-las lança erro.`);
  if (absentRead.length) add("limit", "api-absent-read", `Lê propriedades que não existem neste host (ficam \`undefined\`): ${listNames(absentRead)}.`);
  if (proposed.length) add("limit", "api-proposed", `Usa APIs propostas ausentes de propósito: ${listNames(proposed)}.`);
  if (stubRegs.length) {
    const note = caps.notes[stubRegs[0]];
    const msg = `Usa APIs que existem mas são inertes neste host: ${listNames(stubRegs)}${note ? ` — ${note}` : ""}.`;
    // Nada além de stubs: a função principal da extensão não existe neste host.
    if (features === 0 && !hasSupportedContrib) add("blocker", "api-stub-main", `${msg} Nenhuma outra função da extensão funciona aqui.`);
    else add("limit", "api-stub", msg);
  }
  if (partial.length) add("limit", "api-partial", `APIs com suporte parcial: ${partial.map((p) => `\`${p}\`${caps.notes[p] ? ` (${caps.notes[p]})` : ""}`).slice(0, 4).join(", ")}.`);
  if (stubEvents.length) add("info", "api-stub-events", `Eventos que nunca disparam aqui: ${listNames(stubEvents)}.`);
}
