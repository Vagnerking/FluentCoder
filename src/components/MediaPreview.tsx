/**
 * Read-only video / audio player ("Open With… ▸ Reproduzir Vídeo/Áudio").
 *
 * Like {@link ImagePreview}, the WebView can't load arbitrary local (or remote)
 * paths, so the bytes are read through `readFileBase64` — which routes over SFTP
 * for a remote session — and rendered as a `data:` URL into a `<video>`/`<audio>`
 * element. Pure viewer: no editing, no dirty state.
 *
 * Note: base64 inlines the whole file in memory, so very large videos are heavy;
 * a streaming protocol is a future optimization.
 */
import { useEffect, useState } from "react";
import { readFileBase64 } from "../api";

interface MediaPreviewProps {
  /** Absolute path (local) or POSIX path (remote) of the media file. */
  path: string;
  /** File name, shown in the caption. */
  name: string;
  /** Which element to render. */
  kind: "video" | "audio";
}

export function MediaPreview({ path, name, kind }: MediaPreviewProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);
    readFileBase64(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const label = kind === "video" ? "o vídeo" : "o áudio";

  return (
    <div className="media-preview">
      {error ? (
        <div className="image-preview-error">
          Não foi possível abrir {label}:
          <br />
          {error}
        </div>
      ) : src ? (
        <div className="media-preview-stage">
          {kind === "video" ? (
            <video className="media-preview-video" src={src} controls autoPlay={false} />
          ) : (
            <audio className="media-preview-audio" src={src} controls />
          )}
          <div className="image-preview-caption">{name}</div>
        </div>
      ) : (
        <div className="image-preview-loading">Carregando {label}…</div>
      )}
    </div>
  );
}
