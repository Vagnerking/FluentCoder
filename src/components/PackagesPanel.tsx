import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { packageIntelAudit, packageIntelOutdated, packageIntelScan } from "../api";
import {
  managerForProject,
  packageIntelSnapshot,
  packageIntelSubscribe,
  publishPackageOutdatedForPath,
  setSelectedPackageManager,
  supportsInlineOutdated,
} from "../packages/packageIntelStore";
import type {
  JsTsPackageProject,
  PackageAuditReport,
  PackageManager,
  PackageOutdatedReport,
  PackageWorkspaceSummary,
} from "../types";

interface PackagesPanelProps {
  rootPath: string | null;
  workspaceRoots?: PackageWorkspaceRoot[];
}

interface PackageWorkspaceRoot {
  id: string;
  name: string;
  path: string;
  provider: "local" | "ssh";
  connId?: string;
  status?: "connected" | "connecting" | "error";
}

const CONFIDENCE_LABEL: Record<JsTsPackageProject["detectedManager"]["confidence"], string> = {
  high: "alta",
  medium: "média",
  low: "baixa",
};

/**
 * Project package intelligence. First pass covers TypeScript/JavaScript:
 * package.json discovery, package-manager inference and lockfile conflict hints.
 * The data model is intentionally ecosystem-agnostic enough to grow into Java,
 * Python, .NET, Rust, etc. without turning this panel into a JS-only feature.
 */
