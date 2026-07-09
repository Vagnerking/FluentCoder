/**
 * "Adicionar referência ao projeto" — quick fix cross-camada (issue #95,
 * milestone #11). Quando um `.cs` usa um tipo que existe em OUTRO projeto do
 * workspace que o projeto atual ainda não referencia (típico em DDD), o Roslyn
 * standalone não oferece nada útil (só "Gerar tipo"). Este provider Monaco
 * detecta o `CS0246` (tipo/namespace não encontrado), resolve o projeto dono do
 * tipo no backend e oferece adicionar a `ProjectReference` + o `using`.
 *
 * Este módulo é a lógica PURA (extração do identificador, montagem do título),
 * sem imports de Monaco/Tauri, para ser testável em `node --test`. O wiring do
 * provider fica em `addProjectReferenceProvider.ts`.
 */

/** O código do diagnóstico "tipo ou namespace não encontrado". */
export const MISSING_TYPE_CODE = "CS0246";

/**
 * Extrai o nome do tipo faltante da mensagem de um `CS0246`. As mensagens do
 * Roslyn variam por locale, mas o identificador vem sempre entre aspas — em
 * inglês `The type or namespace name 'Foo' could not be found`, em pt-BR
 * `O nome do tipo ou do namespace "Foo" não pode ser encontrado`. Aceita aspas
 * simples, duplas e curvas. Retorna null se não achar um identificador válido.
 */
export function typeNameFromMissingTypeMessage(message: string): string | null {
  // Primeiro token entre aspas (', ", ‘ ’, “ ”) que seja um identificador C#.
  const m = message.match(/['"‘’“”]([A-Za-z_]\w*)['"‘’“”]/);
  return m ? m[1] : null;
}

/** O nome de exibição de um `.csproj` (basename sem extensão). */
export function csprojDisplayName(csprojPath: string): string {
  const base = csprojPath.replace(/\\/g, "/").split("/").pop() ?? csprojPath;
  return base.replace(/\.csproj$/i, "");
}

/**
 * True quando um diagnóstico é um `CS0246` acionável por este quick fix. Aceita o
 * code como string (`"CS0246"`) ou como objeto `{ value }` (forma do Monaco/LSP).
 */
export function isMissingTypeDiagnostic(code: unknown): boolean {
  if (typeof code === "string") return code === MISSING_TYPE_CODE;
  if (code && typeof code === "object" && "value" in code) {
    return String((code as { value: unknown }).value) === MISSING_TYPE_CODE;
  }
  return false;
}

/**
 * O `.csproj` que contém o arquivo `.cs` em `filePath`: o mais próximo subindo os
 * diretórios (o dono do arquivo). Espelha `owning_csproj` do backend para o lado
 * do editor decidir o "from" da referência. Retorna null se nenhum for ancestral.
 */
export function owningCsproj(filePath: string, csprojs: readonly string[]): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const fileDir = norm(filePath).replace(/\/[^/]*$/, "");
  let best: string | null = null;
  let bestLen = -1;
  for (const c of csprojs) {
    const cdir = norm(c).replace(/\/[^/]*$/, "");
    if (fileDir === cdir || fileDir.startsWith(cdir + "/")) {
      if (cdir.length > bestLen) {
        bestLen = cdir.length;
        best = c;
      }
    }
  }
  return best;
}
