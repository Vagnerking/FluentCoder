/**
 * Renders a Codicon for a semantic UI action.
 *
 * Usage: `<Codicon name="save" />`. The component resolves the action through
 * {@link CODICON_MAP}, so callers stay decoupled from the underlying glyph. The
 * codicon web-font + CSS is imported once here, so importing this component is
 * all a screen needs to use any UI icon.
 *
 * Color and size are inherited from the surrounding text (`currentColor`,
 * `font-size`) unless overridden, which keeps icons consistent with their
 * buttons and works in both light and dark themes for free.
 */
import "@vscode/codicons/dist/codicon.css";
import { CODICON_MAP, SPINNING, type IconAction } from "./codicon-map";

interface CodiconProps {
  name: IconAction;
  /** Pixel size; defaults to inheriting the surrounding font-size. */
  size?: number;
  /** Force the spin animation (loading/sync). Auto-on for inherently-spinning icons. */
  spin?: boolean;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
}

export function Codicon({
  name,
  size,
  spin,
  className,
  title,
  style,
}: CodiconProps) {
  const glyph = CODICON_MAP[name];
  const spinning = spin ?? SPINNING.has(name);
  return (
    <span
      className={[
        "codicon",
        `codicon-${glyph}`,
        spinning ? "codicon-modifier-spin" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={title}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
      style={size ? { fontSize: size, ...style } : style}
    />
  );
}
