import { useEffect, useId, useRef, useState } from "react";
import { relativeToWorkspace } from "../../agents/store";
import type { ChatApproval, ChatFileDiff, ChatToolCall } from "../../agents/types";
import { diffStats, toolIcon } from "../../chat/transcript";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { Button } from "../ui";

const STATUS_LABEL: Record<string, string> = {
  pending: "pendente",
  in_progress: "em andamento",
  completed: "concluída",
  failed: "falhou",
};

function StatusIcon({ status }: { status?: string }) {
  if (status === "completed") return <Codicon name="success" size={13} className="fc-tool-ok" />;
  if (status === "failed") return <Codicon name="error" size={13} className="fc-tool-failed" />;
  if (status === "pending") return <Codicon name="pending" size={13} />;
  return <Codicon name="loading" size={13} />;
}

/** Linha de um diff com resumo (+/−) e "Abrir diff". */
function DiffRow({
  diff,
  workspacePath,
  onOpenDiff,
}: {
  diff: ChatFileDiff;
  workspacePath: string | null;
  onOpenDiff: (diff: ChatFileDiff) => void;
}) {
  const stats = diffStats(diff);
  const rel = workspacePath ? relativeToWorkspace(workspacePath, diff.path) : diff.path;
  return (
    <li className="fc-diff-row">
      <Codicon name="file" size={12} />
      <span className="fc-diff-path" title={diff.path}>
        {rel}
      </span>
      <span className="fc-diff-stats" aria-label={`${stats.added} linhas adicionadas, ${stats.removed} removidas`}>
        <span className="fc-diff-added">+{stats.added}</span>
        <span className="fc-diff-removed">−{stats.removed}</span>
      </span>
      <Button size="sm" variant="subtle" icon="openChanges" onClick={() => onOpenDiff(diff)}>
        Abrir diff
      </Button>
    </li>
  );
}

/**
 * Cartão colapsável de uma chamada de ferramenta (leitura, edição, comando…):
 * título + estado (ícone e texto, nunca só cor); expandido mostra a entrada,
 * a saída, os arquivos tocados e os diffs.
 */
export function ToolCallCard({
  call,
  workspacePath,
  onOpenFile,
  onOpenDiff,
}: {
  call: ChatToolCall;
  workspacePath: string | null;
  onOpenFile: (path: string, line?: number) => void;
  onOpenDiff: (diff: ChatFileDiff) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const hasBody = !!(call.detail || call.output || call.locations?.length || call.diffs?.length);
  const title = call.title || "Ferramenta";
  return (
    <div className={`fc-tool${call.status === "failed" ? " failed" : ""}`}>
      <button
        type="button"
        className="fc-tool-head"
        aria-expanded={hasBody ? open : undefined}
        aria-controls={hasBody ? bodyId : undefined}
        onClick={() => hasBody && setOpen((value) => !value)}
        disabled={!hasBody}
      >
        <Codicon name={toolIcon(call.kind) as IconAction} size={13} />
        <span className="fc-tool-title">{title}</span>
        {call.diffs?.length ? (
          <span className="fc-tool-meta">
            {call.diffs.length} arquivo{call.diffs.length > 1 ? "s" : ""}
          </span>
        ) : null}
        <span className="fc-tool-status" title={STATUS_LABEL[call.status ?? "in_progress"]}>
          <StatusIcon status={call.status} />
          <span className="fc-sr-only">{STATUS_LABEL[call.status ?? "in_progress"]}</span>
        </span>
        {hasBody && <Codicon name={open ? "chevronDown" : "chevronRight"} size={12} />}
      </button>
      {open && hasBody && (
        <div id={bodyId} className="fc-tool-body">
          {call.detail && <pre className="fc-tool-pre">{call.detail}</pre>}
          {call.locations?.length ? (
            <ul className="fc-tool-locations">
              {call.locations.map((location) => {
                const match = /^(.*?)(?::(\d+))?$/.exec(location);
                const path = match?.[1] ?? location;
                const line = match?.[2] ? Number(match[2]) : undefined;
                return (
                  <li key={location}>
                    <button type="button" className="agent-file-link" onClick={() => onOpenFile(path, line)}>
                      {workspacePath ? relativeToWorkspace(workspacePath, location) : location}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {call.diffs?.length ? (
            <ul className="fc-diff-list">
              {call.diffs.map((diff, index) => (
                <DiffRow key={`${diff.path}-${index}`} diff={diff} workspacePath={workspacePath} onOpenDiff={onOpenDiff} />
              ))}
            </ul>
          ) : null}
          {call.output && (
            <>
              <div className="fc-tool-label">Saída</div>
              <pre className="fc-tool-pre fc-tool-output">{call.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Cartão de aprovação interativo (Codex requestApproval, ACP
 * request_permission, Claude can_use_tool): o turno fica parado até o
 * usuário escolher. O foco vai para a primeira opção quando o cartão aparece.
 */
export function ApprovalCard({
  approval,
  workspacePath,
  onRespond,
  onOpenDiff,
}: {
  approval: ChatApproval;
  workspacePath: string | null;
  onRespond: (requestId: string, optionId: string) => void;
  onOpenDiff: (diff: ChatFileDiff) => void;
}) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    firstRef.current?.focus();
  }, [approval.requestId]);
  return (
    <section className="fc-approval" role="group" aria-labelledby={titleId}>
      <div className="fc-approval-head">
        <Codicon name={toolIcon(approval.toolKind) as IconAction} size={15} />
        <h3 id={titleId}>{approval.title}</h3>
        <span className="fc-badge warn">Aprovação necessária</span>
      </div>
      {approval.detail && <pre className="fc-tool-pre">{approval.detail}</pre>}
      {approval.diffs?.length ? (
        <ul className="fc-diff-list">
          {approval.diffs.map((diff, index) => (
            <DiffRow key={`${diff.path}-${index}`} diff={diff} workspacePath={workspacePath} onOpenDiff={onOpenDiff} />
          ))}
        </ul>
      ) : null}
      <div className="fc-approval-actions">
        {approval.options.map((option, index) => (
          <Button
            key={option.id}
            ref={index === 0 ? firstRef : undefined}
            size="sm"
            variant={
              option.kind === "allow_once"
                ? "primary"
                : option.kind.startsWith("reject")
                  ? "subtle"
                  : "secondary"
            }
            onClick={() => onRespond(approval.requestId, option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
