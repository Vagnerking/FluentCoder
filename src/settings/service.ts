/**
 * `SettingsService`: o `ConfigurationService` do app. Junta o registro
 * (schema/defaults), o modelo em camadas e os ARQUIVOS de cada camada:
 *
 * | camada     | modo pasta (1 raiz)                         | modo workspace (multi-root / arquivo)          |
 * |------------|---------------------------------------------|------------------------------------------------|
 * | user       | `<app_config>/User/settings.json`           | idem                                           |
 * | workspace  | `<raiz>/.vscode/settings.json` + `.fluent/` | `settings` do `.fluent-workspace`/`.code-workspace` |
 * | folder     | (= workspace)                               | `<raiz>/.vscode/settings.json` + `.fluent/` por raiz |
 *
 * `.fluent/settings.json` vence `.vscode/settings.json` na mesma pasta. A
 * escrita vai para `.fluent/` (ou `.vscode/`, por `fluent.settings.workspaceWriteTarget`)
 * por edição JSONC pontual — comentários e chaves desconhecidas preservados.
 *
 * E/S injetada (`SettingsIO`) para os testes rodarem sem Tauri.
 */
import { parseJsoncObject, setJsoncValue } from "./jsonc.ts";
import {
  ConfigurationModel,
  EMPTY_LAYER,
  affects,
  changedKeys,
  folderFor,
  isPlainObject,
  mergeLayers,
  toLayer,
  type ConfigTarget,
  type FolderLayer,
  type Inspection,
  type Layer,
  type ResolveOptions,
} from "./model.ts";
import { validateSettingValue, type SettingsRegistry } from "./registry.ts";

export interface SettingsPathsInfo {
  userSettings: string;
  userKeybindings: string;
  legacyExtHostSettings?: string;
}

export interface SettingsIO {
  paths(): Promise<SettingsPathsInfo>;
  read(paths: string[]): Promise<Record<string, string | null>>;
  write(path: string, text: string): Promise<void>;
  watch(paths: string[]): Promise<void>;
  onFilesChanged(cb: (paths: string[]) => void): () => void;
}

export interface WorkspaceDescriptor {
  /** `empty` = sem pasta; `folder` = uma raiz local; `workspace` = multi-root/arquivo. */
  mode: "empty" | "folder" | "workspace";
  /** Raízes LOCAIS (raízes SSH ficam de fora nesta fase). */
  roots: string[];
  /** Arquivo de workspace salvo (`.fluent-workspace`/`.code-workspace`). */
  workspaceFile?: string | null;
  /** `settings` do workspace em memória (workspace ainda não salvo). */
  workspaceSettings?: Record<string, unknown> | null;
}

export interface SettingsChangeEvent {
  keys: ReadonlySet<string>;
  affectsConfiguration(section: string, resource?: string | null): boolean;
}

type ChangeListener = (e: SettingsChangeEvent) => void;

export interface UpdateOptions extends ResolveOptions {
  /** Override de linguagem: grava em `"[languageId]": { key: value }`. */
  overrideInLanguage?: boolean;
}

