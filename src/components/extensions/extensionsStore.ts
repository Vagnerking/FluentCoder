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
  error: string | null;
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
  error: null,
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

/** Carrega (ou recarrega) instaladas + fontes e avalia a compatibilidade. */
export function loadExtensions(force = false): Promise<void> {
  if (loadPromise && !force) return loadPromise;
  listenProgress();
  set({ loading: true, error: null });
  loadPromise = (async () => {
    try {
      const [paths, installed, sources] = await Promise.all([extensionsApi.paths(), extensionsApi.list(), extensionsApi.sources()]);
      set((s) => ({ platform: paths.platform, installed, sources, loaded: true, updates: pruneUpdates(s.updates, installed) }));
      void evaluateAll();
    } catch (err) {
      set({ error: `Não foi possível listar as extensões: ${msg(err)}` });
    } finally {
      set({ loading: false });
    }
  })();
  return loadPromise;
}

const evaluated = new Map<string, string>(); // id → "versão@host" já avaliada

async function evaluateAll(): Promise<void> {
  const queue = [...state.installed];
  const worker = async () => {
    for (let info = queue.shift(); info; info = queue.shift()) await evaluate(info).catch(() => {});
  };
  await Promise.all([worker(), worker(), worker()]);
}

/** Classifica uma instalada (com a varredura do código) e grava o veredito do portão. */
export async function evaluate(info: InstalledInfo): Promise<CompatibilityReport> {
  const key = `${info.version}@${CAPABILITIES.hostVersion}@${info.location}`;
  if (evaluated.get(info.id) === key && state.reports[info.id]) return state.reports[info.id];
  const details = await extensionsApi.localDetails(info.id);
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
  if (!g || g.verdict !== report.verdict || g.version !== info.version || g.hostVersion !== CAPABILITIES.hostVersion) {
    await extensionsApi.setGate(info.id, { verdict: report.verdict, version: info.version, hostVersion: CAPABILITIES.hostVersion }).catch(() => {});
    await syncHost();
  }
  return report;
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
  await evaluateAll();
  await syncHost();
}

function markRestart(id: string): void {
  if (isExtensionActive(id)) set((s) => ({ needsRestart: s.needsRestart.includes(id) ? s.needsRestart : [...s.needsRestart, id] }));
}

async function run(id: string, label: string, op: () => Promise<string | void>): Promise<boolean> {
  set((s) => ({ busy: { ...s.busy, [id]: label }, error: null, notice: null }));
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

export function setExtensionEnabled(id: string, enabled: boolean): Promise<boolean> {
  return run(id, enabled ? "Habilitando…" : "Desabilitando…", async () => {
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
  set({ error: null, notice: null });
}

// ---------------------------------------------------------------- atualizações

let startupScheduled = false;

/** Checa atualizações (sob demanda: `force`; startup: respeita o throttle). */
export async function checkForUpdates(force = false): Promise<void> {
  if (state.checkingUpdates) return;
  if (!force && !shouldCheckUpdates(state.lastUpdateCheck, Date.now())) return;
  set({ checkingUpdates: true });
  try {
    const updates = await extensionsApi.checkUpdates();
    const at = Date.now();
    writeUpdateCache(at, updates);
    set({ updates, lastUpdateCheck: at });
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
