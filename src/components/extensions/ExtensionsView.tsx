/**
 * View "Extensões" (activity bar → barra lateral): busca no catálogo
 * (Open VSX e fontes compatíveis), Instaladas (app + VS Code), Recomendadas
 * (Claude Code/Codex), Atualizações disponíveis e Resultados da loja; cards com
 * origem e compatibilidade; detalhes num painel modal. Autocontida: só precisa
 * ser montada pelo App (sem props obrigatórias).
 *
 * Contratos e regras de segurança: docs/context/extensoes-vscode.md
 * ("Gerenciamento de extensões").
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { Codicon } from "../../icons/codicons/Codicon";
import { useModalFocus } from "../useModalFocus";
import { Button, IconButton, Input, SearchBox, Select, Switch } from "../ui";
import {
  RECOMMENDED,
  extensionsApi,
  formatCount,
  isRecommended,
  resolveRecommendation,
  sourceBadge,
  type CatalogSource,
  type InstalledInfo,
  type Recommendation,
  type RecommendationStatus,
  type RegistrySummary,
  type UpdateInfo,
} from "../../extensions/catalog";
import { RUNNABLE, VERDICT_LABEL, classify, type CompatibilityReport, type Verdict } from "../../extensions/compatibility";
import { CAPABILITIES } from "../../extensions/capabilities";
import { ExtensionCard, VerdictBadge, type CardAction } from "./ExtensionCard";
import { ExtensionDetails, type DetailsTarget } from "./ExtensionDetails";
import {
  checkForUpdates,
  dismissMessages,
  importFromVscode,
  installFromSource,
  installVsixFile,
  loadExtensions,
  restartHost,
  saveSources,
  isTrusted,
  previewKey,
  requestPreview,
  setExtensionEnabled,
  setUnverifiedAllowed,
  uninstallExtension,
  updateAll,
  updateExtension,
  useExtensionsState,
  type ExtensionsState,
} from "./extensionsStore";

const SEARCH_DEBOUNCE_MS = 350;
const PAGE = 20;

function openExternal(url: string): void {
  void invoke("ext_host_open_external", { url }).catch(() => {});
}

const iconCache = new Map<string, string | null>();

/** Ícone remoto via Rust (allowlist + teto), como `data:` URI; null = sem ícone. */
function useRemoteIcon(sourceId: string | null, url: string | null | undefined): string | null {
  const key = sourceId && url ? `${sourceId}|${url}` : "";
  const [icon, setIcon] = useState<string | null>(key ? (iconCache.get(key) ?? null) : null);
  useEffect(() => {
    if (!key || !sourceId || !url) return;
    if (iconCache.has(key)) {
      setIcon(iconCache.get(key) ?? null);
      return;
    }
    let alive = true;
    void extensionsApi
      .fetchIcon(sourceId, url)
      .then((d) => d, () => null)
      .then((d) => {
        iconCache.set(key, d);
        if (alive) setIcon(d);
      });
    return () => {
      alive = false;
    };
  }, [key, sourceId, url]);
  return icon;
}

// --------------------------------------------------------------- confirmação

interface InstallRequest {
  sourceId: string;
  sourceLabel: string;
  namespace: string;
  name: string;
  version?: string;
  allowPreRelease?: boolean;
}

interface PendingConfirm {
  request: InstallRequest | null;
  vsixPath?: string;
  loading: boolean;
  error?: string;
  displayName: string;
  publisher: string;
  verified: boolean;
  version: string | null;
  hasHash: boolean;
  report: CompatibilityReport | null;
  recommended: boolean;
  preRelease: boolean;
  /** Prévia da loja (veredito com o código, antes de instalar). */
  previewKey?: string;
  previewPending?: boolean;
}

