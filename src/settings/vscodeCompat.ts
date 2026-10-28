/**
 * Compatibilidade com os arquivos `.vscode/` (puro, testável):
 *
 * - `extensions.json` → recomendações do workspace (view Extensões);
 * - `tasks.json` → tarefas executáveis no terminal integrado (Executar e Depurar
 *   + Paleta "Tarefas: Executar Tarefa…"/"…de Build");
 * - `launch.json` → configurações que o app consegue executar SEM depurador
 *   (node/coreclr/python com `program`) — a depuração .NET continua pela seção
 *   própria (netcoredbg) do Executar e Depurar.
 *
 * Mapeamento completo em docs/context/configuracoes.md.
 */
import { parseJsoncObject } from "./jsonc.ts";

// ------------------------------------------------------------ extensions.json

export interface ExtensionRecommendations {
  recommendations: string[];
  unwanted: string[];
}

const EXT_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-._]*$/i;

/** Junta `recommendations`/`unwantedRecommendations` de vários arquivos (ids em minúsculas, sem duplicatas). */
export function parseExtensionRecommendations(sources: readonly (string | Record<string, unknown> | null | undefined)[]): ExtensionRecommendations {
  const rec = new Set<string>();
  const unwanted = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    const obj = typeof src === "string" ? parseJsoncObject(src) : src;
    for (const [key, set] of [["recommendations", rec], ["unwantedRecommendations", unwanted]] as const) {
      const list = obj[key];
      if (!Array.isArray(list)) continue;
      for (const id of list) if (typeof id === "string" && EXT_ID.test(id.trim())) set.add(id.trim().toLowerCase());
    }
  }
  for (const u of unwanted) rec.delete(u);
  return { recommendations: [...rec], unwanted: [...unwanted] };
}

// ------------------------------------------------------------------ variáveis

export interface VariableContext {
  workspaceFolder: string;
  file?: string | null;
  /** `${config:x}`. */
  config?: (key: string) => unknown;
  env?: Record<string, string | undefined>;
  pathSeparator?: string;
}

/** `${workspaceFolder}`, `${workspaceFolderBasename}`, `${file}`, `${fileBasename}`, `${fileDirname}`, `${relativeFile}`, `${cwd}`, `${pathSeparator}`, `${env:X}`, `${config:x}`. */
export function substituteVariables(value: string, ctx: VariableContext): string {
  const sep = ctx.pathSeparator ?? (ctx.workspaceFolder.includes("\\") ? "\\" : "/");
  const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  const dir = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
  return value.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const file = ctx.file ?? "";
    switch (name) {
      case "workspaceFolder":
      case "workspaceRoot":
      case "cwd":
        return ctx.workspaceFolder;
      case "workspaceFolderBasename":
        return base(ctx.workspaceFolder);
      case "file":
        return file;
      case "fileBasename":
        return base(file);
      case "fileBasenameNoExtension":
        return base(file).replace(/\.[^.]*$/, "");
      case "fileExtname":
        return /\.[^.\\/]*$/.exec(file)?.[0] ?? "";
      case "fileDirname":
        return dir(file);
      case "relativeFile":
        return file.startsWith(ctx.workspaceFolder) ? file.slice(ctx.workspaceFolder.length).replace(/^[\\/]/, "") : file;
      case "pathSeparator":
      case "/":
        return sep;
    }
    if (name.startsWith("env:")) return ctx.env?.[name.slice(4)] ?? "";
    if (name.startsWith("config:")) {
      const v = ctx.config?.(name.slice(7));
      return v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
    }
    return whole; // desconhecida (input:, command:): fica literal
  });
}

