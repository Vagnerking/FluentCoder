import { useEffect, useRef, useState } from "react";
import { IconButton } from "./ui/IconButton";
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
          className="ui-input ui-input-sm explorer-inline-input"
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
        <IconButton
          icon="success"
          size="sm"
          label="Confirmar criação"
          className="explorer-inline-confirm"
          disabled={busy || !name.trim()}
          onClick={() => onSubmit(name)}
        />
      </div>
      {error && (
        <div className="explorer-inline-error" role="alert" style={{ paddingLeft: depth * 12 + 34 }}>
          {error}
        </div>
      )}
    </div>
  );
}
