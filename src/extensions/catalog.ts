/**
 * Catálogo de extensões: fontes Open VSX-compatíveis configuráveis,
 * recomendadas (Claude Code / Codex), busca/metadados/instalação via backend
 * Rust (src-tauri/src/extensions/) e checagem de atualizações com throttle.
 *
 * TODA rede passa pelo Rust (HTTPS + allowlist dos hosts das fontes); o
 * frontend nunca busca o catálogo direto.
 */
import { invoke } from "@tauri-apps/api/core";

// ------------------------------------------------------------------ tipos

export interface CatalogSource {
  id: string;
  label: string;
  /** Base da API (`https://open-vsx.org/api`). */
  url: string;
  contentHosts: string[];
  enabled: boolean;
  builtin: boolean;
}

export type InstallSource =
  | { kind: "registry"; registry: string; namespace: string; name: string }
  | { kind: "vscode-import"; from: string }
  | { kind: "vsix" };

export interface GateRecord {
  verdict: string;
  version: string;
  hostVersion: string;
  evaluatedAt: number;
}

/** Extensão instalada (pasta do app ou VS Code), como o Rust descobre. */
export interface InstalledInfo {
  id: string;
  publisher: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  location: "app" | "vscode";
  path: string;
  targetPlatform: string;
  builtin: boolean;
  enabled: boolean;
  gate: GateRecord | null;
  source: InstallSource | null;
  verified: boolean;
  preRelease: boolean;
  installedAt: number | null;
  shadowedVersion: string | null;
  manifest: Record<string, unknown>;
}

export interface RegistrySummary {
  namespace: string;
  name: string;
  version: string;
  displayName?: string | null;
  description?: string | null;
  verified?: boolean | null;
  deprecated?: boolean | null;
  downloadCount?: number | null;
  averageRating?: number | null;
  timestamp?: string | null;
  targetPlatform?: string | null;
  iconUrl?: string | null;
}

export interface SearchResult {
  offset: number;
  totalSize: number;
  extensions: RegistrySummary[];
}

export interface RegistryMetadata extends RegistrySummary {
  namespaceDisplayName?: string | null;
  unrelatedPublisher?: unknown;
  preRelease?: boolean | null;
  engines?: Record<string, string> | null;
  dependencies?: unknown[] | null;
  categories?: string[] | null;
  license?: string | null;
  homepage?: string | null;
  repository?: string | null;
  files: { download?: string | null; sha256?: string | null; manifest?: string | null; readme?: string | null; changelog?: string | null; icon?: string | null };
  versions: string[];
}

export interface RegistryDetails {
  metadata: RegistryMetadata;
  manifest: Record<string, unknown> | null;
}

export interface LocalDetails {
  readme: string | null;
  changelog: string | null;
  icon: string | null;
  /** Varredura estática do código Node (vscode.<api>) feita no Rust. */
  apiScan: { file: string | null; filesWithApi: number; bindings: number; paths: [string, number][]; called: string[]; truncated: boolean; error: string | null };
}

export interface InstallOutcome {
  entry: { id: string; version: string; dir: string; targetPlatform: string; verified: boolean };
  sha256: string;
  size: number;
  hashVerified: boolean;
}

export interface UpdateInfo {
  id: string;
  current: string;
  latest: string;
  sourceId: string;
  namespace: string;
  name: string;
  preRelease: boolean;
}

export interface ExtensionPaths {
  managedDir: string;
  vscodeDir: string | null;
  platform: string;
}

export interface InstallProgress {
  id: string;
  phase: "metadata" | "download" | "extract" | "commit";
  received: number;
  total: number | null;
}

// ------------------------------------------------------------- comandos Rust

export const extensionsApi = {
  paths: () => invoke<ExtensionPaths>("extensions_paths"),
  list: () => invoke<InstalledInfo[]>("extensions_list"),
  localDetails: (id: string) => invoke<LocalDetails>("extensions_local_details", { id }),
  sources: () => invoke<CatalogSource[]>("extensions_sources_list"),
  saveSources: (sources: CatalogSource[]) => invoke<CatalogSource[]>("extensions_sources_save", { sources }),
  search: (sourceId: string, query: string, offset = 0, size = 20) => invoke<SearchResult>("extensions_search", { sourceId, query, offset, size }),
  metadata: (sourceId: string, namespace: string, name: string, version?: string, allowPreRelease = false) =>
    invoke<RegistryDetails>("extensions_metadata", { sourceId, namespace, name, version: version ?? null, allowPreRelease }),
  fetchText: (sourceId: string, url: string) => invoke<string>("extensions_fetch_text", { sourceId, url }),
  fetchIcon: (sourceId: string, url: string) => invoke<string>("extensions_fetch_icon", { sourceId, url }),
  install: (sourceId: string, namespace: string, name: string, version?: string, allowPreRelease = false) =>
    invoke<InstallOutcome>("extensions_install", { sourceId, namespace, name, version: version ?? null, allowPreRelease }),
  installVsix: (path: string) => invoke<InstallOutcome>("extensions_install_vsix", { path }),
  importFromVscode: (id: string) => invoke<InstallOutcome>("extensions_import_vscode", { id }),
  uninstall: (id: string) => invoke<void>("extensions_uninstall", { id }),
  setEnabled: (id: string, enabled: boolean) => invoke<void>("extensions_set_enabled", { id, enabled }),
  setGate: (id: string, gate: { verdict: string; version: string; hostVersion: string }) => invoke<void>("extensions_set_gate", { id, gate }),
  checkUpdates: () => invoke<UpdateInfo[]>("extensions_check_updates"),
};

