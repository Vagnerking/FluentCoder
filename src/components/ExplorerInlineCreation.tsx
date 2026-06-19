import { useEffect, useRef, useState } from "react";
import { Codicon } from "../icons/codicons/Codicon";

export type PendingCreation = {
  kind: "file" | "folder";
  parentPath: string;
};

interface ExplorerInlineCreationProps {
  kind: PendingCreation["kind"];
  depth: number;
  busy: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function ExplorerInlineCreation({
  kind,
  depth,
  busy,
  error,
  onSubmit,
  onCancel,
}: ExplorerInlineCreationProps) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  return (
    <div className="explorer-inline-wrap">
      <div className="tree-row explorer-inline-row" style={{ paddingLeft: depth * 12 + 6 }}>
        <span className="tree-chevron" />
        <Codicon name={kind === "file" ? "newFile" : "newFolder"} size={16} />
        <input
          ref={inputRef}
          className="explorer-inline-input"
          aria-label={kind === "file" ? "Nome do novo arquivo" : "Nome da nova pasta"}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit(name);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
        />
        <button
          className="explorer-inline-confirm"
          type="button"
          aria-label="Confirmar criação"
          title="Confirmar criação"
          disabled={busy || !name.trim()}
          onClick={() => onSubmit(name)}
        >
          <Codicon name="success" size={14} />
        </button>
      </div>
      {error && (
        <div className="explorer-inline-error" role="alert" style={{ paddingLeft: depth * 12 + 34 }}>
          {error}
        </div>
      )}
    </div>
  );
}
