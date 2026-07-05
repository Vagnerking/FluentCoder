//! Reconhecimento de referências a arquivos citadas pelo agente no chat, para
//! torná-las clicáveis (abrir no editor). Lógica pura, testável isoladamente.

/** Extensões de arquivo comuns que o editor sabe abrir — usadas para decidir se
 *  um `code` inline curto é uma referência de arquivo. */
const FILE_EXT =
  /\.(tsx?|jsx?|c?s?html?|css|scss|json|md|rs|cs|razor|py|go|java|kt|rb|php|ya?ml|toml|xml|sql|sh|ps1|txt|svg|vue|svelte)$/i;

/**
 * Detecta uma referência a arquivo num trecho de texto e devolve
 * `{ path, line }` — ou `null` se não parecer um arquivo. Aceita `caminho`,
 * `caminho:linha` e `caminho:linha:coluna`. Rejeita texto com espaços, chamadas
 * de método (`obj.Metodo(...)`) e identificadores sem extensão conhecida.
 */
export function parseFileRef(
  text: string,
): { path: string; line?: number } | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes("(")) return null;
  const match = trimmed.match(/^(.+?)(?::(\d+))?(?::\d+)?$/);
  if (!match) return null;
  const path = match[1];
  if (!FILE_EXT.test(path)) return null;
  // Omite `line` quando ausente (em vez de `line: undefined`) para um retorno
  // limpo — o consumidor faz `ref.line` normalmente.
  return match[2] ? { path, line: Number(match[2]) } : { path };
}

/** Junta um caminho possivelmente relativo à raiz do workspace, respeitando o
 *  separador nativo do path do workspace (Windows usa `\`). */
export function resolveWorkspacePath(
  workspacePath: string | null,
  path: string,
): string {
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
  if (isAbsolute || !workspacePath) return path;
  const sep = workspacePath.includes("\\") ? "\\" : "/";
  const normalized = path.replace(/[\\/]+/g, sep).replace(/^[\\/]+/, "");
  return `${workspacePath.replace(/[\\/]+$/, "")}${sep}${normalized}`;
}
