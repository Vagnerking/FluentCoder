import type { ReactNode } from "react";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { Tooltip } from "../Tooltip";
import { Button, IconButton } from "../ui";
import { VERDICT_LABEL, type Reason, type Verdict } from "../../extensions/compatibility";

export interface CardAction {
  label: string;
  /** Só ícone (IconButton com o label como nome acessível) quando definido sem `primary`. */
  icon?: IconAction;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface ExtensionCardProps {
  id: string;
  displayName: string;
  publisher: string;
  /** Publisher verificado pelo catálogo (selo ao lado do nome). */
  publisherVerified?: boolean;
  version?: string | null;
  description?: string | null;
  /** `data:` URI (o app nunca carrega ícone remoto direto). */
  icon?: string | null;
  /** App / VS Code / Open VSX… */
  sourceLabel?: string | null;
  verdict?: Verdict | null;
  reasons?: Reason[];
  /** Linha extra (ex.: "1.0.0 → 1.1.0", "Desabilitada"). */
  status?: ReactNode;
  busy?: string | null;
  /** 0–1 do download (determinado) ou null (indeterminado). */
  progress?: number | null;
  actions: CardAction[];
  onOpen: () => void;
}

const VERDICT_ICON: Record<Verdict, IconAction> = {
  compatible: "success",
  partial: "warning",
  incompatible: "error",
  unknown: "info",
};

/** Texto do tooltip do selo: o veredito + os motivos principais. */
export function verdictTooltip(verdict: Verdict, reasons: Reason[] = []): string {
  const main = reasons.filter((r) => r.severity !== "info").slice(0, 3).map((r) => `• ${r.message}`);
  const fallback =
    verdict === "unknown"
      ? "Ainda não avaliada: instale (ou abra os detalhes) para analisar o código."
      : verdict === "compatible"
        ? "Nada encontrado que falte neste host."
        : "";
  return [`${VERDICT_LABEL[verdict]} com o host de extensões do Fluent Coder.`, ...(main.length ? main : [fallback])].filter(Boolean).join(" ");
}

export function VerdictBadge({ verdict, reasons }: { verdict: Verdict; reasons?: Reason[] }) {
  return (
    <Tooltip label={verdictTooltip(verdict, reasons)} placement="bottom">
      <span className={`ext-badge ext-verdict ext-verdict-${verdict}`} tabIndex={0} aria-label={`Compatibilidade: ${VERDICT_LABEL[verdict]}`}>
        <Codicon name={VERDICT_ICON[verdict]} size={12} />
        {VERDICT_LABEL[verdict]}
      </span>
    </Tooltip>
  );
}

export function ExtensionIcon({ src, name }: { src?: string | null; name: string }) {
  if (src && src.startsWith("data:image/")) return <img className="ext-icon" src={src} alt="" aria-hidden="true" />;
  return (
    <span className="ext-icon ext-icon-placeholder" aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || <Codicon name="extensions" />}
    </span>
  );
}

/** Card de uma extensão (instalada, recomendada ou resultado da loja). */
export function ExtensionCard(props: ExtensionCardProps) {
  const { id, displayName, publisher, publisherVerified, version, description, icon, sourceLabel, verdict, reasons, status, busy, progress, actions, onOpen } = props;
  return (
    <li className={`ext-card${busy ? " is-busy" : ""}`} aria-busy={busy ? true : undefined}>
      <ExtensionIcon src={icon} name={displayName} />
      <div className="ext-card-body">
        <div className="ext-card-title-row">
          <button type="button" className="ext-card-name" onClick={onOpen} aria-label={`${displayName} — abrir detalhes`}>
            {displayName}
          </button>
          {version && <span className="ext-card-version">{version}</span>}
        </div>
        <div className="ext-card-publisher" title={id}>
          {publisherVerified && (
            <Tooltip label="Publisher verificado pelo catálogo" placement="bottom">
              <span className="ext-verified" tabIndex={0} aria-label="Publisher verificado">
                <Codicon name="verified" size={12} />
              </span>
            </Tooltip>
          )}
          <span className="ext-publisher-name">{publisher}</span>
        </div>
        {description && <p className="ext-card-desc">{description}</p>}
        <div className="ext-card-meta">
          {verdict && <VerdictBadge verdict={verdict} reasons={reasons} />}
          {sourceLabel && <span className="ext-badge ext-source">{sourceLabel}</span>}
          {status && <span className="ext-card-status">{status}</span>}
        </div>
        {busy && (
          <div className="ext-card-progress" role="status">
            <span>{busy}</span>
            <span className={`ext-progress${progress == null ? " is-indeterminate" : ""}`} aria-hidden="true">
              <span style={progress == null ? undefined : { width: `${Math.round(progress * 100)}%` }} />
            </span>
          </div>
        )}
      </div>
      <ActionButtons actions={actions} busy={busy} className="ext-card-actions" />
    </li>
  );
}

/** Botões de ação (card e cabeçalho dos detalhes). */
export function ActionButtons({ actions, busy, className, size = "sm" }: { actions: CardAction[]; busy?: string | null; className?: string; size?: "sm" | "md" }) {
  return (
    <div className={className}>
      {actions.map((a) =>
        a.icon && !a.primary ? (
          <IconButton key={a.label} icon={a.icon} label={a.label} size={size} disabled={a.disabled || !!busy} onClick={a.onClick} className={a.danger ? "ext-danger" : undefined} />
        ) : (
          <Button key={a.label} size={size} variant={a.primary ? "primary" : a.danger ? "danger" : "secondary"} disabled={a.disabled || !!busy} loading={!!busy && a.primary} onClick={a.onClick}>
            {a.label}
          </Button>
        ),
      )}
    </div>
  );
}
