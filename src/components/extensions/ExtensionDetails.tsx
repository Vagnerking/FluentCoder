import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";
import { Codicon } from "../../icons/codicons/Codicon";
import { useModalFocus } from "../useModalFocus";
import { IconButton, Tabs } from "../ui";
import { classify, VERDICT_LABEL, type CompatibilityReport, type Reason } from "../../extensions/compatibility";
import { CAPABILITIES } from "../../extensions/capabilities";
import { extensionsApi, formatCount, type InstalledInfo, type RegistryDetails, type RegistrySummary } from "../../extensions/catalog";
import { ActionButtons, ExtensionIcon, VerdictBadge, type CardAction } from "./ExtensionCard";

export type DetailsTarget =
  | { kind: "installed"; info: InstalledInfo; report?: CompatibilityReport; readme?: string | null; changelog?: string | null; icon?: string | null }
  | { kind: "registry"; sourceId: string; sourceLabel: string; namespace: string; name: string; summary?: RegistrySummary; icon?: string | null };

type Tab = "readme" | "changelog" | "compat" | "contrib";

/** Abre http(s)/mailto no navegador do sistema (o Rust recusa outros esquemas). */
function openExternal(url: string): void {
  void invoke("ext_host_open_external", { url }).catch(() => {});
}

/**
 * Markdown de README/CHANGELOG de terceiros: react-markdown + GFM SEM HTML cru
 * (o padrão do react-markdown já ignora HTML), links abrem fora do app e
 * imagens NÃO são carregadas (rastreamento/conteúdo remoto) — viram link.
 */