/** Argumento literal no shell padrão do backend: PowerShell no Windows, POSIX nos demais. */
export function shellQuote(arg: string, windows = false, force = false): string {
  // PowerShell expande $() em aspas duplas e aceita também aspas tipográficas
  // como delimitadores. Sempre citar evita ainda @args (splatting) e arrays.
  if (windows) return `'${arg.replace(/['\u2018-\u201b]/g, "$&$&")}'`;
  if (!force && arg !== "" && /^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function withWorkingDirectory(command: string, cwd: string, windows: boolean): string {
  if (!cwd) return command;
  // -LiteralPath impede que colchetes no nome virem padrões de wildcard.
  return windows
    ? `Set-Location -LiteralPath ${shellQuote(cwd, true)}; ${command}`
    : `cd -- ${shellQuote(cwd)} && ${command}`;
}

// ----------------------------------------------------------------- tasks.json

export interface VscodeTask {
  label: string;
  /** Linha de comando pronta para o terminal (null = não suportada). */
  command: string | null;
  /** Diretório (variáveis resolvidas); vazio = raiz. */
  cwd: string;
  group: "build" | "test" | null;
  isDefault: boolean;
  dependsOn: string[];
  /** Motivo quando `command` é null. */
  unsupported?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function osBlock(task: Obj, os: "windows" | "linux" | "osx"): Obj {
  const o = task[os];
  return isObj(o) ? { ...task, ...o } : task;
}

function argText(a: unknown): string | null {
  if (typeof a === "string") return a;
  if (isObj(a) && typeof a.value === "string") return a.value;
  return null;
}

export function parseTasks(text: string | null | undefined, ctx: VariableContext, os: "windows" | "linux" | "osx" = "linux"): VscodeTask[] {
  const root = parseJsoncObject(text);
  const list = Array.isArray(root.tasks) ? root.tasks : [];
  const top = osBlock(root, os);
  const out: VscodeTask[] = [];
  const sub = (s: string) => substituteVariables(s, ctx);
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const t = osBlock(raw, os);
    const type = typeof t.type === "string" ? t.type : typeof top.type === "string" ? top.type : "process";
    const label = typeof t.label === "string" ? t.label : typeof t.taskName === "string" ? t.taskName : typeof t.script === "string" ? `npm: ${t.script}` : "tarefa";
    const options = isObj(t.options) ? t.options : isObj(top.options) ? top.options : {};
    const cwd = typeof options.cwd === "string" ? sub(options.cwd) : "";
    const groupRaw = t.group;
    const groupKind = typeof groupRaw === "string" ? groupRaw : isObj(groupRaw) && typeof groupRaw.kind === "string" ? groupRaw.kind : null;
    const isDefault = isObj(groupRaw) && groupRaw.isDefault === true;
    const dependsOn = typeof t.dependsOn === "string" ? [t.dependsOn] : Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === "string") : [];
    let command: string | null = null;
    let unsupported: string | undefined;
    const windows = os === "windows";
    if (type === "shell" || type === "process") {
      const cmd = argText(t.command) ?? argText(top.command);
      const args = (Array.isArray(t.args) ? t.args : Array.isArray(top.args) ? top.args : []).map(argText).filter((a): a is string => a !== null);
      if (cmd) {
        // `shell.command` é código intencional; `process.command` é um único
        // executável. No PowerShell, invocar um nome citado exige o operador &.
        const executable = type === "process" ? `${windows ? "& " : ""}${shellQuote(sub(cmd), windows, true)}` : sub(cmd);
        const parts = [executable, ...args.map((a) => shellQuote(sub(a), windows))];
        command = parts.join(" ");
      } else if (dependsOn.length) {
        unsupported = undefined; // tarefa composta: roda as dependências
      } else unsupported = "sem comando";
    } else if (type === "npm" && typeof t.script === "string") {
      command = `npm run ${shellQuote(t.script, windows)}`;
    } else {
      unsupported = `tipo "${type}" não suportado (só shell, process e npm)`;
    }
    // npm: `path` é a pasta do package.json.
    const npmDir = type === "npm" && typeof t.path === "string" ? sub(t.path) : "";
    out.push({
      label,
      command,
      cwd: npmDir || cwd,
      group: groupKind === "build" || groupKind === "test" ? groupKind : null,
      isDefault,
      dependsOn,
      ...(unsupported ? { unsupported } : {}),
    });
  }
  return out;
}

/** Linha final de uma tarefa, rodando `dependsOn` antes (em sequência). */
export function taskCommandLine(task: VscodeTask, all: readonly VscodeTask[], windows = false, seen = new Set<string>()): string | null {
  if (seen.has(task.label)) return null;
  seen.add(task.label);
  const parts: string[] = [];
  for (const dep of task.dependsOn) {
    const d = all.find((t) => t.label === dep);
    const line = d ? taskCommandLine(d, all, windows, seen) : null;
    if (line) parts.push(line);
  }
  if (task.command) parts.push(withWorkingDirectory(task.command, task.cwd, windows));
  if (!parts.length) return null;
  return parts.join(windows ? "; " : " && ");
}

/** Tarefa de build padrão (Ctrl+Shift+B): a `isDefault` do grupo build, senão a única do grupo. */
export function defaultBuildTask(tasks: readonly VscodeTask[]): VscodeTask | null {
  const build = tasks.filter((t) => t.group === "build" && (t.command || t.dependsOn.length));
  return build.find((t) => t.isDefault) ?? (build.length === 1 ? build[0] : null);
}

// ---------------------------------------------------------------- launch.json

export interface VscodeLaunch {
  name: string;
  type: string;
  request: string;
  /** Comando para "Executar sem depurar" (null = não mapeado). */
  command: string | null;
  cwd: string;
  preLaunchTask: string | null;
  unsupported?: string;
}

/** Composição usada pela view: cwd e preLaunchTask seguem os mesmos contratos das tarefas. */
export function launchCommandLine(launch: VscodeLaunch, tasks: readonly VscodeTask[], windows = false): string | null {
  if (!launch.command) return null;
  const task = launch.preLaunchTask ? tasks.find((t) => t.label === launch.preLaunchTask) : undefined;
  const pre = task ? taskCommandLine(task, tasks, windows) : null;
  const main = withWorkingDirectory(launch.command, launch.cwd, windows);
  return pre ? `${pre}${windows ? "; " : " && "}${main}` : main;
}

const RUNNERS: Record<string, string> = {
  node: "node",
  "pwa-node": "node",
  coreclr: "dotnet",
  clr: "dotnet",
  dotnet: "dotnet",
  python: "python",
  debugpy: "python",
};

export function parseLaunch(text: string | null | undefined, ctx: VariableContext, os: "windows" | "linux" | "osx" = "linux"): VscodeLaunch[] {
  const root = parseJsoncObject(text);
  const list = Array.isArray(root.configurations) ? root.configurations : [];
  const sub = (s: string) => substituteVariables(s, ctx);
  const windows = os === "windows";
  return list.filter(isObj).map((rawCfg): VscodeLaunch => {
    const c = osBlock(rawCfg, os);
    const type = typeof c.type === "string" ? c.type : "";
    const request = typeof c.request === "string" ? c.request : "launch";
    const name = typeof c.name === "string" ? c.name : type || "configuração";
    const cwd = typeof c.cwd === "string" ? sub(c.cwd) : "";
    const preLaunchTask = typeof c.preLaunchTask === "string" ? c.preLaunchTask : null;
    const runner = RUNNERS[type];
    const program = typeof c.program === "string" ? sub(c.program) : null;
    const args = Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === "string").map((a) => shellQuote(sub(a), windows)) : [];
    if (request !== "launch") return { name, type, request, command: null, cwd, preLaunchTask, unsupported: "attach: use a seção de depuração .NET" };
    if (!runner) return { name, type, request, command: null, cwd, preLaunchTask, unsupported: `tipo "${type}" sem equivalente no app` };
    if (!program) {
      // `dotnet` (C# Dev Kit) aponta para o projeto: `dotnet run`.
      if (type === "dotnet" && typeof c.projectPath === "string") {
        return { name, type, request, command: `dotnet run --project ${shellQuote(sub(c.projectPath), windows)}`, cwd, preLaunchTask };
      }
      return { name, type, request, command: null, cwd, preLaunchTask, unsupported: "sem program" };
    }
    return { name, type, request, command: [runner, shellQuote(program, windows), ...args].join(" "), cwd, preLaunchTask };
  });
}
