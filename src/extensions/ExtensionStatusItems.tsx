import { useSyncExternalStore } from "react";
import { extHost } from "./client";
import { Tooltip } from "../components/Tooltip";
import { cancelExtProgress } from "./ExtProgressToasts";
import { parseStatusText, statusItemsSnapshot, subscribeStatusItems } from "./statusBar";

/** Itens de barra de status das extensões hospedadas (um lado da barra). */
export function ExtensionStatusItems({ alignment }: { alignment: "left" | "right" }) {
  const items = useSyncExternalStore(subscribeStatusItems, statusItemsSnapshot).filter((i) => i.alignment === alignment);
  if (items.length === 0) return null;
  return (
    <>
      {items.map((item) => {
        const parts = parseStatusText(item.text).map((p, i) =>
          p.kind === "text" ? (
            <span key={i}>{p.value}</span>
          ) : (
            <span key={i} className={`codicon codicon-${p.name}${p.spin ? " codicon-modifier-spin" : ""}`} aria-hidden="true" />
          ),
        );
        const label = item.text.replace(/\$\([^)]*\)/g, "").trim();
        const style = item.color ? { color: item.color } : undefined;
        if (item.cancelProgress) {
          const pid = item.cancelProgress;
          return (
            <Tooltip key={item.id} label={item.tooltip ?? label}>
              <button
                type="button"
                className="status-item status-clickable status-ext"
                aria-label={`Cancelar: ${label}`}
                style={style}
                onClick={() => cancelExtProgress(pid)}
              >
                {parts}
              </button>
            </Tooltip>
          );
        }
        if (item.command) {
          const cmd = item.command;
          return (
            <Tooltip key={item.id} label={item.tooltip ?? cmd.title ?? label}>
              <button
                type="button"
                className="status-item status-clickable status-ext"
                aria-label={item.tooltip ?? label}
                style={style}
                onClick={() => void extHost.call("executeCommand", { command: cmd.command, args: cmd.arguments ?? [] }).catch(() => {})}
              >
                {parts}
              </button>
            </Tooltip>
          );
        }
        return (
          <span key={item.id} className="status-item status-ext" title={item.tooltip ?? label} role={item.progress ? "status" : undefined} style={style}>
            {parts}
          </span>
        );
      })}
    </>
  );
}
