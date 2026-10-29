/**
 * Formatadores compartilhados das listas (Grafo, Branches, Remotos, Stashes,
 * Timeline…). Puros e testados em `format.test.ts`: datas relativas curtas em
 * pt-BR (o ISO completo vai para o tooltip) e autor truncado/iniciais.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function parse(value: string | number | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Data relativa curta: "agora", "há 5 min", "há 2 h", "ontem", "há 3 dias",
 * "há 2 sem.", "há 4 meses", "há 2 anos". Datas no futuro (relógio torto)
 * viram "agora". Entrada inválida volta como veio (string) ou "".
 */
export function formatRelativeDate(value: string | number | Date, now: number | Date = Date.now()): string {
  const d = parse(value);
  if (!d) return typeof value === "string" ? value : "";
  const ref = now instanceof Date ? now.getTime() : now;
  const diff = ref - d.getTime();
  if (diff < MINUTE) return "agora";
  if (diff < HOUR) return `há ${Math.floor(diff / MINUTE)} min`;
  if (diff < DAY) return `há ${Math.floor(diff / HOUR)} h`;
  if (diff < 2 * DAY) return "ontem";
  if (diff < WEEK) return `há ${Math.floor(diff / DAY)} dias`;
  if (diff < MONTH) {
    const w = Math.floor(diff / WEEK);
    return `há ${w} sem.`;
  }
  if (diff < YEAR) {
    const m = Math.floor(diff / MONTH);
    return m === 1 ? "há 1 mês" : `há ${m} meses`;
  }
  const y = Math.floor(diff / YEAR);
  return y === 1 ? "há 1 ano" : `há ${y} anos`;
}

/**
 * Data absoluta para tooltip/aria: "10/10/2026 18:04" (pt-BR, fuso local).
 * Entrada inválida volta como veio (string) ou "".
 */
export function formatAbsoluteDate(value: string | number | Date): string {
  const d = parse(value);
  if (!d) return typeof value === "string" ? value : "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Nomes que o git usa para "o próprio usuário" (blame/graph). */
const SELF_NAMES = new Set(["you", "voce", "você", "not committed yet"]);

/**
 * Autor para listas densas: "Você" para o próprio usuário; nomes longos
 * viram "Primeiro Ú." e, se ainda passarem de `max`, cortam com "…".
 * Nunca devolve uma letra solta como "Y" (de "You").
 */
export function formatAuthor(name: string, max = 18): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) return "";
  if (SELF_NAMES.has(clean.toLowerCase())) return "Você";
  if (clean.length <= max) return clean;
  const parts = clean.split(" ");
  if (parts.length > 1) {
    const short = `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
    if (short.length <= max) return short;
  }
  return `${clean.slice(0, Math.max(1, max - 1))}…`;
}

/** Iniciais para avatar (até 2 letras): "Rafael Gomes" → "RG"; "You" → "EU". */
export function authorInitials(name: string): string {
  const clean = name.trim();
  if (!clean) return "?";
  if (SELF_NAMES.has(clean.toLowerCase())) return "EU";
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
  return letters.toUpperCase();
}

const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/**
 * Data por extenso (hover card do grafo, como o VS Code pt-BR):
 * "9 de julho de 2026 às 17:05" (fuso local).
 */
export function formatLongDate(value: string | number | Date): string {
  const d = parse(value);
  if (!d) return typeof value === "string" ? value : "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()} às ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Data relativa por extenso: "agora", "há 5 minutos", "há 1 hora", "ontem",
 * "há 3 dias", "há 2 semanas", "há 3 meses", "há 1 ano".
 */
export function formatRelativeDateLong(value: string | number | Date, now: number | Date = Date.now()): string {
  const d = parse(value);
  if (!d) return typeof value === "string" ? value : "";
  const ref = now instanceof Date ? now.getTime() : now;
  const diff = ref - d.getTime();
  const plural = (n: number, one: string, many: string) => `há ${n} ${n === 1 ? one : many}`;
  if (diff < MINUTE) return "agora";
  if (diff < HOUR) return plural(Math.floor(diff / MINUTE), "minuto", "minutos");
  if (diff < DAY) return plural(Math.floor(diff / HOUR), "hora", "horas");
  if (diff < 2 * DAY) return "ontem";
  if (diff < WEEK) return plural(Math.floor(diff / DAY), "dia", "dias");
  if (diff < MONTH) return plural(Math.floor(diff / WEEK), "semana", "semanas");
  if (diff < YEAR) return plural(Math.floor(diff / MONTH), "mês", "meses");
  return plural(Math.floor(diff / YEAR), "ano", "anos");
}
