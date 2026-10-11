/**
 * Ícone de arquivo/pasta do TEMA DE ÍCONES ATIVO (Material Icon Theme por
 * padrão, ou o de uma extensão — `src/icon-theme/iconThemeService.ts`).
 *
 * Componentes passam caminho/nome (e, para pastas, se está aberta / é raiz);
 * a resolução segue a ordem do VS Code (`src/icon-theme/engine.ts`). Imagens
 * SEMPRE via `<img>` (SVG de extensão nunca entra inline no DOM); ícones de
 * fonte viram um glifo com a `@font-face` do tema.
 */
import { resolveIconRender, useFileIconTheme } from "../iconThemeService";
import type { IconVariant } from "../engine";
import type { IconColorTheme } from "./icon-resolver";

interface FileIconProps {
  /** File/folder path or bare name (only the last segment is used). */
  path: string;
  /** True for a directory; selects folder resolution + open/closed variant. */
  isDir?: boolean;
  /** For folders, whether it's currently expanded (open-folder icon). */
  expanded?: boolean;
  /** Pasta raiz do workspace (`rootFolder*` do tema). */
  isRoot?: boolean;
  /** Força a variante clara/escura (padrão: segue o tema de cor ativo). */
  theme?: IconColorTheme;
  /** Pixel size of the square icon. Defaults to 16 (one explorer row). */
  size?: number;
  /** Extra class for state styling (e.g. dimmed for git-ignored files). */
  className?: string;
}

export function FileIcon({ path, isDir = false, expanded = false, isRoot = false, theme, size = 16, className }: FileIconProps) {
  useFileIconTheme();
  const variant: IconVariant | undefined = theme === "light" ? "light" : theme === "dark" ? "dark" : undefined;
  const icon = resolveIconRender({ path, isDir, expanded, isRoot, variant });
  const cls = `file-icon${icon?.kind === "font" ? " file-icon-font" : ""}${className ? ` ${className}` : ""}`;
  if (icon?.kind === "font") {
    return (
      <span
        className={cls}
        style={{ width: size, height: size, fontFamily: `"${icon.fontFamily}"`, color: icon.color, fontSize: icon.size ?? size, lineHeight: `${size}px` }}
        aria-hidden="true"
      >
        {icon.character}
      </span>
    );
  }
  return (
    <span className={cls} style={{ width: size, height: size }} aria-hidden="true">
      {icon && <img src={icon.src} width={size} height={size} alt="" draggable={false} />}
    </span>
  );
}
