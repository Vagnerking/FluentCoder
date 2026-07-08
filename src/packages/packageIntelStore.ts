import {
  packageIntelAudit,
  packageIntelOutdated,
  packageIntelScan,
  packageIntelVersions,
} from "../api";
import type {
  PackageAuditSummary,
  PackageAuditVulnerability,
  PackageManager,
  PackageOutdatedDependency,
  PackageOutdatedReport,
  PackageVersionsReport,
  JsTsPackageProject,
} from "../types";

type Listener = () => void;

export type PackageInlineState =
  | { status: "idle" }
  | { status: "checking"; manager?: PackageManager; managers?: PackageManager[] }
  | {
      status: "ready";
      manager: PackageManager;
      managers: PackageManager[];
      outdated: Map<string, PackageOutdatedDependency>;
    }
  | { status: "needsSelection"; managers: PackageManager[] }
  | { status: "unsupported"; manager: PackageManager; managers?: PackageManager[]; reason: string }
  | { status: "error"; message: string; manager?: PackageManager; managers?: PackageManager[] };

export type PackageAuditInlineState =
  | { status: "idle" }
  | { status: "checking"; manager?: PackageManager }
  | {
      status: "ready";
      manager: PackageManager;
      summary: PackageAuditSummary;
      vulnerabilities: PackageAuditVulnerability[];
      byPackage: Map<string, PackageAuditVulnerability[]>;
    }
  | { status: "error"; message: string };

const listeners = new Set<Listener>();
const stateByPackageJson = new Map<string, PackageInlineState>();
const auditByPackageJson = new Map<string, PackageAuditInlineState>();
const inflight = new Set<string>();
const auditInflight = new Set<string>();
const versionsCache = new Map<string, PackageVersionsReport>();
const versionsInflight = new Map<string, Promise<PackageVersionsReport>>();
const SELECTED_MANAGER_KEY = "packageIntel.selectedManager:";
let version = 0;

function vulnerabilitiesByPackage(
  vulnerabilities: PackageAuditVulnerability[]
): Map<string, PackageAuditVulnerability[]> {
  const map = new Map<string, PackageAuditVulnerability[]>();
  for (const vulnerability of vulnerabilities) {
    const key = vulnerability.package.toLowerCase();
    const list = map.get(key) ?? [];
    list.push(vulnerability);
    map.set(key, list);
  }
  return map;
}