function InstallConfirmDialog({ pending, onConfirm, onCancel }: { pending: PendingConfirm; onConfirm: () => void; onCancel: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();
  useModalFocus(surfaceRef, { onEscape: onCancel, initialFocus: cancelRef });
  const verdict = pending.report?.verdict ?? "unknown";
  const risky = verdict === "incompatible";
  const isPreview = !!pending.request;
  const top = (pending.report?.reasons ?? []).filter((r) => r.severity !== "info").slice(0, 4);
  return createPortal(
    <div className="confirm-overlay" onMouseDown={onCancel}>
      <div className="confirm-dialog ext-confirm" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1} ref={surfaceRef} onMouseDown={(e) => e.stopPropagation()}>
        <h2 id={titleId} className="confirm-title">
          Instalar {pending.displayName}?
        </h2>
        <div id={descId} className="ext-confirm-body">
          {pending.loading ? (
            <p role="status">Consultando o catálogo…</p>
          ) : pending.error ? (
            <p className="ext-callout ext-callout-error" role="alert">
              <Codicon name="error" /> {pending.error}
            </p>
          ) : (
            <>
              <p className="ext-confirm-publisher">
                Publicado por <strong>{pending.publisher}</strong>{" "}
                {pending.request ? (
                  pending.verified ? (
                    <span className="ext-verified-inline">
                      <Codicon name="verified" size={12} /> publisher verificado pelo {pending.request.sourceLabel}
                    </span>
                  ) : (
                    <span className="ext-warn-inline">
                      <Codicon name="warning" size={12} /> publisher NÃO verificado
                    </span>
                  )
                ) : (
                  <span className="ext-warn-inline">
                    <Codicon name="warning" size={12} /> arquivo local, sem verificação de catálogo
                  </span>
                )}
              </p>
              <p className="ext-confirm-line">
                {pending.version ? `Versão ${pending.version}` : "Versão do pacote"}
                {pending.preRelease ? " (pré-lançamento)" : ""}
                {pending.request ? ` · ${pending.request.sourceLabel}` : ""} · {pending.request ? (pending.hasHash ? "SHA-256 publicado (será conferido)" : "o catálogo não publica SHA-256") : "sem hash de referência"}
              </p>
              <div className="ext-confirm-verdict">
                <VerdictBadge verdict={verdict} reasons={pending.report?.reasons} preview={isPreview} pending={pending.previewPending} />
                {top.length > 0 && (
                  <ul className="ext-reasons ext-reasons-compact">
                    {top.map((r, i) => (
                      <li key={i} className={`ext-reason ext-reason-${r.severity}`}>
                        <Codicon name={r.severity === "blocker" ? "error" : "warning"} />
                        <span>{r.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="ext-confirm-note">
                Extensões rodam código no seu computador, no host de extensões, com as permissões do Fluent Coder (sem sandbox). Instale só de publishers em que você
                confia.
              </p>
              <p className="ext-confirm-note">
                Instalar não executa nada: o pacote é baixado por HTTPS, conferido e extraído na pasta do app. Ele só roda depois de analisado como Compatível ou Parcial
                {pending.recommended ? "" : " e se continuar habilitado"}.
                {risky
                  ? " Esta versão foi classificada como Incompatível e não vai rodar neste host."
                  : verdict === "unknown"
                    ? " Sem análise do código, ela fica bloqueada até você liberar esta versão explicitamente."
                    : isPreview
                      ? " O veredito acima é uma prévia: depois de instalar, os arquivos extraídos são analisados de novo."
                      : ""}
              </p>
            </>
          )}
        </div>
        <div className="confirm-actions">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant={risky ? "danger" : "primary"} disabled={pending.loading || !!pending.error} onClick={onConfirm}>
            {risky ? "Instalar mesmo assim" : "Instalar"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// --------------------------------------------------- liberação "Não avaliada"

/**
 * Confirmação para rodar uma versão cujo código NÃO foi analisado (bundle com
 * indireção). Decisão do usuário, por versão: o portão continua bloqueando
 * qualquer outra versão e nunca libera Incompatível.
 */
function TrustConfirmDialog({ info, report, onConfirm, onCancel }: { info: InstalledInfo; report: CompatibilityReport | undefined; onConfirm: () => void; onCancel: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();
  useModalFocus(surfaceRef, { onEscape: onCancel, initialFocus: cancelRef });
  const why = (report?.reasons ?? []).filter((r) => r.code.startsWith("code-") || r.severity !== "info").slice(0, 4);
  return createPortal(
    <div className="confirm-overlay" onMouseDown={onCancel}>
      <div className="confirm-dialog ext-confirm" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1} ref={surfaceRef} onMouseDown={(e) => e.stopPropagation()}>
        <h2 id={titleId} className="confirm-title">
          Executar {info.displayName} sem avaliação?
        </h2>
        <div id={descId} className="ext-confirm-body">
          <p className="ext-confirm-publisher">
            Publicado por <strong>{info.publisher}</strong> · versão {info.version} · {info.location === "vscode" ? "do VS Code (somente leitura)" : "pasta do app"}
          </p>
          {why.length > 0 && (
            <ul className="ext-reasons ext-reasons-compact">
              {why.map((r, i) => (
                <li key={i} className={`ext-reason ext-reason-${r.severity}`}>
                  <Codicon name={r.severity === "blocker" ? "error" : r.severity === "limit" ? "warning" : "info"} />
                  <span>{r.message}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="ext-confirm-note">
            O Fluent Coder não conseguiu analisar o código desta versão, então não sabe se as APIs que ela usa existem aqui. Ela pode falhar ou se comportar de forma
            inesperada, e roda com as permissões do app, sem sandbox.
          </p>
          <p className="ext-confirm-note">A liberação vale só para a versão {info.version}: ao atualizar, a extensão volta a ser analisada. Você pode revogá-la a qualquer momento.</p>
        </div>
        <div className="confirm-actions">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Executar mesmo assim
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ----------------------------------------------------------------- fontes

function SourcesDialog({ sources, onClose }: { sources: CatalogSource[]; onClose: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const urlId = useId();
  const labelId = useId();
  const [draft, setDraft] = useState<CatalogSource[]>(sources);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useModalFocus(surfaceRef, { onEscape: onClose });

  const add = () => {
    const u = url.trim();
    if (!/^https:\/\/[^\s/?#@]+\.[^\s/?#@]+(\/[^\s?#]*)?$/i.test(u)) {
      setError("Use uma URL HTTPS de um registro compatível com Open VSX, ex.: https://open-vsx.org/api");
      return;
    }
    setDraft((d) => [...d, { id: "", label: label.trim(), url: u, contentHosts: [], enabled: true, builtin: false }]);
    setUrl("");
    setLabel("");
    setError(null);
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveSources(draft);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="confirm-overlay" onMouseDown={onClose}>
      <div className="confirm-dialog ext-sources" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={surfaceRef} onMouseDown={(e) => e.stopPropagation()}>
        <h2 id={titleId} className="confirm-title">
          Fontes de extensões
        </h2>
        <p className="ext-muted">
          Registros compatíveis com a API do Open VSX. Só HTTPS; o app só acessa os hosts destas fontes (e os de conteúdo que elas declaram). O Open VSX é a fonte padrão e pode
          ser desabilitado, não removido.
        </p>
        <ul className="ext-source-list">
          {draft.map((s, i) => (
            <li key={`${s.id}-${s.url}`} className="ext-source-row">
              <Switch
                checked={s.enabled}
                onChange={(v) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, enabled: v } : x)))}
                label={
                  <span className="ext-source-text">
                    <span className="ext-source-label">{s.label || s.url}</span>
                    <span className="ext-muted">{s.url}</span>
                  </span>
                }
              />
              {!s.builtin && <IconButton icon="trash" label={`Remover a fonte ${s.label || s.url}`} size="sm" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} />}
            </li>
          ))}
        </ul>
        <div className="ext-source-add">
          <label htmlFor={urlId} className="ext-field-label">
            URL da API
          </label>
          <Input id={urlId} value={url} placeholder="https://registro.exemplo.com/api" onChange={(e) => setUrl(e.target.value)} invalid={!!error} onKeyDown={(e) => e.key === "Enter" && add()} />
          <label htmlFor={labelId} className="ext-field-label">
            Nome (opcional)
          </label>
          <Input id={labelId} value={label} placeholder="Registro da empresa" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <Button icon="add" onClick={add} disabled={!url.trim()}>
            Adicionar fonte
          </Button>
        </div>
        {error && (
          <p className="ext-callout ext-callout-error" role="alert">
            <Codicon name="error" /> {error}
          </p>
        )}
        <div className="confirm-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Salvar
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ----------------------------------------------------------------- seções

function Section({ title, count, children, actions, defaultOpen = true, id }: { title: string; count?: number; children: React.ReactNode; actions?: React.ReactNode; defaultOpen?: boolean; id: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = `ext-section-${id}`;
  return (
    <section className="ext-section" aria-labelledby={`${bodyId}-h`}>
      <div className="ext-section-header">
        <button type="button" className="ext-section-toggle" aria-expanded={open} aria-controls={bodyId} id={`${bodyId}-h`} onClick={() => setOpen((v) => !v)}>
          <Codicon name={open ? "chevronDown" : "chevronRight"} size={14} />
          <span className="ext-section-title">{title}</span>
          {count !== undefined && <span className="ext-count">{count}</span>}
        </button>
        {actions}
      </div>
      {open && (
        <div id={bodyId} className="ext-section-body">
          {children}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------- modelo/ações

interface ViewModel {
  st: ExtensionsState;
  updatesById: Map<string, UpdateInfo>;
  requestInstall: (r: InstallRequest, displayName: string, publisher: string) => void;
  requestTrust: (info: InstalledInfo) => void;
  openDetails: (t: DetailsTarget) => void;
}

function installedStatus(info: InstalledInfo, report: CompatibilityReport | undefined, update: UpdateInfo | undefined): string {
  const parts: string[] = [];
  if (update) parts.push(`${update.current} → ${update.latest}`);
  if (!info.enabled) parts.push("Desabilitada");
  else if (info.builtin || (report && RUNNABLE.has(report.verdict))) parts.push("Habilitada");
  else if (report?.verdict === "unknown" && isTrusted(info)) parts.push("Liberada sem avaliação");
  else if (report) parts.push("Não roda neste host");
  if (info.shadowedVersion) parts.push(`também no VS Code (${info.shadowedVersion})`);
  return parts.join(" · ");
}

function installedActions(info: InstalledInfo, report: CompatibilityReport | undefined, vm: ViewModel): CardAction[] {
  const acts: CardAction[] = [];
  const update = vm.updatesById.get(info.id);
  if (update) acts.push({ label: `Atualizar para ${update.latest}`, primary: true, onClick: () => void updateExtension(update) });
  const unverified = !info.builtin && report?.verdict === "unknown";
  const trusted = unverified && isTrusted(info);
  const runnable = info.builtin || (report ? RUNNABLE.has(report.verdict) : false) || trusted;
  if (unverified && !trusted) acts.push({ label: "Executar sem avaliação…", icon: "run", onClick: () => vm.requestTrust(info) });
  if (trusted) acts.push({ label: "Revogar a liberação sem avaliação", icon: "lock", onClick: () => void setUnverifiedAllowed(info, false) });
  if (info.enabled) acts.push({ label: "Desabilitar", icon: "circleSlash", onClick: () => void setExtensionEnabled(info.id, false) });
  else
    acts.push({
      label: runnable ? "Habilitar" : `Habilitar (indisponível: ${report ? VERDICT_LABEL[report.verdict] : "avaliando"})`,
      icon: "pass",
      disabled: !runnable,
      onClick: () => void setExtensionEnabled(info.id, true),
    });
  if (info.location === "vscode") acts.push({ label: "Importar do VS Code (copiar para o app)", icon: "cloudDownload", onClick: () => void importFromVscode(info.id) });
  else acts.push({ label: "Desinstalar", icon: "trash", danger: true, onClick: () => void uninstallExtension(info.id) });
  return acts;
}

function InstalledCard({ info, vm }: { info: InstalledInfo; vm: ViewModel }) {
  const report = vm.st.reports[info.id];
  const update = vm.updatesById.get(info.id);
  const det = vm.st.details[info.id];
  const verdict: Verdict | null = report?.verdict ?? (info.gate?.version === info.version ? (info.gate.verdict as Verdict) : null);
  const progress = vm.st.progress[info.id];
  return (
    <ExtensionCard
      id={info.id}
      displayName={info.displayName}
      publisher={info.publisher}
      version={info.version}
      description={info.description}
      icon={det?.icon ?? null}
      sourceLabel={sourceBadge(info, vm.st.sources)}
      verdict={verdict}
      reasons={report?.reasons}
      status={installedStatus(info, report, update)}
      busy={vm.st.busy[info.id]}
      progress={progress?.total ? progress.received / progress.total : null}
      actions={installedActions(info, report, vm)}
      onOpen={() => vm.openDetails({ kind: "installed", info, report, readme: det?.readme, changelog: det?.changelog, icon: det?.icon })}
    />
  );
}

function RecommendedCard({ rec, status, vm }: { rec: Recommendation; status: RecommendationStatus | "loading"; vm: ViewModel }) {
  const installed = vm.st.installed.find((i) => i.id === rec.id);
  const acts: CardAction[] = [];
  let statusText: string;
  const source = status !== "loading" && status.sourceId ? vm.st.sources.find((s) => s.id === status.sourceId) : undefined;
  if (installed) {
    statusText = installed.location === "vscode" ? `Instalada no VS Code (${installed.version}) — usada direto, somente leitura` : `Instalada no app (${installed.version})`;
    if (installed.location === "vscode") acts.push({ label: "Importar do VS Code", onClick: () => void importFromVscode(rec.id) });
  } else if (status === "loading") statusText = "Verificando disponibilidade nas fontes…";
  else if (status.sourceId) statusText = `Disponível no ${status.sourceLabel} (${status.version}${status.preRelease ? ", pré-lançamento" : ""})`;
  else statusText = "Não encontrada nas fontes configuradas — veja a página oficial.";
  if (!installed && status !== "loading" && status.sourceId && source)
    acts.push({
      label: "Instalar",
      primary: true,
      onClick: () => vm.requestInstall({ sourceId: source.id, sourceLabel: source.label, namespace: rec.namespace, name: rec.name }, rec.label, rec.publisher),
    });
  acts.push({ label: "Abrir a página oficial", icon: "linkExternal", onClick: () => openExternal(rec.officialUrl) });
  return (
    <ExtensionCard
      id={rec.id}
      displayName={rec.label}
      publisher={rec.publisher}
      version={installed?.version ?? (status !== "loading" ? status.version : null)}
      description={rec.description}
      icon={installed ? vm.st.details[rec.id]?.icon : null}
      sourceLabel={installed ? sourceBadge(installed, vm.st.sources) : (status !== "loading" ? status.sourceLabel : null)}
      verdict={installed ? (vm.st.reports[rec.id]?.verdict ?? null) : null}
      reasons={installed ? vm.st.reports[rec.id]?.reasons : undefined}
      status={statusText}
      busy={vm.st.busy[rec.id]}
      actions={acts}
      onOpen={() =>
        installed
          ? vm.openDetails({ kind: "installed", info: installed, report: vm.st.reports[rec.id], readme: vm.st.details[rec.id]?.readme, changelog: vm.st.details[rec.id]?.changelog, icon: vm.st.details[rec.id]?.icon })
          : source && vm.openDetails({ kind: "registry", sourceId: source.id, sourceLabel: source.label, namespace: rec.namespace, name: rec.name })
      }
    />
  );
}

function StoreCard({ item, source, vm }: { item: RegistrySummary; source: CatalogSource; vm: ViewModel }) {
  const id = `${item.namespace}.${item.name}`.toLowerCase();
  const icon = useRemoteIcon(source.id, item.iconUrl);
  const installed = vm.st.installed.find((i) => i.id === id);
  const key = previewKey(source.id, item.namespace, item.name);
  const preview = vm.st.previews[key];
  // Prévia ANTES de instalar (fila no store, concorrência 3, cache em disco no Rust).
  useEffect(() => {
    if (!installed) requestPreview(source.id, item.namespace, item.name);
  }, [key, installed, source.id, item.namespace, item.name]);
  const analyzing = !installed && (!preview || preview.stage === "manifest" || preview.stage === "code");
  const acts: CardAction[] = [];
  if (installed) acts.push({ label: installed.location === "vscode" ? "Instalada (VS Code)" : "Instalada", disabled: true, onClick: () => {} });
  else
    acts.push({
      label: "Instalar",
      primary: true,
      onClick: () => vm.requestInstall({ sourceId: source.id, sourceLabel: source.label, namespace: item.namespace, name: item.name }, item.displayName || item.name, item.namespace),
    });
  const progress = vm.st.progress[id];
  return (
    <ExtensionCard
      id={id}
      displayName={item.displayName || item.name}
      publisher={item.namespace}
      publisherVerified={!!item.verified}
      version={item.version}
      description={item.description}
      icon={icon}
      sourceLabel={source.label}
      verdict={installed ? (vm.st.reports[id]?.verdict ?? null) : (preview?.report?.verdict ?? "unknown")}
      reasons={installed ? vm.st.reports[id]?.reasons : preview?.report?.reasons}
      preview={!installed}
      status={`${formatCount(item.downloadCount)} downloads${item.deprecated ? " · descontinuada" : ""}${analyzing ? " · analisando compatibilidade…" : preview?.stage === "error" ? " · prévia indisponível" : ""}`}
      busy={vm.st.busy[id]}
      progress={progress?.total ? progress.received / progress.total : null}
      actions={acts}
      onOpen={() => vm.openDetails({ kind: "registry", sourceId: source.id, sourceLabel: source.label, namespace: item.namespace, name: item.name, summary: item, icon })}
    />
  );
}

// -------------------------------------------------------------------- view

export function ExtensionsView() {
  const st = useExtensionsState();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sourceId, setSourceId] = useState<string>("");
  const [results, setResults] = useState<{ items: RegistrySummary[]; total: number; loading: boolean; error: string | null; offset: number }>({ items: [], total: 0, loading: false, error: null, offset: 0 });
  const [recStatus, setRecStatus] = useState<Record<string, RecommendationStatus | "loading">>({});
  const [details, setDetails] = useState<DetailsTarget | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [trustTarget, setTrustTarget] = useState<InstalledInfo | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const searchSeq = useRef(0);

  useEffect(() => {
    void loadExtensions();
  }, []);

  const enabledSources = st.sources.filter((s) => s.enabled);
  const source = enabledSources.find((s) => s.id === sourceId) ?? enabledSources[0] ?? null;

  // Recomendadas: disponibilidade consultada nas fontes (nunca presumida).
  const sourcesKey = enabledSources.map((s) => `${s.id}:${s.url}`).join("|");
  useEffect(() => {
    if (!st.loaded) return;
    let alive = true;
    for (const rec of RECOMMENDED) {
      setRecStatus((r) => ({ ...r, [rec.id]: "loading" }));
      void resolveRecommendation(rec, enabledSources).then((s) => alive && setRecStatus((r) => ({ ...r, [rec.id]: s })));
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.loaded, sourcesKey]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  const search = (offset: number) => {
    if (!debounced || !source) return;
    const seq = ++searchSeq.current;
    setResults((r) => ({ ...r, loading: true, error: null, ...(offset === 0 ? { items: [], total: 0 } : {}) }));
    extensionsApi
      .search(source.id, debounced, offset, PAGE)
      .then((r) => {
        if (seq !== searchSeq.current) return;
        setResults((prev) => ({ items: offset === 0 ? r.extensions : [...prev.items, ...r.extensions], total: r.totalSize, loading: false, error: null, offset }));
      })
      .catch((err) => {
        if (seq !== searchSeq.current) return;
        setResults((prev) => ({ ...prev, loading: false, error: err instanceof Error ? err.message : String(err) }));
      });
  };
  useEffect(() => {
    if (!debounced) {
      searchSeq.current++;
      setResults({ items: [], total: 0, loading: false, error: null, offset: 0 });
      return;
    }
    search(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, source?.id]);

  const updatesById = useMemo(() => new Map(st.updates.map((u) => [u.id, u])), [st.updates]);

  const requestInstall = (request: InstallRequest, displayName: string, publisher: string) => {
    const id = `${request.namespace}.${request.name}`.toLowerCase();
    const pKey = request.version || request.allowPreRelease ? undefined : previewKey(request.sourceId, request.namespace, request.name);
    if (pKey) requestPreview(request.sourceId, request.namespace, request.name);
    const base: PendingConfirm = { request, loading: true, displayName, publisher, verified: false, version: null, hasHash: false, report: null, recommended: isRecommended(id), preRelease: false, previewKey: pKey };
    setConfirm(base);
    extensionsApi
      .metadata(request.sourceId, request.namespace, request.name, request.version, request.allowPreRelease)
      .then((d) => {
        const report = classify({ manifest: d.manifest, targetPlatform: d.metadata.targetPlatform, hostPlatform: st.platform, apiScan: null, installedIds: new Set(st.installed.map((i) => i.id)) }, CAPABILITIES);
        setConfirm((c) =>
          c && c.request === request
            ? {
                ...c,
                loading: false,
                displayName: d.metadata.displayName || displayName,
                publisher: d.metadata.namespaceDisplayName || d.metadata.namespace || publisher,
                verified: !!d.metadata.verified,
                version: d.metadata.version,
                hasHash: !!d.metadata.files.sha256,
                preRelease: !!d.metadata.preRelease,
                report,
              }
            : c,
        );
      })
      .catch((err) => setConfirm((c) => (c && c.request === request ? { ...c, loading: false, error: `Não foi possível consultar o catálogo: ${err instanceof Error ? err.message : String(err)}` } : c)));
  };

  const confirmInstall = () => {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    if (c.vsixPath) {
      void installVsixFile(c.vsixPath);
      return;
    }
    if (c.request) void installFromSource(c.request.sourceId, c.request.namespace, c.request.name, c.version ?? c.request.version, c.preRelease);
  };

  const installVsix = async () => {
    const picked = await openFileDialog({ multiple: false, directory: false, filters: [{ name: "Pacote de extensão VS Code", extensions: ["vsix"] }] }).catch(() => null);
    if (typeof picked !== "string") return;
    setConfirm({ request: null, vsixPath: picked, loading: false, displayName: picked.split(/[\\/]/).pop() ?? "pacote .vsix", publisher: "desconhecido (arquivo local)", verified: false, version: null, hasHash: false, report: null, recommended: false, preRelease: false });
  };

  const vm: ViewModel = {
    st,
    updatesById,
    requestInstall,
    requestTrust: setTrustTarget,
    openDetails: (t) => {
      if (t.kind === "registry") requestPreview(t.sourceId, t.namespace, t.name);
      setDetails(t);
    },
  };
  // Confirmação com a prévia AO VIVO (quando a análise do código termina, o veredito atualiza).
  const liveConfirm: PendingConfirm | null = (() => {
    if (!confirm?.previewKey) return confirm;
    const p = st.previews[confirm.previewKey];
    if (!p?.report || (confirm.version && p.version && p.version !== confirm.version)) return { ...confirm, previewPending: !!p && p.stage !== "done" && p.stage !== "error" };
    return { ...confirm, report: p.report, previewPending: p.stage !== "done" && p.stage !== "error" };
  })();

  const q = query.trim().toLowerCase();
  const installed = st.installed
    .filter((i) => !q || i.id.includes(q) || i.displayName.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
    .sort((a, b) => Number(b.location === "app") - Number(a.location === "app") || Number(b.enabled) - Number(a.enabled) || a.displayName.localeCompare(b.displayName));
  const updates = st.updates.filter((u) => st.installed.some((i) => i.id === u.id));

  // Detalhes: ações recalculadas com o estado atual.
  const detailsActions: CardAction[] = (() => {
    if (!details) return [];
    if (details.kind === "installed") {
      const info = st.installed.find((i) => i.id === details.info.id) ?? details.info;
      return installedActions(info, st.reports[info.id], vm);
    }
    const id = `${details.namespace}.${details.name}`.toLowerCase();
    const inst = st.installed.find((i) => i.id === id);
    if (inst) return [{ label: "Instalada", disabled: true, onClick: () => {} }];
    return [
      {
        label: "Instalar",
        primary: true,
        onClick: () => requestInstall({ sourceId: details.sourceId, sourceLabel: details.sourceLabel, namespace: details.namespace, name: details.name }, details.summary?.displayName ?? details.name, details.namespace),
      },
    ];
  })();
  const liveDetails: DetailsTarget | null =
    details?.kind === "installed"
      ? (() => {
          const info = st.installed.find((i) => i.id === details.info.id) ?? details.info;
          const det = st.details[info.id];
          return { kind: "installed", info, report: st.reports[info.id], readme: det?.readme, changelog: det?.changelog, icon: det?.icon };
        })()
      : details
        ? (() => {
            const p = st.previews[previewKey(details.sourceId, details.namespace, details.name)];
            return { ...details, report: p?.report ?? undefined, previewPending: !p || (p.stage !== "done" && p.stage !== "error") };
          })()
        : null;
  const detailsId = details ? (details.kind === "installed" ? details.info.id : `${details.namespace}.${details.name}`.toLowerCase()) : "";

  return (
    <div className="ext-view" aria-label="Extensões">
      <div className="explorer-header ext-header">
        <span className="explorer-title">Extensões</span>
        <div className="ext-header-actions">
          <IconButton icon="sync" label={st.checkingUpdates ? "Checando atualizações…" : "Checar atualizações"} size="sm" spin={st.checkingUpdates} disabled={st.checkingUpdates} onClick={() => void checkForUpdates(true)} tooltipPlacement="bottom" />
          <IconButton icon="add" label="Instalar de um arquivo .vsix…" size="sm" onClick={() => void installVsix()} tooltipPlacement="bottom" />
          <IconButton icon="settings" label="Fontes de extensões" size="sm" onClick={() => setSourcesOpen(true)} tooltipPlacement="bottom" />
        </div>
      </div>
      <div className="ext-search">
        <SearchBox
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={source ? `Pesquisar no ${source.label}` : "Pesquisar extensões"}
          aria-label="Pesquisar extensões"
          onClear={() => setQuery("")}
        />
        {enabledSources.length > 1 && (
          <Select ariaLabel="Fonte da pesquisa" size="sm" value={source?.id ?? ""} onChange={setSourceId} options={enabledSources.map((s) => ({ value: s.id, label: s.label }))} />
        )}
      </div>

      {st.needsRestart.length > 0 && (
        <div className="ext-banner" role="status">
          <Codicon name="info" />
          <span>
            {st.needsRestart.join(", ")} {st.needsRestart.length === 1 ? "estava ativa" : "estavam ativas"}: a mudança vale após reiniciar o host.
          </span>
          <Button size="sm" variant="primary" onClick={() => void restartHost()}>
            Reiniciar Host de Extensões
          </Button>
        </div>
      )}
      {st.error && (
        <div className="ext-banner ext-banner-error" role="alert">
          <Codicon name="error" />
          <span>{st.error}</span>
          <IconButton icon="close" label="Dispensar" size="sm" onClick={dismissMessages} />
        </div>
      )}
      {st.notice && !st.error && (
        <div className="ext-banner ext-banner-ok" role="status">
          <Codicon name="success" />
          <span>{st.notice}</span>
          <IconButton icon="close" label="Dispensar" size="sm" onClick={dismissMessages} />
        </div>
      )}

      <div className="ext-body">
        {!st.loaded && st.loading && (
          <p className="ext-muted ext-pad" role="status">
            Carregando extensões…
          </p>
        )}
        {debounced && source && (
          <Section id="store" title={`Resultados da loja · ${source.label}`} count={results.total}>
            {results.error ? (
              <p className="ext-callout ext-callout-error ext-pad" role="alert">
                <Codicon name="error" /> Falha na pesquisa: {results.error}. Verifique a conexão ou as fontes de extensões.
              </p>
            ) : results.items.length === 0 && !results.loading ? (
              <p className="ext-muted ext-pad">Nada encontrado para &ldquo;{debounced}&rdquo;.</p>
            ) : (
              <ul className="ext-list">
                {results.items.map((item) => (
                  <StoreCard key={`${item.namespace}.${item.name}`} item={item} source={source} vm={vm} />
                ))}
              </ul>
            )}
            {results.loading && (
              <p className="ext-muted ext-pad" role="status">
                Pesquisando…
              </p>
            )}
            {!results.loading && results.items.length < results.total && (
              <div className="ext-pad">
                <Button size="sm" onClick={() => search(results.offset + PAGE)}>
                  Mostrar mais
                </Button>
              </div>
            )}
          </Section>
        )}
        {updates.length > 0 && (
          <Section
            id="updates"
            title="Atualizações"
            count={updates.length}
            actions={
              <Button size="sm" variant="primary" onClick={() => void updateAll()} disabled={Object.keys(st.busy).length > 0}>
                Atualizar tudo
              </Button>
            }
          >
            <ul className="ext-list">
              {updates.map((u) => {
                const info = st.installed.find((i) => i.id === u.id)!;
                return <InstalledCard key={`u-${u.id}`} info={info} vm={vm} />;
              })}
            </ul>
          </Section>
        )}
        <Section id="installed" title="Instaladas" count={installed.length}>
          {installed.length === 0 ? (
            <p className="ext-muted ext-pad">{q ? "Nenhuma instalada corresponde à pesquisa." : "Nenhuma extensão instalada. Pesquise acima ou instale uma recomendada."}</p>
          ) : (
            <ul className="ext-list">
              {installed.map((info) => (
                <InstalledCard key={info.id} info={info} vm={vm} />
              ))}
            </ul>
          )}
        </Section>
        <Section id="recommended" title="Recomendadas" count={RECOMMENDED.length}>
          <ul className="ext-list">
            {RECOMMENDED.map((rec) => (
              <RecommendedCard key={rec.id} rec={rec} status={recStatus[rec.id] ?? "loading"} vm={vm} />
            ))}
          </ul>
        </Section>
        <p className="ext-footnote ext-muted">
          {st.lastUpdateCheck ? `Atualizações checadas em ${new Date(st.lastUpdateCheck).toLocaleString("pt-BR")}.` : "Atualizações ainda não checadas."} API do host {CAPABILITIES.hostVersion} ·{" "}
          {st.platform}
        </p>
      </div>

      {liveDetails && (
        <ExtensionDetails
          target={liveDetails}
          actions={detailsActions}
          busy={st.busy[detailsId]}
          platform={st.platform}
          sourceLabel={liveDetails.kind === "installed" ? sourceBadge(liveDetails.info, st.sources) : liveDetails.sourceLabel}
          onClose={() => setDetails(null)}
        />
      )}
      {liveConfirm && <InstallConfirmDialog pending={liveConfirm} onConfirm={confirmInstall} onCancel={() => setConfirm(null)} />}
      {sourcesOpen && <SourcesDialog sources={st.sources} onClose={() => setSourcesOpen(false)} />}
      {trustTarget && (
        <TrustConfirmDialog
          info={trustTarget}
          report={st.reports[trustTarget.id]}
          onCancel={() => setTrustTarget(null)}
          onConfirm={() => {
            const t = trustTarget;
            setTrustTarget(null);
            void setUnverifiedAllowed(t, true);
          }}
        />
      )}
    </div>
  );
}
