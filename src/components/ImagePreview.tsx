/**
 * Read-only image preview (ISSUE-70 · "Open With… ▸ Visualização de Imagem").
 *
 * The WebView can't load arbitrary local paths, so the bytes are read through
 * the Rust `read_file_base64` command and rendered as a `data:` URL. This is a
 * pure viewer — no editing, no dirty state — mirroring VS Code's built-in image
 * preview. It's selected per-tab via {@link OpenFile.mode}.
 */
import { useEffect, useState } from "react";
import { readFileBase64, readSshFileBase64 } from "../api";

interface ImagePreviewProps {
  /** Absolute path of the image file to display. */
  path: string;
  /** File name, shown in the caption. */
  name: string;
  /** Optional explicit SSH connection for multi-root workspace files. */
  connId?: string;
}

export function ImagePreview({ path, name, connId }: ImagePreviewProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);
    const read = connId ? readSshFileBase64(connId, path) : readFileBase64(path);
    read
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [connId, path]);

  return (
    <div className="image-preview">
      {error ? (
        <div className="image-preview-error">
          Não foi possível abrir a imagem:
          <br />
          {error}
        </div>
      ) : src ? (
        <div className="image-preview-stage">
          <img className="image-preview-img" src={src} alt={name} />
          <div className="image-preview-caption">{name}</div>
        </div>
      ) : (
        <div className="image-preview-loading">Carregando imagem…</div>
      )}
    </div>
  );
}