function normalize(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  // Rust's std::fs::canonicalize on Windows can return verbatim paths such as
  // "\\?\C:\repo\package.json". The editor/file tree uses the regular
  // "C:\repo\package.json" shape, so without stripping this prefix the panel
  // result and Monaco inline decorations talk about the same file through
  // different cache keys.
  if (/^\/\/\?\/[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized.slice(4);
  } else if (normalized.toLowerCase().startsWith("//?/unc/")) {
    normalized = `//${normalized.slice(8)}`;
  }
  return normalized.replace(/\/+$/, "").toLowerCase();
}

function legacyNormalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function emit(): void {
  version++;
  for (const listener of listeners) listener();
}

function setState(packageJsonPath: string, state: PackageInlineState): void {
  stateByPackageJson.set(normalize(packageJsonPath), state);
  emit();
}

export function publishPackageOutdated(report: PackageOutdatedReport): void {
  publishPackageOutdatedForPath(`${report.projectPath}/package.json`, report);
}

export function publishPackageOutdatedForPath(
  packageJsonPath: string,
  report: PackageOutdatedReport,
  managers: PackageManager[] = []
): void {
  const byName = new Map<string, PackageOutdatedDependency>();
  for (const dep of report.outdated) {
    byName.set(dep.name, dep);
  }
  const oldState = inlineStateForPackageJson(packageJsonPath);
  const state: PackageInlineState = {
    status: "ready",
    manager: report.manager,
    managers:
      managers.length > 0
        ? managers
        : oldState.status !== "idle" && "managers" in oldState && oldState.managers
          ? oldState.managers
          : [report.manager],
    outdated: byName,
  };
  stateByPackageJson.set(normalize(packageJsonPath), state);
  stateByPackageJson.set(normalize(`${report.projectPath}/package.json`), state);
  emit();
}

export function packageIntelSubscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function packageIntelSnapshot(): number {
  return version;
}

export function inlineStateForPackageJson(path: string): PackageInlineState {
  return stateByPackageJson.get(normalize(path)) ?? { status: "idle" };
}

export function inlineAuditStateForPackageJson(path: string): PackageAuditInlineState {
  return auditByPackageJson.get(normalize(path)) ?? { status: "idle" };
}

export function availableManagersForProject(project: JsTsPackageProject): PackageManager[] {
  const managers = [
    project.detectedManager.manager,
    ...project.lockfiles.map((lock) => lock.manager),
  ];
  return Array.from(new Set(managers));
}

export function selectedPackageManager(packageJsonPath: string): PackageManager | null {
  try {
    const raw =
      localStorage.getItem(SELECTED_MANAGER_KEY + normalize(packageJsonPath)) ??
      localStorage.getItem(SELECTED_MANAGER_KEY + legacyNormalize(packageJsonPath));
    return isPackageManager(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function setSelectedPackageManager(packageJsonPath: string, manager: PackageManager): void {
  try {
    localStorage.setItem(SELECTED_MANAGER_KEY + normalize(packageJsonPath), manager);
  } catch {
    /* storage unavailable — keep runtime state only */
  }
  stateByPackageJson.delete(normalize(packageJsonPath));
  stateByPackageJson.delete(legacyNormalize(packageJsonPath));
  auditByPackageJson.delete(normalize(packageJsonPath));
  auditByPackageJson.delete(legacyNormalize(packageJsonPath));
  const normalizedPackage = normalize(packageJsonPath);
  const legacyPackage = legacyNormalize(packageJsonPath);
  for (const key of versionsCache.keys()) {
    if (key.includes(`::${normalizedPackage}::`) || key.includes(`::${legacyPackage}::`)) {
      versionsCache.delete(key);
    }
  }
  for (const key of versionsInflight.keys()) {
    if (key.includes(`::${normalizedPackage}::`) || key.includes(`::${legacyPackage}::`)) {
      versionsInflight.delete(key);
    }
  }
  emit();
}

export function managerForProject(
  root: string,
  project: JsTsPackageProject
): { manager: PackageManager | null; requiresSelection: boolean; managers: PackageManager[] } {
  const packageJsonPath = `${root}/${project.path}`;
  const selected = selectedPackageManager(packageJsonPath);
  const managers = availableManagersForProject(project);
  if (selected && managers.includes(selected)) {
    return { manager: selected, requiresSelection: false, managers };
  }
  if (managers.length > 1) {
    return { manager: null, requiresSelection: true, managers };
  }
  return {
    manager: project.detectedManager.manager ?? managers[0] ?? null,
    requiresSelection: false,
    managers,
  };
}

function findProjectForPackageJson(
  root: string,
  projects: JsTsPackageProject[],
  packageJsonPath: string
): JsTsPackageProject | undefined {
  const normalizedPackage = normalize(packageJsonPath);
  return projects.find((item) => {
    const absolute = normalize(`${root}/${item.path}`);
    const relative = normalize(item.path);
    return (
      absolute === normalizedPackage ||
      relative === normalizedPackage ||
      normalizedPackage.endsWith(`/${relative}`)
    );
  });
}

export async function ensurePackageInlineCheck(
  root: string,
  packageJsonPath: string,
  options: { force?: boolean; connId?: string } = {}
): Promise<void> {
  const key = normalize(packageJsonPath);
  const current = stateByPackageJson.get(key);
  if (
    current?.status === "checking" ||
    (!options.force &&
      (current?.status === "ready" ||
        current?.status === "needsSelection" ||
        current?.status === "unsupported" ||
        current?.status === "error"))
  ) {
    return;
  }
  if (inflight.has(key)) return;

  inflight.add(key);
  setState(packageJsonPath, { status: "checking" });
  try {
    const summary = await packageIntelScan(root, options.connId);
    const project = findProjectForPackageJson(summary.root, summary.projects, packageJsonPath);
    if (!project) {
      setState(packageJsonPath, {
        status: "error",
        message: "package.json não encontrado na varredura de pacotes.",
      });
      return;
    }

    const choice = managerForProject(summary.root, project);
    if (choice.requiresSelection) {
      setState(packageJsonPath, { status: "needsSelection", managers: choice.managers });
      return;
    }
    const manager = choice.manager ?? project.detectedManager.manager;
    if (!supportsInlineOutdated(manager)) {
      setState(packageJsonPath, {
        status: "unsupported",
        manager,
        managers: choice.managers,
        reason: `Selecionei ${manager}, mas a saída de versões desse gerenciador ainda não tem parser inline confiável.`,
      });
      return;
    }

    setState(packageJsonPath, { status: "checking", manager, managers: choice.managers });
    publishPackageOutdatedForPath(
      packageJsonPath,
      await packageIntelOutdated(root, project.path, manager, options.connId),
      choice.managers
    );
  } catch (err) {
    setState(packageJsonPath, { status: "error", message: String(err) });
  } finally {
    inflight.delete(key);
  }
}

export async function ensurePackageAuditCheck(
  root: string,
  packageJsonPath: string,
  options: { force?: boolean; connId?: string } = {}
): Promise<void> {
  const key = normalize(packageJsonPath);
  const current = auditByPackageJson.get(key);
  if (
    current?.status === "checking" ||
    (!options.force && (current?.status === "ready" || current?.status === "error"))
  ) {
    return;
  }
  if (auditInflight.has(key)) return;

  auditInflight.add(key);
  auditByPackageJson.set(key, { status: "checking" });
  emit();
  try {
    const summary = await packageIntelScan(root, options.connId);
    const project = findProjectForPackageJson(summary.root, summary.projects, packageJsonPath);
    if (!project) {
      auditByPackageJson.set(key, {
        status: "error",
        message: "package.json não encontrado na varredura de pacotes.",
      });
      emit();
      return;
    }

    const choice = managerForProject(summary.root, project);
    if (choice.requiresSelection) {
      auditByPackageJson.set(key, {
        status: "error",
        message: "Escolha o gerenciador de pacotes principal antes de rodar audit.",
      });
      emit();
      return;
    }
    const manager = choice.manager ?? project.detectedManager.manager;
    auditByPackageJson.set(key, { status: "checking", manager });
    emit();
    const report = await packageIntelAudit(root, project.path, manager, options.connId);
    const vulnerabilities = report.vulnerabilities ?? [];
    const readyState: PackageAuditInlineState = {
      status: "ready",
      manager,
      summary: report.summary,
      vulnerabilities,
      byPackage: vulnerabilitiesByPackage(vulnerabilities),
    };
    auditByPackageJson.set(key, {
      ...readyState,
    });
    auditByPackageJson.set(normalize(`${report.projectPath}/package.json`), {
      ...readyState,
    });
    emit();
  } catch (err) {
    auditByPackageJson.set(key, { status: "error", message: String(err) });
    emit();
  } finally {
    auditInflight.delete(key);
  }
}

export async function packageVersionsForHover(
  root: string,
  packageJsonPath: string,
  packageName: string,
  connId?: string
): Promise<PackageVersionsReport> {
  const summary = await packageIntelScan(root, connId);
  const project = findProjectForPackageJson(summary.root, summary.projects, packageJsonPath);
  if (!project) {
    throw new Error("package.json não encontrado na varredura de pacotes.");
  }
  const choice = managerForProject(summary.root, project);
  if (choice.requiresSelection || !choice.manager) {
    throw new Error("Escolha o gerenciador de pacotes principal antes de listar versões.");
  }
  const manager = choice.manager ?? project.detectedManager.manager;
  const cacheKey = `${connId ?? "local"}::${normalize(packageJsonPath)}::${manager}::${packageName}`;
  const cached = versionsCache.get(cacheKey);
  if (cached) return cached;
  const inflight = versionsInflight.get(cacheKey);
  if (inflight) return inflight;

  const request = packageIntelVersions(summary.root, project.path, manager, packageName, connId)
    .then((report) => {
      versionsCache.set(cacheKey, report);
      return report;
    })
    .finally(() => {
      versionsInflight.delete(cacheKey);
    });
  versionsInflight.set(cacheKey, request);
  return request;
}

export function supportsInlineOutdated(manager: PackageManager): boolean {
  return manager === "npm" || manager === "pnpm" || manager === "bun";
}

function isPackageManager(value: string | null): value is PackageManager {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}