function join(dir: string, ...parts: string[]): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return [dir.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

/** User settings em memória (sem E/S: testes e antes do boot). */
const MEMORY_USER = "memory:/User/settings.json";

export function folderSettingsFiles(root: string): { vscode: string; fluent: string } {
  return { vscode: join(root, ".vscode", "settings.json"), fluent: join(root, ".fluent", "settings.json") };
}

/** Caminho JSONC da propriedade (com override de linguagem e o `settings` do arquivo de workspace). */
function jsonPath(key: string, opts: UpdateOptions, inWorkspaceFile: boolean): string[] {
  const p = opts.overrideInLanguage && opts.languageId ? [`[${opts.languageId}]`, key] : [key];
  return inWorkspaceFile ? ["settings", ...p] : p;
}

export class SettingsService {
  readonly model = new ConfigurationModel();
  private paths_: SettingsPathsInfo | null = null;
  private workspace: WorkspaceDescriptor = { mode: "empty", roots: [] };
  /** Último texto lido de cada arquivo (base das edições pontuais). */
  private texts = new Map<string, string | null>();
  private listeners = new Set<ChangeListener>();
  private storeListeners = new Set<() => void>();
  private version = 0;
  private writeChain: Promise<unknown> = Promise.resolve();
  private unlistenFiles: (() => void) | null = null;
  private onWorkspaceSettings: ((settings: Record<string, unknown>) => void) | null = null;
  private loaded = false;
  readonly registry: SettingsRegistry;
  private io: SettingsIO | null;

  constructor(registry: SettingsRegistry, io: SettingsIO | null) {
    this.registry = registry;
    this.io = io;
    this.model.setDefaults(registry.defaults());
    registry.onDidChange(() => {
      const before = this.model.defaults;
      this.model.setDefaults(registry.defaults());
      this.emit(changedKeys(before, this.model.defaults));
    });
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get settingsPaths(): SettingsPathsInfo | null {
    return this.paths_;
  }

  get workspaceDescriptor(): WorkspaceDescriptor {
    return this.workspace;
  }

  /** Carrega o perfil do usuário e liga o watcher. */
  async init(io?: SettingsIO): Promise<void> {
    if (io) this.io = io;
    if (!this.io) return;
    this.paths_ = await this.io.paths();
    this.unlistenFiles?.();
    this.unlistenFiles = this.io.onFilesChanged((paths) => void this.reloadFiles(paths));
    await this.reloadAll();
    this.loaded = true;
  }

  dispose(): void {
    this.unlistenFiles?.();
    this.unlistenFiles = null;
  }

  /** Troca o workspace (pasta aberta, multi-root, arquivo de workspace). */
  async setWorkspace(
    desc: WorkspaceDescriptor,
    onWorkspaceSettings?: (settings: Record<string, unknown>) => void,
  ): Promise<void> {
    this.workspace = { ...desc, roots: [...desc.roots] };
    this.onWorkspaceSettings = onWorkspaceSettings ?? null;
    await this.reloadAll();
  }

  /** Arquivos de todas as camadas (para ler e observar). */
  layerFiles(): string[] {
    const out: string[] = [];
    if (this.paths_) out.push(this.paths_.userSettings, this.paths_.userKeybindings);
    for (const root of this.workspace.roots) {
      const f = folderSettingsFiles(root);
      out.push(f.vscode, f.fluent);
    }
    if (this.workspace.mode === "workspace" && this.workspace.workspaceFile) out.push(this.workspace.workspaceFile);
    return out;
  }

  /** Texto atual de um arquivo de camada (null = não existe). */
  textOf(path: string): string | null {
    return this.texts.get(path) ?? null;
  }

  async reloadAll(): Promise<void> {
    if (!this.io) {
      this.recompute();
      return;
    }
    const files = this.layerFiles();
    const read = await this.io.read(files);
    for (const f of files) this.setText(f, read[f] ?? null);
    this.recompute();
    await this.io.watch(files).catch(() => {});
  }

  private async reloadFiles(paths: string[]): Promise<void> {
    if (!this.io) return;
    const files = this.layerFiles();
    // Criação de pasta (`.fluent/`) também chega aqui: relê tudo que é do workspace.
    const wanted = files.filter((f) => paths.some((p) => f === p || f.startsWith(p.replace(/[\\/]+$/, "") + "/") || f.startsWith(p.replace(/[\\/]+$/, "") + "\\")));
    const targets = wanted.length ? wanted : files;
    const read = await this.io.read(targets);
    for (const f of targets) this.setText(f, read[f] ?? null);
    this.recompute();
    // Pasta nova pode ter surgido: refaz o watch.
    await this.io.watch(files).catch(() => {});
  }

  private folderLayer(root: string): Layer {
    const f = folderSettingsFiles(root);
    return mergeLayers(
      toLayer(parseJsoncObject(this.texts.get(f.vscode)), this.registry),
      toLayer(parseJsoncObject(this.texts.get(f.fluent)), this.registry),
    );
  }

  private workspaceRaw(): Record<string, unknown> {
    const ws = this.workspace;
    if (ws.workspaceFile && this.texts.get(ws.workspaceFile) != null) {
      const s = parseJsoncObject(this.texts.get(ws.workspaceFile))["settings"];
      return isPlainObject(s) ? s : {};
    }
    return isPlainObject(ws.workspaceSettings) ? ws.workspaceSettings : {};
  }

  /** Recalcula as camadas a partir dos textos e emite as chaves que mudaram. */
  recompute(): void {
    const before = { user: this.model.user, workspace: this.model.workspace, folders: this.model.folders };
    const userText = this.texts.get(this.userFile());
    const user = this.paths_ || userText != null ? toLayer(parseJsoncObject(userText), this.registry) : this.model.user;
    let workspace: Layer = EMPTY_LAYER;
    let folders: FolderLayer[] = [];
    if (this.workspace.mode === "folder" && this.workspace.roots[0]) {
      workspace = this.folderLayer(this.workspace.roots[0]);
    } else if (this.workspace.mode === "workspace") {
      workspace = toLayer(this.workspaceRaw(), this.registry);
      folders = this.workspace.roots.map((root) => ({ root, layer: this.folderLayer(root) }));
    }
    this.model.user = user;
    this.model.workspace = workspace;
    this.model.folders = folders;
    const keys = new Set<string>([...changedKeys(before.user, user), ...changedKeys(before.workspace, workspace)]);
    const roots = new Set([...before.folders.map((f) => f.root), ...folders.map((f) => f.root)]);
    for (const root of roots) {
      const a = before.folders.find((f) => f.root === root)?.layer ?? EMPTY_LAYER;
      const b = folders.find((f) => f.root === root)?.layer ?? EMPTY_LAYER;
      for (const k of changedKeys(a, b)) keys.add(k);
    }
    this.emit(keys);
  }

  // ----------------------------------------------------------- leitura

  get<T = unknown>(key: string, opts: ResolveOptions = {}): T {
    const v = this.model.get<T>(key, opts);
    return (v === undefined ? (this.registry.get(key)?.default as T) : v) as T;
  }

  inspect<T = unknown>(key: string, opts: ResolveOptions = {}): Inspection<T> {
    return this.model.inspect<T>(key, opts);
  }

  /** Alvos de escrita disponíveis no workspace atual. */
  availableTargets(): ConfigTarget[] {
    if (this.workspace.mode === "empty") return ["user"];
    if (this.workspace.mode === "folder") return ["user", "workspace"];
    return this.workspace.roots.length ? ["user", "workspace", "folder"] : ["user", "workspace"];
  }

  /** O alvo é permitido pelo escopo da setting? (`application` só no Usuário etc.) */
  canWrite(key: string, target: ConfigTarget): boolean {
    const scope = this.registry.get(key)?.scope ?? "window";
    if (target === "user") return true;
    if (scope === "application" || scope === "machine") return false;
    if (target === "folder") return scope === "resource" || scope === "language-overridable";
    return true;
  }

  // ------------------------------------------------------------ escrita

  /**
   * Grava `value` (ou remove, com `undefined`) na camada `target`. Atualiza a
   * memória na hora (a UI não espera o watcher) e grava o arquivo com edição
   * pontual. Escritas são serializadas.
   */
  update(key: string, value: unknown, target: ConfigTarget, opts: UpdateOptions = {}): Promise<void> {
    // A memória muda JÁ (síncrono): quem lê logo depois vê o valor novo. Só a
    // gravação dos arquivos é assíncrona e serializada.
    let writes: { path: string; text: string }[];
    try {
      writes = this.applyUpdate(key, value, target, opts);
    } catch (err) {
      return Promise.reject(err);
    }
    if (!this.io || writes.length === 0) return Promise.resolve();
    const io = this.io;
    const run = async () => {
      for (const w of writes) await io.write(w.path, w.text.endsWith("\n") ? w.text : w.text + "\n");
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => {});
    return next;
  }

  private applyUpdate(key: string, value: unknown, target: ConfigTarget, opts: UpdateOptions): { path: string; text: string }[] {
    const schema = this.registry.get(key);
    if (value !== undefined && schema) {
      const err = validateSettingValue(schema, value);
      if (err) throw new Error(`${key}: ${err}`);
    }
    const writes: { path: string; text: string }[] = [];
    const edit = (path: string, segs: string[], v: unknown) => {
      const w = this.editText(path, segs, v);
      if (w) writes.push(w);
    };
    if (target === "user") {
      edit(this.userFile(), jsonPath(key, opts, false), value);
      return this.paths_ ? writes : [];
    }
    if (this.workspace.mode === "empty") throw new Error("Abra uma pasta para gravar configurações do workspace.");

    const root =
      target === "folder"
        ? folderFor(this.workspace.roots.map((r) => ({ root: r, layer: EMPTY_LAYER })), opts.resource)?.root ?? this.workspace.roots[0]
        : this.workspace.mode === "folder"
          ? this.workspace.roots[0]
          : null;

    if (root) {
      const files = folderSettingsFiles(root);
      const preferred = this.get<string>("fluent.settings.workspaceWriteTarget") === "vscode" ? files.vscode : files.fluent;
      const path = jsonPath(key, opts, false);
      if (value === undefined) {
        // Restaurar padrão remove dos DOIS arquivos — senão o `.vscode` voltaria a valer.
        for (const f of [files.fluent, files.vscode]) {
          if (this.texts.get(f) != null) edit(f, path, undefined);
        }
        return writes;
      }
      edit(preferred, path, value);
      // Se o outro arquivo tem a mesma chave e venceria (.fluent > .vscode), remove de lá.
      if (preferred === files.vscode && this.texts.get(files.fluent) != null) {
        edit(files.fluent, path, undefined);
      }
      return writes;
    }

    // Workspace multi-root: `settings` do arquivo de workspace (ou em memória).
    const ws = this.workspace;
    const path = jsonPath(key, opts, false);
    const nextSettings = (() => {
      const base = parseJsoncObject(JSON.stringify(this.workspaceRaw()));
      const text = setJsoncValue(JSON.stringify(base, null, 2), path, value);
      return parseJsoncObject(text);
    })();
    // Arquivo ilegível: nunca recriar (perderia `folders`) — fica em memória.
    if (ws.workspaceFile && this.texts.get(ws.workspaceFile) != null) {
      edit(ws.workspaceFile, jsonPath(key, opts, true), value);
    } else {
      this.workspace = { ...ws, workspaceSettings: nextSettings };
      this.recompute();
    }
    this.onWorkspaceSettings?.(nextSettings);
    return writes;
  }

  /** Arquivo do Usuário (em memória antes do boot / nos testes sem E/S). */
  private userFile(): string {
    return this.paths_?.userSettings ?? MEMORY_USER;
  }

  private editText(path: string, jsonPathSegs: string[], value: unknown): { path: string; text: string } | null {
    const current = this.texts.get(path) ?? "";
    if (value === undefined && !current.trim()) return null;
    const next = setJsoncValue(current, jsonPathSegs, value, { indent: current.trim() ? undefined : "  " });
    if (next === current) return null;
    this.setText(path, next);
    this.recompute();
    return { path, text: next };
  }

  /** Grava o texto inteiro de um arquivo de camada (editor JSON, migração). */
  async writeText(path: string, text: string): Promise<void> {
    this.setText(path, text);
    this.recompute();
    if (this.io) await this.io.write(path, text);
  }

  /** Arquivo onde uma escrita no `target` cairia (para "Abrir settings.json"). */
  fileFor(target: ConfigTarget, resource?: string | null): string | null {
    if (target === "user") return this.paths_?.userSettings ?? null;
    if (this.workspace.mode === "empty") return null;
    if (this.workspace.mode === "workspace" && target === "workspace") return this.workspace.workspaceFile ?? null;
    const root =
      target === "folder"
        ? folderFor(this.workspace.roots.map((r) => ({ root: r, layer: EMPTY_LAYER })), resource)?.root ?? this.workspace.roots[0]
        : this.workspace.roots[0];
    if (!root) return null;
    const files = folderSettingsFiles(root);
    if (this.texts.get(files.fluent) != null) return files.fluent;
    if (this.texts.get(files.vscode) != null) return files.vscode;
    return this.get<string>("fluent.settings.workspaceWriteTarget") === "vscode" ? files.vscode : files.fluent;
  }

  // ------------------------------------------------------------ eventos

  onDidChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Para `useSyncExternalStore`. */
  subscribe = (cb: () => void): (() => void) => {
    this.storeListeners.add(cb);
    return () => this.storeListeners.delete(cb);
  };

  getVersion = (): number => this.version;

  private textListeners = new Set<(path: string) => void>();

  /** Um arquivo de camada mudou de texto (ex.: keybindings.json, que não gera chaves). */
  onDidChangeText(cb: (path: string) => void): () => void {
    this.textListeners.add(cb);
    return () => this.textListeners.delete(cb);
  }

  private setText(path: string, text: string | null): void {
    const before = this.texts.get(path);
    this.texts.set(path, text);
    if ((before ?? null) !== text) for (const l of [...this.textListeners]) l(path);
  }

  private emit(keys: Set<string>): void {
    if (keys.size === 0) return;
    this.version++;
    const event: SettingsChangeEvent = { keys, affectsConfiguration: (section) => affects(keys, section) };
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        console.error("[settings] listener falhou", err);
      }
    }
    for (const l of [...this.storeListeners]) l();
  }
}
