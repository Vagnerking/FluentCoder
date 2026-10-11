/**
 * Estado da view Extensões (módulo único por janela, `useSyncExternalStore`):
 * instaladas (app + VS Code), relatórios de compatibilidade, fontes,
 * atualizações (checagem no startup com throttle de 12 h + sob demanda) e as
 * operações (instalar, atualizar, remover, habilitar, importar).
 *
 * Depois de qualquer mudança o host em execução relê a lista
 * (`refreshHostedExtensions`) — extensão nova roda sem reiniciar o app. Uma
 * extensão que JÁ estava ativa e mudou (atualizada, desabilitada, removida)
 * só troca com "Reiniciar Host de Extensões": `needsRestart` sinaliza na UI.
 */
import { useSyncExternalStore } from "react";
import { getSetting } from "../../settings/instance";
import {
  extensionsApi,
  pruneUpdates,
  readUpdateCache,
  shouldCheckUpdates,
  writeUpdateCache,
  type CatalogSource,
  type InstalledInfo,
  type InstallProgress,
  type LocalDetails,
  type UpdateInfo,
} from "../../extensions/catalog";
import { classify, type CompatibilityReport } from "../../extensions/compatibility";
import { classifyPreview } from "../../extensions/preview";
import { CAPABILITIES } from "../../extensions/capabilities";
import { isExtensionActive, refreshHostedExtensions, restartExtensionHost } from "../../extensions";
import { listen } from "@tauri-apps/api/event";

export interface ExtensionsState {
  loaded: boolean;
  loading: boolean;
  platform: string;
  installed: InstalledInfo[];
  reports: Record<string, CompatibilityReport>;
  details: Record<string, LocalDetails>;
  sources: CatalogSource[];
  updates: UpdateInfo[];
  lastUpdateCheck: number | null;
  checkingUpdates: boolean;
  /** Operação em andamento por id (texto curto para a UI). */
  busy: Record<string, string>;
  progress: Record<string, InstallProgress>;
  /** Ativas no host que mudaram: precisam de "Reiniciar Host de Extensões". */
  needsRestart: string[];
  /** Prévia de compatibilidade dos resultados da loja (antes de instalar), por `previewKey`. */
  previews: Record<string, PreviewState>;
  error: string | null;
  /** O erro veio da listagem: a view oferece "Tentar novamente". */
  errorRetry: boolean;
  notice: string | null;
}

const cache = readUpdateCache();
let state: ExtensionsState = {
  loaded: false,
  loading: false,
  platform: "",
  installed: [],
  reports: {},
  details: {},
  sources: [],
  updates: cache.updates,
  lastUpdateCheck: cache.at,
  checkingUpdates: false,
  busy: {},
  progress: {},
  needsRestart: [],
  previews: {},
  error: null,
  errorRetry: false,
  notice: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<ExtensionsState> | ((s: ExtensionsState) => Partial<ExtensionsState>)): void {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const l of [...listeners]) l();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getState(): ExtensionsState {
  return state;
}

