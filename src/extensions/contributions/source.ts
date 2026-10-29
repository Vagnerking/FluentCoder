/**
 * Fonte das contribuições declarativas: a lista de extensões instaladas
 * (`extensions_list`, o mesmo do view Extensões) filtrada pela política de
 * `policy.ts`. Os motores (temas de cor, ícones, gramáticas, snippets) leem
 * daqui e reagem a `onDidChangeContributions`. NADA da extensão é executado:
 * os arquivos são lidos como TEXTO pelo Rust (`extensions_read_contribution`,
 * preso à pasta da extensão) e os ícones/fontes vêm pelo protocolo `fcext`.
 */
import { invoke } from "@tauri-apps/api/core";
import { appendOutput } from "../../output/outputStore";
import type { InstalledInfo } from "../catalog";
import { CAPABILITIES } from "../capabilities";
import { getPlatform } from "../../platform/os";
import { SETTING, getSetting, onDidChangeSetting } from "../../theme/settingsAdapter";
import { contributionDecision, type ContributionMode, type DeclarativePoint } from "./policy";
import { extensionAssetUrl, normalizeInside } from "./paths";

export interface ContributingExtension {
  id: string;
  displayName: string;
  version: string;
  /** Pasta instalada (validada de novo pelo Rust a cada leitura). */
  path: string;
  manifest: Record<string, unknown>;
  mode: ContributionMode;
  points: DeclarativePoint[];
}

const OUTPUT = "Extensões";
let current: ContributingExtension[] = [];
let lastInstalled: InstalledInfo[] | null = null;
const listeners = new Set<() => void>();

export function contributionsLog(message: string): void {
  try {
    appendOutput(OUTPUT, `[contribuições] ${message}`);
  } catch {
    /* saída indisponível (testes) */
  }
}

export function getContributingExtensions(): readonly ContributingExtension[] {
  return current;
}

export function onDidChangeContributions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function compute(installed: InstalledInfo[]): ContributingExtension[] {
  const applyWhenCodeBlocked = getSetting(SETTING.contributionsWhenCodeBlocked, true);
  const out: ContributingExtension[] = [];
  for (const info of installed) {
    const d = contributionDecision(
      { id: info.id, version: info.version, enabled: info.enabled, gate: info.gate, trust: info.trust, manifest: info.manifest ?? {} },
      { hostVersion: CAPABILITIES.hostVersion, applyWhenCodeBlocked },
    );
    if (!d.apply) continue;
    out.push({ id: info.id, displayName: info.displayName || info.name, version: info.version, path: info.path, manifest: info.manifest, mode: d.mode, points: d.points });
  }
  return out;
}

function key(list: ContributingExtension[]): string {
  return list.map((e) => `${e.id}@${e.version}:${e.mode}:${e.path}`).join("|");
}

/**
 * Recalcula as extensões que contribuem. Sem `installed`, relista no Rust.
 * Chamado no boot e pelo view Extensões depois de instalar/remover/habilitar.
 */
export async function reloadExtensionContributions(installed?: InstalledInfo[]): Promise<void> {
  let list = installed;
  if (!list) {
    try {
      list = await invoke<InstalledInfo[]>("extensions_list");
    } catch (err) {
      contributionsLog(`não foi possível listar as extensões: ${String(err)}`);
      list = [];
    }
  }
  lastInstalled = list;
  const next = compute(list);
  if (key(next) === key(current)) return;
  current = next;
  if (next.length)
    contributionsLog(`${next.length} extensão(ões) com contribuições declarativas: ${next.map((e) => `${e.displayName} (${e.mode === "no-code" ? "sem código" : e.mode === "contributions-only" ? "somente contribuições" : "com código"})`).join(", ")}.`);
  for (const l of [...listeners]) l();
}

onDidChangeSetting(SETTING.contributionsWhenCodeBlocked, () => {
  if (lastInstalled) void reloadExtensionContributions(lastInstalled);
});

const textCache = new Map<string, Promise<string>>();

/**
 * Lê um arquivo de contribuição (texto) relativo à raiz da extensão. O
 * caminho é normalizado aqui (`./a/../b` → `b`; fora da raiz → erro) e
 * conferido de novo no Rust (realpath, extensão de arquivo, ≤ 4 MB).
 */
export function readExtensionFile(ext: Pick<ContributingExtension, "id" | "path" | "version">, relPath: string): Promise<string> {
  const rel = normalizeInside(relPath);
  if (!rel) return Promise.reject(new Error(`caminho fora da extensão: ${relPath}`));
  const k = `${ext.id}@${ext.version}/${rel}`;
  let p = textCache.get(k);
  if (!p) {
    p = invoke<string>("extensions_read_contribution", { id: ext.id, path: ext.path, file: rel });
    textCache.set(k, p);
    p.catch(() => textCache.delete(k));
    if (textCache.size > 300) textCache.delete(textCache.keys().next().value as string);
  }
  return p;
}

/** URL de um ícone/fonte da extensão (protocolo `fcext`). `null` se o caminho escapar da raiz. */
export function extensionAsset(extId: string, relPath: string): string | null {
  const rel = normalizeInside(relPath);
  if (!rel) return null;
  return extensionAssetUrl(extId, rel, getPlatform().os === "windows");
}
