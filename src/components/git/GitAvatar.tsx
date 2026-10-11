import { useEffect, useState } from "react";
import { gitAvatarInitials, peekGitAvatar, resolveGitAvatar } from "../../git/avatars";

interface GitAvatarProps {
  name: string | undefined | null;
  email: string | undefined | null;
  className: string;
  size?: number;
}

/**
 * Avatar do autor: iniciais imediatamente; troca pela imagem quando (e se) o
 * backend resolver um `data:` URL. Nunca carrega URL externa no DOM.
 */
export function GitAvatar({ name, email, className, size = 64 }: GitAvatarProps) {
  const [src, setSrc] = useState<string | null>(() => peekGitAvatar(email, size));
  useEffect(() => {
    let cancelled = false;
    setSrc(peekGitAvatar(email, size));
    void resolveGitAvatar(email, size).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [email, size]);
  return (
    <span className={className} aria-hidden="true">
      {src ? <img src={src} alt="" /> : gitAvatarInitials(name)}
    </span>
  );
}