export function PackagesPanel({ rootPath, workspaceRoots = [] }: PackagesPanelProps) {
  const targets = useMemo(
    () =>
      workspaceRoots.length > 0
        ? workspaceRoots.filter(
            (root) =>
              root.provider === "local" ||
              (root.provider === "ssh" && root.status === "connected" && root.connId)
          )
        : rootPath
          ? [
              {
                id: rootPath,
                name: rootPath.split(/[\\/]/).pop() || rootPath,
                path: rootPath,
                provider: "local" as const,
              },
            ]
          : [],
    [rootPath, workspaceRoots]
  );
  const unavailableSshRoots = workspaceRoots.filter(
    (root) => root.provider === "ssh" && (!root.connId || root.status !== "connected")
  );

  if (targets.length === 0) {
    return (
      <div className="packages-panel">
        <div className="explorer-header">
          <span className="explorer-title">PACOTES</span>
        </div>
        <div className="panel-empty">
          {workspaceRoots.length > 0
            ? "Nenhuma root disponível para analisar pacotes neste workspace."
            : "Abra uma pasta para analisar pacotes e dependências."}
        </div>
        {unavailableSshRoots.map((root) => (
          <div key={root.id} className="packages-unavailable-root">
            {root.name} · SSH não conectado para package intelligence
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="packages-panel">
      <div className="explorer-header packages-header">
        <span className="explorer-title">PACOTES</span>
      </div>
      <div className="packages-body">
        {targets.map((target) => (
          <PackageRootSection
            key={target.id}
            target={target}
            showRootHeader={targets.length > 1 || workspaceRoots.length > 0}
          />
        ))}
        {unavailableSshRoots.length > 0 && (
          <div className="git-group">
            <div className="git-group-header">
              <span>SSH indisponível para pacotes</span>
              <span className="git-count">{unavailableSshRoots.length}</span>
            </div>
            {unavailableSshRoots.map((root) => (
              <div key={root.id} className="packages-unavailable-root">
                {root.name} · conecte a root SSH para analisar manifests
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PackageRootSection({
  target,
  showRootHeader,
}: {
  target: PackageWorkspaceRoot;
  showRootHeader: boolean;
}) {
  const [summary, setSummary] = useState<PackageWorkspaceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyProject, setBusyProject] = useState<string | null>(null);
  const [outdatedReports, setOutdatedReports] = useState<Record<string, PackageOutdatedReport>>({});
  const [auditReports, setAuditReports] = useState<Record<string, PackageAuditReport>>({});
  useSyncExternalStore(packageIntelSubscribe, packageIntelSnapshot, packageIntelSnapshot);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await packageIntelScan(target.path, target.connId));
      setError(null);
    } catch (err) {
      setError(String(err));
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [target.connId, target.path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    const projects = summary?.projects ?? [];
    if (!q) return projects;
    return projects.filter((project) =>
      [project.name, project.relativeDir, project.detectedManager.manager]
        .some((value) => value.toLowerCase().includes(q))
    );
  }, [query, summary]);

  async function checkOutdated(project: JsTsPackageProject, forcedManager?: PackageManager) {
    if (!summary) return;
    const choice = managerForProject(summary.root, project);
    const manager = forcedManager ?? choice.manager;
    if (!manager) {
      setError("Escolha o gerenciador de pacotes principal antes de checar versões.");
      return;
    }
    setBusyProject(`${project.path}:outdated`);
    try {
      const report = await packageIntelOutdated(
        target.path,
        project.path,
        manager,
        target.connId
      );
      if (supportsInlineOutdated(report.manager)) {
        publishPackageOutdatedForPath(`${summary.root}/${project.path}`, report);
      }
      setOutdatedReports((prev) => ({ ...prev, [project.path]: report }));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyProject(null);
    }
  }

  async function runAudit(project: JsTsPackageProject) {
    if (!summary) return;
    const choice = managerForProject(summary.root, project);
    if (!choice.manager) {
      setError("Escolha o gerenciador de pacotes principal antes de rodar audit.");
      return;
    }
    setBusyProject(`${project.path}:audit`);
    try {
      const report = await packageIntelAudit(
        target.path,
        project.path,
        choice.manager,
        target.connId
      );
      setAuditReports((prev) => ({ ...prev, [project.path]: report }));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyProject(null);
    }
  }

  return (
    <section className="packages-root-section">
      {showRootHeader && (
        <div className="git-group-header packages-root-header">
          <span>{target.name}</span>
          <span className="git-count">{target.provider === "ssh" ? "SSH" : "LOCAL"}</span>
        </div>
      )}
      <div className="packages-root-actions">
        <button className="git-icon-btn" title="Reanalisar pacotes" onClick={() => void reload()}>
          ⟳
        </button>
      </div>

      <div className="packages-summary">
        <div>
          <span className="packages-summary-value">{summary?.projects.length ?? 0}</span>
          <span className="packages-summary-label">projetos JS/TS</span>
        </div>
        <div>
          <span className="packages-summary-value">{summary?.warningCount ?? 0}</span>
          <span className="packages-summary-label">avisos</span>
        </div>
      </div>

      <input
        className="search-input packages-search"
        placeholder="Filtrar por projeto ou gerenciador…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error && <div className="git-error">{error}</div>}
      {loading && !summary && <div className="panel-empty">Analisando manifests…</div>}

      {!loading && summary && summary.projects.length === 0 && (
        <div className="panel-empty">Nenhum package.json encontrado neste workspace.</div>
      )}

      {summary && summary.projects.length > 0 && (
        <div className="packages-root-body">
          <div className="git-group">
            <div className="git-group-header">
              <span>Gerenciadores detectados</span>
              <span className="git-count">{Object.keys(summary.managerCounts).length}</span>
            </div>
            <div className="packages-manager-chips">
              {Object.entries(summary.managerCounts).map(([manager, count]) => (
                <span key={manager} className="packages-chip">
                  {manager} · {count}
                </span>
              ))}
            </div>
          </div>

          <div className="git-group">
            <div className="git-group-header">
              <span>Projetos</span>
              <span className="git-count">{filteredProjects.length}</span>
            </div>
            {filteredProjects.length === 0 ? (
              <div className="panel-empty">Nenhum projeto bate com o filtro.</div>
            ) : (
              filteredProjects.map((project) => (
                <PackageProjectCard
                  key={project.path}
                  project={project}
                  root={summary.root}
                  outdatedReport={outdatedReports[project.path]}
                  auditReport={auditReports[project.path]}
                  busy={busyProject?.startsWith(`${project.path}:`) ?? false}
                  onSelectManager={(manager) => {
                    setSelectedPackageManager(`${summary.root}/${project.path}`, manager);
                    setOutdatedReports((prev) => {
                      const next = { ...prev };
                      delete next[project.path];
                      return next;
                    });
                    setAuditReports((prev) => {
                      const next = { ...prev };
                      delete next[project.path];
                      return next;
                    });
                    setError(null);
                    void checkOutdated(project, manager);
                  }}
                  onCheckOutdated={() => void checkOutdated(project)}
                  onAudit={() => void runAudit(project)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function PackageProjectCard({
  project,
  root,
  outdatedReport,
  auditReport,
  busy,
  onSelectManager,
  onCheckOutdated,
  onAudit,
}: {
  project: JsTsPackageProject;
  root: string;
  outdatedReport?: PackageOutdatedReport;
  auditReport?: PackageAuditReport;
  busy: boolean;
  onSelectManager: (manager: PackageManager) => void;
  onCheckOutdated: () => void;
  onAudit: () => void;
}) {
  const deps =
    project.dependencyCounts.dependencies +
    project.dependencyCounts.devDependencies +
    project.dependencyCounts.peerDependencies +
    project.dependencyCounts.optionalDependencies;
  const choice = managerForProject(root, project);

  return (
    <article className="packages-project">
      <div className="packages-project-head">
        <div>
          <div className="packages-project-name">{project.name}</div>
          <div className="packages-project-path">{project.relativeDir}</div>
        </div>
        <span className={`packages-manager confidence-${choice.requiresSelection ? "medium" : project.detectedManager.confidence}`}>
          {choice.manager ?? "escolher"}
        </span>
      </div>

      <div className="packages-project-meta">
        <span>confiança {CONFIDENCE_LABEL[project.detectedManager.confidence]}</span>
        <span>{deps} deps</span>
        <span>{project.scripts.length} scripts</span>
        {project.hasWorkspaces && <span>workspaces</span>}
      </div>

      <p className="packages-reason">{project.detectedManager.reason}</p>

      {choice.managers.length > 1 && (
        <div className="packages-manager-picker">
          <span>CLI principal deste package.json:</span>
          <div>
            {choice.managers.map((manager) => (
              <button
                key={manager}
                type="button"
                className={`packages-manager-option${choice.manager === manager ? " selected" : ""}`}
                onClick={() => onSelectManager(manager)}
              >
                {manager}
              </button>
            ))}
          </div>
          <small>
            {choice.requiresSelection
              ? "Escolha uma CLI para habilitar versões, audit e vulnerabilidades deste projeto."
              : "Essa escolha será usada para versões, audit e vulnerabilidades deste projeto."}
          </small>
        </div>
      )}

      <div className="packages-actions">
        <button
          className="git-link-btn"
          disabled={busy || !choice.manager}
          onClick={onCheckOutdated}
        >
          {busy ? "Verificando…" : "Checar versões"}
        </button>
        <button
          className="git-link-btn"
          disabled={busy || !choice.manager}
          onClick={onAudit}
        >
          {busy ? "Aguarde…" : "Audit segurança"}
        </button>
      </div>

      {outdatedReport && (
        <div className="packages-check-result">
          <span>
            {!supportsInlineOutdated(outdatedReport.manager)
              ? `Resultado disponível para ${outdatedReport.manager}; decoração inline ainda aguarda parser confiável para essa CLI.`
              : outdatedReport.outdated.length === 0
              ? "Nenhum pacote desatualizado detectado no parser JSON."
              : `${outdatedReport.outdated.length} pacote(s) desatualizado(s).`}
          </span>
          {outdatedReport.stderr && <span className="packages-muted">{outdatedReport.stderr}</span>}
        </div>
      )}

      {auditReport && (
        <>
          <div className={`packages-audit-result${auditReport.summary.total > 0 ? " has-risk" : ""}`}>
            Segurança: {auditReport.summary.total} vulnerabilidade(s)
            {auditReport.summary.total > 0 &&
              ` · críticas ${auditReport.summary.critical} · altas ${auditReport.summary.high}`}
          </div>
          {auditReport.vulnerabilities.length > 0 && (
            <div className="packages-vulnerabilities">
              {auditReport.vulnerabilities.slice(0, 5).map((vulnerability, index) => (
                <div key={`${vulnerability.package}:${vulnerability.title}:${index}`}>
                  <span className={`packages-vulnerability-severity severity-${vulnerability.severity}`}>
                    {vulnerability.severity}
                  </span>
                  <strong>{vulnerability.package}</strong>
                  <span>{vulnerability.title}</span>
                </div>
              ))}
              {auditReport.vulnerabilities.length > 5 && (
                <div className="packages-muted">
                  +{auditReport.vulnerabilities.length - 5} vulnerabilidade(s)
                </div>
              )}
            </div>
          )}
        </>
      )}

      {project.declaredPackageManager && (
        <div className="packages-line">
          packageManager: <code>{project.declaredPackageManager}</code>
        </div>
      )}

      <div className="packages-line">
        Lockfiles:{" "}
        {project.lockfiles.length === 0 ? (
          <span className="packages-muted">nenhum</span>
        ) : (
          project.lockfiles.map((lock) => (
            <code key={lock.path} title={lock.path}>
              {lock.name}
            </code>
          ))
        )}
      </div>

      {project.scripts.length > 0 && (
        <div className="packages-scripts">
          {project.scripts.slice(0, 8).map((script) => (
            <span key={script} className="packages-script">
              {script}
            </span>
          ))}
          {project.scripts.length > 8 && (
            <span className="packages-muted">+{project.scripts.length - 8}</span>
          )}
        </div>
      )}

      {project.dependencies.length > 0 && (
        <div className="packages-dependencies">
          {project.dependencies.slice(0, 18).map((dep) => {
            const outdated = outdatedReport?.outdated.find((item) => item.name === dep.name);
            const vulnerabilities =
              auditReport?.vulnerabilities.filter((item) => item.package === dep.name) ?? [];
            return (
              <div key={`${dep.kind}:${dep.name}`} className="packages-dependency-row">
                <span className="packages-dependency-name">{dep.name}</span>
                <span className="packages-dependency-version">{dep.declaredVersion}</span>
                {vulnerabilities.length > 0 && (
                  <span className="packages-dependency-risk">
                    ⚠ {vulnerabilities.length}
                  </span>
                )}
                {outdated ? (
                  <span className="packages-dependency-outdated">
                    ✕ {outdated.latest ?? outdated.wanted ?? "nova versão"}
                  </span>
                ) : outdatedReport && (outdatedReport.manager === "npm" || outdatedReport.manager === "pnpm") ? (
                  <span className="packages-dependency-ok">✓</span>
                ) : null}
              </div>
            );
          })}
          {project.dependencies.length > 18 && (
            <div className="packages-muted">+{project.dependencies.length - 18} dependências</div>
          )}
        </div>
      )}

      {project.warnings.length > 0 && (
        <div className="packages-warnings">
          {project.warnings.map((warning) => (
            <div key={warning}>⚠ {warning}</div>
          ))}
        </div>
      )}
    </article>
  );
}
