/**
 * Ordem persistida dos ícones da activity bar. Ids desconhecidos saem e views
 * adicionadas depois que a ordem foi salva (ex.: "extensions") entram no seu
 * lugar padrão — uma activity nova nunca zera a ordem personalizada.
 */
export function mergeActivityOrder(parsed: unknown, defaults: string[]): string[] {
  if (!Array.isArray(parsed)) return defaults;
  const known = parsed.filter((id, i): id is string => typeof id === "string" && defaults.includes(id) && parsed.indexOf(id) === i);
  if (known.length === 0) return defaults;
  const out = [...known];
  defaults.forEach((id, i) => {
    if (out.includes(id)) return;
    // Logo depois do default anterior mais próximo que já está na lista.
    const prev = defaults.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, id);
  });
  return out;
}