// ------------------------------------------------------------- recomendadas

export interface Recommendation {
  id: string;
  namespace: string;
  name: string;
  label: string;
  publisher: string;
  description: string;
  /** Página oficial (fora do app, no navegador). */
  officialUrl: string;
}

/**
 * Recomendadas embutidas. A DISPONIBILIDADE não é afirmada aqui: a view
 * consulta as fontes configuradas em tempo de execução (`resolveRecommendation`)
 * e só mostra "Disponível em <fonte>" se o catálogo respondeu. Verificado em
 * 10/10/2026: as duas estão no Open VSX (`Anthropic.claude-code` 2.1.296 com
 * pacote linux-x64; `openai.chatgpt` com a última marcada pré-lançamento e
 * versões estáveis 26.908.x).
 */
export const RECOMMENDED: Recommendation[] = [
  {
    id: "anthropic.claude-code",
    namespace: "anthropic",
    name: "claude-code",
    label: "Claude Code",
    publisher: "Anthropic",
    description: "Agente de código da Anthropic: chat, diffs propostos e terminal integrados ao editor.",
    officialUrl: "https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code",
  },
  {
    id: "openai.chatgpt",
    namespace: "openai",
    name: "chatgpt",
    label: "Codex",
    publisher: "OpenAI",
    description: "Agente de código da OpenAI (Codex) com a interface própria da extensão.",
    officialUrl: "https://marketplace.visualstudio.com/items?itemName=openai.chatgpt",
  },
];

export const isRecommended = (id: string): boolean => RECOMMENDED.some((r) => r.id === id.toLowerCase());

export interface RecommendationStatus {
  /** Fonte que respondeu com a extensão (null = nenhuma das configuradas). */
  sourceId: string | null;
  sourceLabel: string | null;
  version: string | null;
  preRelease: boolean;
  error: string | null;
}

/** Procura a recomendada nas fontes habilitadas, em ordem; nunca presume. */
export async function resolveRecommendation(rec: Recommendation, sources: CatalogSource[]): Promise<RecommendationStatus> {
  let lastError: string | null = null;
  for (const s of sources.filter((x) => x.enabled)) {
    try {
      const d = await extensionsApi.metadata(s.id, rec.namespace, rec.name);
      return { sourceId: s.id, sourceLabel: s.label, version: d.metadata.version, preRelease: !!d.metadata.preRelease, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { sourceId: null, sourceLabel: null, version: null, preRelease: false, error: lastError };
}

// ------------------------------------------------------------- atualizações

export const UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "extensions.lastUpdateCheck";
const UPDATES_KEY = "extensions.updates";

/** Hora de checar de novo? (throttle de 12 h entre checagens automáticas). */
export function shouldCheckUpdates(lastCheckAt: number | null, now: number, intervalMs = UPDATE_INTERVAL_MS): boolean {
  if (lastCheckAt === null || !Number.isFinite(lastCheckAt)) return true;
  if (lastCheckAt > now) return true; // relógio voltou: checa
  return now - lastCheckAt >= intervalMs;
}

export function readUpdateCache(): { at: number | null; updates: UpdateInfo[] } {
  try {
    const at = Number(localStorage.getItem(LAST_CHECK_KEY));
    const updates = JSON.parse(localStorage.getItem(UPDATES_KEY) ?? "[]");
    return { at: at > 0 ? at : null, updates: Array.isArray(updates) ? updates : [] };
  } catch {
    return { at: null, updates: [] };
  }
}

export function writeUpdateCache(at: number, updates: UpdateInfo[]): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(at));
    localStorage.setItem(UPDATES_KEY, JSON.stringify(updates));
  } catch {
    /* armazenamento indisponível */
  }
}

/** Remove das atualizações pendentes as que já foram instaladas. */
export function pruneUpdates(updates: UpdateInfo[], installed: Pick<InstalledInfo, "id" | "version">[]): UpdateInfo[] {
  return updates.filter((u) => {
    const cur = installed.find((i) => i.id === u.id);
    return cur !== undefined && cur.version === u.current;
  });
}

// ------------------------------------------------------------- utilidades

export function formatCount(n: number | null | undefined): string {
  if (!n || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (n >= 1_000) return `${(n / 1_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return String(n);
}

export function formatBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} KB`;
  return `${n} B`;
}

/** Origem exibida no card: App (pasta do app), VS Code (somente leitura), ou o catálogo. */
export function sourceBadge(info: Pick<InstalledInfo, "location" | "source">, sources: CatalogSource[]): string {
  if (info.location === "vscode") return "VS Code";
  if (info.source?.kind === "registry") {
    const reg = (info.source as { registry: string }).registry;
    return sources.find((s) => s.id === reg)?.label ?? reg;
  }
  return "App";
}
