/**
 * Parser de `Properties/launchSettings.json` (milestone #9). Puro (sem I/O) para
 * ser testável em `node --test`. O debug usa o profile escolhido para injetar
 * env vars, args e a URL da aplicação no `launch` do netcoredbg.
 *
 * Só interessam os profiles de projeto (`commandName: "Project"`) — perfis de IIS
 * Express não se aplicam ao launch direto da DLL.
 */

/** Um profile de launchSettings pronto para o debug. */
export interface LaunchProfile {
  name: string;
  /** `environmentVariables` do profile (ex.: ASPNETCORE_ENVIRONMENT). */
  environmentVariables: Record<string, string>;
  /** `applicationUrl` → mapeado para ASPNETCORE_URLS. */
  applicationUrl?: string;
  /** `commandLineArgs` quebrado em tokens. */
  commandLineArgs?: string[];
}

/** Shape parcial do launchSettings.json. */
interface RawLaunchSettings {
  profiles?: Record<
    string,
    {
      commandName?: string;
      environmentVariables?: Record<string, string>;
      applicationUrl?: string;
      commandLineArgs?: string;
    }
  >;
}

/**
 * Faz o parse do conteúdo de um launchSettings.json e devolve os profiles de
 * projeto. Tolerante: JSON inválido ou ausência de `profiles` → lista vazia
 * (nunca lança). O BOM inicial (o SDK grava com BOM) é removido.
 */
export function parseLaunchSettings(content: string): LaunchProfile[] {
  let raw: RawLaunchSettings;
  try {
    raw = JSON.parse(content.replace(/^\uFEFF/, "")) as RawLaunchSettings;
  } catch {
    return [];
  }
  const profiles = raw.profiles ?? {};
  const out: LaunchProfile[] = [];
  for (const [name, p] of Object.entries(profiles)) {
    // Só profiles que rodam o projeto (não IIS Express / Executable externo).
    if (p.commandName && p.commandName !== "Project") continue;
    out.push({
      name,
      environmentVariables: { ...(p.environmentVariables ?? {}) },
      applicationUrl: p.applicationUrl,
      commandLineArgs: splitArgs(p.commandLineArgs),
    });
  }
  return out;
}

/**
 * Quebra uma linha de args em tokens, respeitando aspas duplas. Simples o
 * bastante para launchSettings (não trata escapes exóticos). Vazio → undefined.
 */
export function splitArgs(line: string | undefined): string[] | undefined {
  if (!line || !line.trim()) return undefined;
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] ?? m[2]);
  }
  return tokens.length ? tokens : undefined;
}