export function useExtensionsState(): ExtensionsState {
  return useSyncExternalStore(subscribe, getState, getState);
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

let progressListening = false;
function listenProgress(): void {
  if (progressListening) return;
  progressListening = true;
  void listen<InstallProgress>("extensions://progress", (e) => {
    set((s) => ({ progress: { ...s.progress, [e.payload.id]: e.payload } }));
  }).catch(() => {
    progressListening = false;
  });
}

// ------------------------------------------------------------ carregar/avaliar

let loadPromise: Promise<void> | null = null;

/**
 * Carrega (ou recarrega) instaladas + fontes. NÃO avalia todas: só entram na
 * fila de fundo as que o portão precisa (gerenciadas pelo app e as do VS Code
 * habilitadas) e cujo veredito gravado não vale para esta versão/shim; as
 * demais são avaliadas quando o card aparece (`requestEvaluate`) ou os
 * detalhes abrem.
 */
export function loadExtensions(force = false): Promise<void> {
  if (loadPromise && !force) return loadPromise;
  listenProgress();
  set({ loading: true, error: null, errorRetry: false });
  loadPromise = (async () => {
    try {
      const [paths, installed, sources] = await Promise.all([extensionsApi.paths(), extensionsApi.list(), extensionsApi.sources()]);
      set((s) => ({ platform: paths.platform, installed, sources, loaded: true, updates: pruneUpdates(s.updates, installed) }));
      evaluateBackground();
    } catch (err) {
      loadPromise = null;
      set({ error: `Não foi possível listar as extensões: ${msg(err)}`, errorRetry: true });
    } finally {
      set({ loading: false });
    }
  })();
  return loadPromise;
}

const evaluated = new Map<string, string>(); // id → "versão@host@origem" já avaliada

/** O portão gravado no índice vale para esta versão e este shim? */
export function gateCurrent(info: Pick<InstalledInfo, "gate" | "version">): boolean {
  return !!info.gate && info.gate.version === info.version && info.gate.hostVersion === CAPABILITIES.hostVersion;
}

/** O portão importa para o host: gerenciada pelo app, embutida ou do VS Code habilitada. */
const gateMatters = (info: InstalledInfo) => info.location === "app" || info.enabled || info.builtin;

// Fila de avaliação (concorrência 2) — cada item lê a pasta da extensão uma vez
// (varredura com cache no Rust por mtime/versão).
const EVAL_CONCURRENCY = 2;
const evalQueue: InstalledInfo[] = [];
const evalQueued = new Set<string>();
let evalActive = 0;

function pumpEvaluations(): void {
  while (evalActive < EVAL_CONCURRENCY && evalQueue.length) {
    const info = evalQueue.shift()!;
    evalActive++;
    void evaluate(info)
      .catch(() => {})
      .finally(() => {
        evalQueued.delete(info.id);
        evalActive--;
        pumpEvaluations();
      });
  }
}

/** Pede a avaliação de uma instalada (card visível, detalhes) — dedup, sem bloquear a UI. */
export function requestEvaluate(info: InstalledInfo, front = false): void {
  const key = `${info.version}@${CAPABILITIES.hostVersion}@${info.location}`;
  if ((evaluated.get(info.id) === key && state.reports[info.id]) || evalQueued.has(info.id)) return;
  evalQueued.add(info.id);
  if (front) evalQueue.unshift(info);
  else evalQueue.push(info);
  pumpEvaluations();
}

/** Fundo: só o que o portão precisa e está desatualizado. */
function evaluateBackground(): void {
  for (const info of state.installed) if (gateMatters(info) && !gateCurrent(info)) requestEvaluate(info);
}

// Vereditos gravados em LOTE (uma escrita do índice + um refresh do host).
const pendingGates = new Map<string, { verdict: string; version: string; hostVersion: string }>();
let gateTimer: ReturnType<typeof setTimeout> | null = null;
let gateFlush: Promise<void> | null = null;

/** Grava os vereditos pendentes agora (antes de habilitar/liberar). */
export async function flushGates(): Promise<void> {
  if (gateTimer) clearTimeout(gateTimer);
  gateTimer = null;
  if (gateFlush) await gateFlush;
  if (!pendingGates.size) return;
  const gates = [...pendingGates].map(([id, gate]) => ({ id, gate }));
  pendingGates.clear();
  gateFlush = (async () => {
    await extensionsApi.setGates(gates).catch(() => {});
    await syncHost();
  })();
  try {
    await gateFlush;
  } finally {
    gateFlush = null;
  }
}

function queueGate(id: string, gate: { verdict: string; version: string; hostVersion: string }): void {
  pendingGates.set(id, gate);
  if (gateTimer) clearTimeout(gateTimer);
  gateTimer = setTimeout(() => void flushGates(), 400);
}

/** Classifica uma instalada (com a varredura do código) e agenda o veredito do portão. */
export async function evaluate(info: InstalledInfo): Promise<CompatibilityReport> {
  const key = `${info.version}@${CAPABILITIES.hostVersion}@${info.location}`;
  if (evaluated.get(info.id) === key && state.reports[info.id]) return state.reports[info.id];
  const details = await extensionsApi.localDetails(info.id, info.path);
  const report = classify(
    {
      manifest: info.manifest,
      targetPlatform: info.targetPlatform,
      hostPlatform: state.platform,
      apiScan: details.apiScan,
      installedIds: new Set(state.installed.map((i) => i.id)),
      builtin: info.builtin,
    },
    CAPABILITIES,
  );
  evaluated.set(info.id, key);
  set((s) => ({ reports: { ...s.reports, [info.id]: report }, details: { ...s.details, [info.id]: details } }));
  const g = info.gate;
  const stale = !g || g.verdict !== report.verdict || g.version !== info.version || g.hostVersion !== CAPABILITIES.hostVersion;
  // Só grava quando o portão importa (do VS Code e desabilitada: nada a liberar;
  // grava quando o usuário habilitar — `ensureGate`).
  if (stale && gateMatters(info)) queueGate(info.id, { verdict: report.verdict, version: info.version, hostVersion: CAPABILITIES.hostVersion });
  return report;
}

/** Avalia e grava o portão AGORA (antes de habilitar ou liberar). */
async function ensureGate(info: InstalledInfo): Promise<void> {
  const report = await evaluate(info);
  if (!gateCurrent(info) || info.gate?.verdict !== report.verdict) {
    pendingGates.set(info.id, { verdict: report.verdict, version: info.version, hostVersion: CAPABILITIES.hostVersion });
  }
  await flushGates();
}

/** O host em execução relê a lista (extensão nova fica carregável sem reiniciar). */
async function syncHost(): Promise<void> {
  try {
    await refreshHostedExtensions();
  } catch {
    /* host indisponível: lê na próxima subida */
  }
}

async function reloadInstalled(): Promise<void> {
  const installed = await extensionsApi.list();
  set((s) => ({ installed, updates: pruneUpdates(s.updates, installed) }));
  writeUpdateCache(state.lastUpdateCheck ?? Date.now(), state.updates);
  evaluateBackground();
  await syncHost();
}

function markRestart(id: string): void {
  if (isExtensionActive(id)) set((s) => ({ needsRestart: s.needsRestart.includes(id) ? s.needsRestart : [...s.needsRestart, id] }));
}

async function run(id: string, label: string, op: () => Promise<string | void>): Promise<boolean> {
  set((s) => ({ busy: { ...s.busy, [id]: label }, error: null, errorRetry: false, notice: null }));
  try {
    const notice = await op();
    await reloadInstalled();
    if (notice) set({ notice });
    return true;
  } catch (err) {
    set({ error: msg(err) });
    return false;
  } finally {
    set((s) => {
      const busy = { ...s.busy };
      delete busy[id];
      const progress = { ...s.progress };
      delete progress[id];
      return { busy, progress };
    });
  }
}

// ------------------------------------------------- prévia da loja (pré-instalação)

/**
 * Veredito ANTES de instalar, em duas fases: `manifest` (rápida: temas,
 * gramáticas e snippets já saem decididos) → `code` (bundle `main` varrido em
 * memória pelo Rust). É PRÉVIA: nunca grava portão — depois de instalar, o
 * portão é recalculado sobre os arquivos extraídos (hash conferido).
 */
export interface PreviewState {
  stage: "manifest" | "code" | "done" | "error";
  version: string | null;
  report: CompatibilityReport | null;
  error?: string;
}

export const previewKey = (sourceId: string, namespace: string, name: string): string => `${sourceId}|${namespace}.${name}`.toLowerCase();

const PREVIEW_CONCURRENCY = 3;
const previewQueue: (() => Promise<void>)[] = [];
let previewActive = 0;

function pumpPreviews(): void {
  while (previewActive < PREVIEW_CONCURRENCY && previewQueue.length) {
    const job = previewQueue.shift()!;
    previewActive++;
    void job().finally(() => {
      previewActive--;
      pumpPreviews();
    });
  }
}

function setPreview(key: string, patch: Partial<PreviewState>): void {
  set((s) => ({ previews: { ...s.previews, [key]: { ...(s.previews[key] ?? { stage: "manifest", version: null, report: null }), ...patch } } }));
}

/** Pede a prévia de um resultado da loja (dedup; fila com concorrência 3). */
export function requestPreview(sourceId: string, namespace: string, name: string): void {
  const key = previewKey(sourceId, namespace, name);
  if (state.previews[key]) return;
  setPreview(key, { stage: "manifest" });
  const ids = () => new Set(state.installed.map((i) => i.id));
  previewQueue.push(async () => {
    try {
      const p1 = await extensionsApi.preflight(sourceId, namespace, name, null, false);
      const hasCode = typeof p1.manifest?.main === "string";
      setPreview(key, { stage: hasCode ? "code" : "done", version: p1.version, report: classifyPreview(p1, state.platform, ids(), CAPABILITIES) });
      if (!hasCode) return;
      previewQueue.push(async () => {
        try {
          const p2 = await extensionsApi.preflight(sourceId, namespace, name, p1.version, true);
          setPreview(key, { stage: "done", version: p2.version, report: classifyPreview(p2, state.platform, ids(), CAPABILITIES) });
        } catch (err) {
          setPreview(key, { stage: "done", error: msg(err) });
        }
      });
      pumpPreviews();
    } catch (err) {
      setPreview(key, { stage: "error", error: msg(err) });
    }
  });
  pumpPreviews();
}

// ------------------------------------------------------------------ operações

export function installFromSource(sourceId: string, namespace: string, name: string, version?: string, allowPreRelease = false): Promise<boolean> {
  const id = `${namespace}.${name}`.toLowerCase();
  const wasActive = isExtensionActive(id);
  return run(id, "Instalando…", async () => {
    const out = await extensionsApi.install(sourceId, namespace, name, version, allowPreRelease);
    if (wasActive) markRestart(id);
    return `${out.entry.id} ${out.entry.version} instalada${out.hashVerified ? " (SHA-256 conferido com o catálogo)" : " (o catálogo não publica hash)"}.`;
  });
}

export function updateExtension(u: UpdateInfo): Promise<boolean> {
  const wasActive = isExtensionActive(u.id);
  return run(u.id, "Atualizando…", async () => {
    const out = await extensionsApi.install(u.sourceId, u.namespace, u.name, u.latest, u.preRelease);
    if (wasActive) markRestart(u.id);
    return `${u.id} atualizada para ${out.entry.version}.`;
  });
}

export async function updateAll(): Promise<void> {
  for (const u of [...state.updates]) await updateExtension(u);
}

export function uninstallExtension(id: string): Promise<boolean> {
  const wasActive = isExtensionActive(id);
  return run(id, "Removendo…", async () => {
    await extensionsApi.uninstall(id);
    if (wasActive) markRestart(id);
    evaluated.delete(id);
    return `${id} removida.`;
  });
}

/** A liberação explícita gravada vale para ESTA versão e ESTE shim? */
export function isTrusted(info: Pick<InstalledInfo, "version" | "trust">): boolean {
  return !!info.trust && info.trust.version === info.version && info.trust.hostVersion === CAPABILITIES.hostVersion;
}

/**
 * Libera (ou revoga) a execução de uma versão "Não avaliada" — só depois da
 * confirmação na view. O host só aceita junto com o portão `unknown` da mesma
 * versão e do mesmo shim; atualizar a extensão descarta a liberação.
 */
export function setUnverifiedAllowed(info: InstalledInfo, allow: boolean): Promise<boolean> {
  return run(info.id, allow ? "Liberando…" : "Revogando…", async () => {
    if (allow) await ensureGate(info); // o host só aceita a liberação junto com o portão `unknown` desta versão
    await extensionsApi.setTrust(info.id, allow ? { version: info.version, hostVersion: CAPABILITIES.hostVersion } : null);
    if (allow && !info.enabled) await extensionsApi.setEnabled(info.id, true);
    if (!allow) markRestart(info.id);
    return allow
      ? `${info.displayName} ${info.version} liberada para rodar sem avaliação (só esta versão).`
      : `Liberação de ${info.displayName} revogada: ela volta a ficar bloqueada.`;
  });
}

export function setExtensionEnabled(id: string, enabled: boolean): Promise<boolean> {
  return run(id, enabled ? "Habilitando…" : "Desabilitando…", async () => {
    const info = state.installed.find((i) => i.id === id);
    if (enabled && info) await ensureGate(info);
    await extensionsApi.setEnabled(id, enabled);
    if (!enabled) markRestart(id);
  });
}

/** .vsix local escolhido pelo usuário (sem hash de catálogo). */
export function installVsixFile(path: string): Promise<boolean> {
  return run(path, "Instalando…", async () => {
    const out = await extensionsApi.installVsix(path);
    if (isExtensionActive(out.entry.id)) markRestart(out.entry.id);
    evaluated.delete(out.entry.id);
    return `${out.entry.id} ${out.entry.version} instalada do arquivo (sem verificação de catálogo).`;
  });
}

export function importFromVscode(id: string): Promise<boolean> {
  return run(id, "Importando…", async () => {
    const out = await extensionsApi.importFromVscode(id);
    evaluated.delete(id);
    return `${out.entry.id} ${out.entry.version} copiada do VS Code para a pasta do app (a original não foi alterada).`;
  });
}

export async function saveSources(sources: CatalogSource[]): Promise<void> {
  const saved = await extensionsApi.saveSources(sources);
  set({ sources: saved });
}

export async function restartHost(): Promise<void> {
  set({ notice: "Reiniciando o host de extensões…" });
  try {
    await restartExtensionHost();
    set({ needsRestart: [], notice: "Host de extensões reiniciado." });
  } catch (err) {
    set({ error: `Falha ao reiniciar o host: ${msg(err)}` });
  }
}

export function dismissMessages(): void {
  set({ error: null, errorRetry: false, notice: null });
}

// ---------------------------------------------------------------- atualizações

let startupScheduled = false;

/** Checa atualizações (sob demanda: `force`; startup: respeita o throttle). */
export async function checkForUpdates(force = false): Promise<void> {
  if (state.checkingUpdates) return;
  // `extensions.autoCheckUpdates: false` desliga só a checagem automática.
  if (!force && getSetting<boolean>("extensions.autoCheckUpdates") === false) return;
  if (!force && !shouldCheckUpdates(state.lastUpdateCheck, Date.now())) return;
  set({ checkingUpdates: true });
  try {
    const updates = await extensionsApi.checkUpdates();
    const at = Date.now();
    writeUpdateCache(at, updates);
    set({ updates, lastUpdateCheck: at });
    // `extensions.autoUpdate`: instala as atualizações encontradas na checagem automática.
    if (!force && updates.length && getSetting<boolean>("extensions.autoUpdate") === true) {
      queueMicrotask(() => void updateAll());
    }
  } catch (err) {
    if (force) set({ error: `Não foi possível checar atualizações: ${msg(err)}` });
  } finally {
    set({ checkingUpdates: false });
  }
}

/** Agenda a checagem do startup (uma vez por janela, depois que o app assentou). */
export function scheduleStartupUpdateCheck(delayMs = 15_000): void {
  if (startupScheduled) return;
  startupScheduled = true;
  window.setTimeout(() => void checkForUpdates(false), delayMs);
}

/** Contagem para o badge do item "Extensões" na activity bar. */
export function useExtensionUpdateCount(): number {
  return useSyncExternalStore(subscribe, () => state.updates.length, () => 0);
}