export const ExtensionMarkdown = memo(function ExtensionMarkdown({ content }: { content: string }) {
  return (
    <div className="ext-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ node: _n, href, children }) => {
            const safe = href && /^(https?:|mailto:)/i.test(href) ? href : null;
            return safe ? (
              <a
                href={safe}
                onClick={(e) => {
                  e.preventDefault();
                  openExternal(safe);
                }}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          img: ({ node: _n, alt, src }) => {
            const safe = typeof src === "string" && /^https?:/i.test(src) ? src : null;
            const label = alt ? `[imagem: ${alt}]` : "[imagem]";
            return safe ? (
              <a
                className="ext-markdown-img"
                href={safe}
                onClick={(e) => {
                  e.preventDefault();
                  openExternal(safe);
                }}
              >
                {label}
              </a>
            ) : (
              <span className="ext-markdown-img">{label}</span>
            );
          },
          table: ({ node: _n, children }) => (
            <div className="ext-markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

const SEVERITY_LABEL: Record<Reason["severity"], string> = { blocker: "Bloqueio", limit: "Limitação", info: "Informação" };
const SEVERITY_ICON = { blocker: "error", limit: "warning", info: "info" } as const;

function CompatibilityPanel({ report, loading }: { report: CompatibilityReport | null; loading: boolean }) {
  if (!report) return <p className="ext-muted" role="status">{loading ? "Analisando…" : "Sem dados para avaliar."}</p>;
  return (
    <div className="ext-compat">
      <div className="ext-compat-head">
        <VerdictBadge verdict={report.verdict} reasons={report.reasons} />
        <span className="ext-muted">
          API do host {report.hostVersion} · manifesto {report.analyzed.manifest ? "analisado" : "indisponível"} · código {report.analyzed.code ? "analisado" : "não analisado"}
        </span>
      </div>
      {report.verdict === "unknown" && (
        <p className="ext-callout">
          <Codicon name="info" /> &ldquo;Não avaliada&rdquo; não é um selo positivo: faltam dados para afirmar que a extensão funciona aqui. Ela só roda no host depois de instalada e
          analisada como Compatível ou Parcial — ou se você liberar explicitamente esta versão (&ldquo;Executar sem avaliação…&rdquo;).
        </p>
      )}
      {report.reasons.length === 0 ? (
        <p className="ext-muted">Nenhuma limitação encontrada.</p>
      ) : (
        <ul className="ext-reasons">
          {report.reasons.map((r, i) => (
            <li key={`${r.code}-${i}`} className={`ext-reason ext-reason-${r.severity}`}>
              <Codicon name={SEVERITY_ICON[r.severity]} />
              <span>
                <strong>{SEVERITY_LABEL[r.severity]}:</strong> {r.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ContributionsPanel({ report, manifest }: { report: CompatibilityReport | null; manifest: Record<string, unknown> | null }) {
  const events = Array.isArray(manifest?.activationEvents) ? (manifest!.activationEvents as unknown[]).filter((e): e is string => typeof e === "string") : [];
  if (!report || !report.contributes.length) return <p className="ext-muted">A extensão não declara contribuições.</p>;
  const STATE: Record<string, string> = { supported: "usado", partial: "parcial", ignored: "ignorado", unsupported: "sem suporte aqui", code: "executa código" };
  return (
    <div className="ext-contrib">
      <p className="ext-muted">O que a extensão declara no manifesto e como o Fluent Coder usa cada item.</p>
      <ul className="ext-contrib-list">
        {report.contributes.map((c) => (
          <li key={c.key} className={`ext-contrib-item is-${c.state}`}>
            <span className="ext-contrib-label">{c.label}</span>
            <span className={`ext-badge ext-contrib-state is-${c.state}`}>{STATE[c.state] ?? c.state}</span>
            <span className="ext-contrib-detail">{c.detail}</span>
          </li>
        ))}
      </ul>
      {events.length > 0 && (
        <>
          <h3 className="ext-subheading">Eventos de ativação</h3>
          <p className="ext-code-list">{events.map((e) => <code key={e}>{e}</code>)}</p>
        </>
      )}
    </div>
  );
}

export interface ExtensionDetailsProps {
  target: DetailsTarget;
  /** Ações do cabeçalho (as mesmas do card). */
  actions: CardAction[];
  busy?: string | null;
  sourceLabel?: string | null;
  /** Plataforma deste computador (`linux-x64`…). */
  platform: string;
  onClose: () => void;
}

/** Painel de detalhes (modal largo): README, alterações, compatibilidade e contribuições. */
export function ExtensionDetails({ target, actions, busy, sourceLabel, platform, onClose }: ExtensionDetailsProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const idPrefix = useId().replace(/:/g, "");
  const [tab, setTab] = useState<Tab>("readme");
  const [remote, setRemote] = useState<RegistryDetails | null>(null);
  const [readme, setReadme] = useState<string | null>(target.kind === "installed" ? (target.readme ?? null) : null);
  const [changelog, setChangelog] = useState<string | null>(target.kind === "installed" ? (target.changelog ?? null) : null);
  const [icon, setIcon] = useState<string | null>(target.icon ?? null);
  const [loading, setLoading] = useState(target.kind === "registry");
  const [error, setError] = useState<string | null>(null);
  useModalFocus(surfaceRef, { onEscape: onClose });

  const regKey = target.kind === "registry" ? `${target.sourceId}:${target.namespace}.${target.name}` : null;
  useEffect(() => {
    if (target.kind !== "registry") return;
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const d = await extensionsApi.metadata(target.sourceId, target.namespace, target.name);
        if (!alive) return;
        setRemote(d);
        const f = d.metadata.files;
        const [rd, cl, ic] = await Promise.all([
          f.readme ? extensionsApi.fetchText(target.sourceId, f.readme).catch(() => null) : null,
          f.changelog ? extensionsApi.fetchText(target.sourceId, f.changelog).catch(() => null) : null,
          !icon && f.icon ? extensionsApi.fetchIcon(target.sourceId, f.icon).catch(() => null) : null,
        ]);
        if (!alive) return;
        setReadme(rd);
        setChangelog(cl);
        if (ic) setIcon(ic);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regKey]);

  useEffect(() => {
    if (target.kind === "installed") {
      setReadme(target.readme ?? null);
      setChangelog(target.changelog ?? null);
      if (target.icon) setIcon(target.icon);
    }
  }, [target]);

  const report: CompatibilityReport | null = useMemo(() => {
    if (target.kind === "installed") return target.report ?? null;
    if (!remote) return null;
    return classify({ manifest: remote.manifest, targetPlatform: remote.metadata.targetPlatform, hostPlatform: platform, apiScan: null }, CAPABILITIES);
  }, [target, remote, platform]);
  const fixedReport = report;

  const manifest = target.kind === "installed" ? target.info.manifest : (remote?.manifest ?? null);
  const meta = remote?.metadata;
  const displayName = target.kind === "installed" ? target.info.displayName : (meta?.displayName ?? target.summary?.displayName ?? target.name);
  const publisher = target.kind === "installed" ? target.info.publisher : (meta?.namespaceDisplayName ?? meta?.namespace ?? target.namespace);
  const id = target.kind === "installed" ? target.info.id : `${target.namespace}.${target.name}`.toLowerCase();
  const version = target.kind === "installed" ? target.info.version : (meta?.version ?? target.summary?.version ?? null);
  const verified = target.kind === "registry" ? !!(meta?.verified ?? target.summary?.verified) : false;
  const description = target.kind === "installed" ? target.info.description : (meta?.description ?? target.summary?.description ?? "");

  const tabs = [
    { value: "readme" as const, label: "Detalhes" },
    { value: "changelog" as const, label: "Alterações" },
    { value: "compat" as const, label: "Compatibilidade", badge: fixedReport ? VERDICT_LABEL[fixedReport.verdict] : undefined },
    { value: "contrib" as const, label: "Contribuições" },
  ];

  return createPortal(
    <div className="confirm-overlay ext-details-overlay" onMouseDown={onClose}>
      <div className="ext-details" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={surfaceRef} onMouseDown={(e) => e.stopPropagation()}>
        <header className="ext-details-header">
          <ExtensionIcon src={icon} name={displayName} />
          <div className="ext-details-heading">
            <h2 id={titleId} className="ext-details-title">
              {displayName} {version && <span className="ext-card-version">{version}</span>}
            </h2>
            <p className="ext-details-publisher">
              Publicado por <strong>{publisher}</strong>
              {verified && (
                <span className="ext-verified-inline">
                  <Codicon name="verified" size={12} /> verificado
                </span>
              )}
              <span className="ext-card-id">{id}</span>
            </p>
            {description && <p className="ext-details-desc">{description}</p>}
            <p className="ext-details-facts">
              {sourceLabel && <span className="ext-badge ext-source">{sourceLabel}</span>}
              {fixedReport && <VerdictBadge verdict={fixedReport.verdict} reasons={fixedReport.reasons} />}
              {meta?.preRelease && <span className="ext-badge">Pré-lançamento</span>}
              {meta?.downloadCount != null && <span className="ext-muted">{formatCount(meta.downloadCount)} downloads</span>}
              {meta?.license && <span className="ext-muted">Licença: {meta.license.length > 60 ? `${meta.license.slice(0, 60)}…` : meta.license}</span>}
              {target.kind === "installed" && <span className="ext-muted ext-path" title={target.info.path}>{target.info.location === "vscode" ? "Do VS Code (somente leitura)" : "Pasta do app"}</span>}
            </p>
          </div>
          <IconButton icon="close" label="Fechar detalhes" onClick={onClose} className="ext-details-close" />
        </header>
        <div className="ext-details-actions">
          <ActionButtons actions={actions} busy={busy} size="md" className="ext-details-action-row" />
          {busy && (
            <span className="ext-muted" role="status">
              {busy}
            </span>
          )}
        </div>
        <Tabs items={tabs} value={tab} onChange={setTab} ariaLabel="Seções dos detalhes da extensão" idPrefix={idPrefix} className="ext-details-tabs" />
        <div className="ext-details-body" role="tabpanel" id={`${idPrefix}-panel-${tab}`} aria-labelledby={`${idPrefix}-tab-${tab}`} tabIndex={0}>
          {error && (
            <p className="ext-callout ext-callout-error" role="alert">
              <Codicon name="error" /> Não foi possível carregar do catálogo: {error}. Verifique a conexão e as fontes configuradas.
            </p>
          )}
          {tab === "readme" &&
            (readme ? <ExtensionMarkdown content={readme} /> : <p className="ext-muted" role="status">{loading ? "Carregando…" : "A extensão não traz README."}</p>)}
          {tab === "changelog" &&
            (changelog ? <ExtensionMarkdown content={changelog} /> : <p className="ext-muted" role="status">{loading ? "Carregando…" : "A extensão não traz histórico de alterações."}</p>)}
          {tab === "compat" && <CompatibilityPanel report={fixedReport} loading={loading} />}
          {tab === "contrib" && <ContributionsPanel report={fixedReport} manifest={manifest} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}
