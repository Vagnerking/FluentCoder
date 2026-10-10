/**
 * Menor edição (prefixo/sufixo comuns) que transforma `a` em `b`, em offsets
 * de `a`. Usada para aplicar o texto novo vindo do host como UMA edição
 * desfazível no modelo do Monaco (sem trocar o modelo inteiro).
 */
export function minimalEdit(a: string, b: string): { start: number; end: number; text: string } | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let tail = 0;
  while (tail < max - start && a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)) tail++;
  return { start, end: a.length - tail, text: b.slice(start, b.length - tail) };
}
