import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  outputChannels,
  outputLines,
  outputVersion,
  subscribeOutput,
} from "../output/outputStore";
import { Select } from "./ui";
import { ViewToolbar } from "../workbench/WorkbenchViews";

/**
 * The bottom panel's "Saída" tab (issue #6). Renders one output channel at a
 * time — picked from a selector — consuming the app-wide {@link outputStore}.
 * Replaces the old static "Sem saída." placeholder.
 */
export function OutputPanel() {
  // Re-render whenever any channel changes; the version is a stable snapshot.
  const version = useSyncExternalStore(subscribeOutput, outputVersion);
  const channels = useMemo(() => outputChannels(), [version]);
  const [selected, setSelected] = useState<string>("");

  // Default to the first channel; keep a valid selection as channels come/go.
  useEffect(() => {
    if (channels.length === 0) {
      if (selected !== "") setSelected("");
    } else if (!channels.includes(selected)) {
      setSelected(channels[0]);
    }
  }, [channels, selected]);

  const lines = useMemo(
    () => (selected ? outputLines(selected) : []),
    [version, selected]
  );

  if (channels.length === 0) {
    return <div className="panel-empty">Sem saída ainda.</div>;
  }

  return (
    <div className="output-panel">
      {/* Canal nas ações do cabeçalho da região (como no VS Code), liberando
          uma linha do conteúdo. */}
      <ViewToolbar>
        <Select
          id="output-channel"
          className="output-channel-select"
          size="sm"
          ariaLabel="Canal de saída"
          value={selected}
          onChange={setSelected}
          options={channels.map((c) => ({ value: c, label: c }))}
        />
      </ViewToolbar>
      <div className="output-lines" role="log" aria-label={`Saída: ${selected}`}>
        {lines.length === 0 ? (
          <div className="panel-empty">Canal vazio.</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="output-line">
              {line || " "}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
