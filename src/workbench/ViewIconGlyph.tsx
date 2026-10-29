import { Codicon } from "../icons/codicons/Codicon";
import type { ViewIcon } from "./viewRegistry";

/**
 * Ícone de uma view: codicon do app ou a imagem da própria extensão (SVG/PNG
 * do pacote, data URI vindo do host). A imagem é usada como MÁSCARA
 * monocromática (cor do texto, como os codicons e como o VS Code faz nas
 * activity bars) — nunca carregada como documento. Decorativo: o rótulo da
 * aba/botão é o nome acessível.
 */
export function ViewIconGlyph({ icon, size = 16, className }: { icon: ViewIcon; size?: number; className?: string }) {
  if ("codicon" in icon) return <Codicon name={icon.codicon} size={size} className={className} />;
  const url = `url("${icon.src.replace(/"/g, "%22")}")`;
  return (
    <span
      aria-hidden="true"
      className={`view-icon-img${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, WebkitMaskImage: url, maskImage: url }}
    />
  );
}
