/**
 * .NET debug session manager (netcoredbg). Owns the DAP dance:
 *   ensure netcoredbg → dap_start_session (`--interpreter=vscode`) → WS →
 *   initialize → launch(dotnet <dll>) | attach(pid) → [event initialized] →
 *   setBreakpoints (every file that has any) → configurationDone →
 *   [event stopped] → threads → stackTrace → scopes → variables.
 *
 * Breakpoints live HERE (per absolute file path, 1-based lines, with optional
 * condition/hitCondition/logMessage) so they survive across sessions; the editor
 * renders them and calls `toggleBreakpoint`/`setBreakpointSpec`. React subscribes
 * via `subscribe`/`getState` (useSyncExternalStore-friendly).
 *
 * Milestone #9 additions: conditional breakpoints/logpoints/hit-count, an
 * expandable variables tree (lazy `variables` by reference) with a selectable
 * stack frame, watch expressions (`evaluate`), and launchSettings.json profiles.
 */
import {
  dapEnsureNetcoredbg,
  dapListDotnetProcesses,
  dapResolveDotnetTarget,
  dapStartSession,
  dapStopSession,
  type DotnetProcess,
} from "../api";
import { DapClient } from "./client";
import { toFileUri } from "../lsp/uri";
import type { LaunchProfile } from "./launchSettings";

export type DebugStatus = "idle" | "starting" | "running" | "stopped" | "error";

export interface StackFrameView {
  id: number;
  name: string;
  path?: string;
  line?: number;
}

/** A variable node in the (lazily expanded) tree. */
export interface VariableView {
  name: string;
  value: string;
  type?: string;
  /** DAP reference to fetch children; 0 = leaf (no children). */
  variablesReference: number;
}

export interface ScopeView {
  name: string;
  variablesReference: number;
  variables: VariableView[];
}

/** A watch expression and its last evaluation. */
export interface WatchView {
  expression: string;
  value?: string;
  type?: string;
  variablesReference: number;
  error?: string;
}

/** Optional conditions on a breakpoint (all absent = a plain breakpoint). */
export interface BreakpointSpec {
  /** Break only when this expression is true. */
  condition?: string;
  /** Break after N hits (e.g. "5", ">3"). */
  hitCondition?: string;
  /** Logpoint: log this message instead of breaking (`{expr}` interpolated). */
  logMessage?: string;
}

/** A breakpoint as surfaced to the editor: line + its spec. */
export interface BreakpointView extends BreakpointSpec {
  line: number;
}

export interface DebugState {
  status: DebugStatus;
  error?: string;
  /** Console/debuggee output lines (bounded). */
  output: string[];
  frames: StackFrameView[];
  /** Id of the frame whose scopes are shown (defaults to the top frame). */
  selectedFrameId?: number;
  /** Scopes+variables of the selected frame. */
  scopes: ScopeView[];
  /** Lazily fetched children, keyed by `variablesReference`. */
  children: Record<number, VariableView[]>;
  /** Watch expressions and their last values. */
  watches: WatchView[];
  /** Absolute path → breakpoints (line + optional spec). */
  breakpoints: Record<string, BreakpointView[]>;
  /** Where execution is stopped (drives the editor line highlight). */
  stoppedAt?: { path: string; line: number };
}

const SESSION_ID = "netcoredbg";
const MAX_OUTPUT_LINES = 500;

type Listener = () => void;

class DebugSessionManager {
  private client: DapClient | null = null;
  private threadId: number | null = null;
  private breakpoints = new Map<string, Map<number, BreakpointSpec>>();
  private watchExprs: string[] = [];
  private listeners = new Set<Listener>();
  private state: DebugState = {
    status: "idle",
    output: [],
    frames: [],
    scopes: [],
    children: {},
    watches: [],
    breakpoints: {},
  };

  // ── React wiring ──────────────────────────────────────────────────────────
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = (): DebugState => this.state;

  private setState(patch: Partial<DebugState>): void {
    this.state = {
      ...this.state,
      ...patch,
      breakpoints: Object.fromEntries(
        [...this.breakpoints.entries()].map(([p, m]) => [
          p,
          [...m.entries()]
            .map(([line, spec]) => ({ line, ...spec }))
            .sort((a, b) => a.line - b.line),
        ])
      ),
    };
    for (const l of [...this.listeners]) l();
  }

  // ── breakpoints ───────────────────────────────────────────────────────────
  /** Toggles a plain breakpoint on/off at `line` (keeps any existing spec off). */
  toggleBreakpoint(path: string, line: number): void {
    const map = this.breakpoints.get(path) ?? new Map<number, BreakpointSpec>();
    if (map.has(line)) map.delete(line);
    else map.set(line, {});
    this.commitBreakpoints(path, map);
  }

  /** Sets (or updates) a breakpoint's condition/hitCondition/logMessage. An
   *  all-empty spec removes the breakpoint. */
  setBreakpointSpec(path: string, line: number, spec: BreakpointSpec): void {
    const map = this.breakpoints.get(path) ?? new Map<number, BreakpointSpec>();
    const clean: BreakpointSpec = {};
    if (spec.condition?.trim()) clean.condition = spec.condition.trim();
    if (spec.hitCondition?.trim()) clean.hitCondition = spec.hitCondition.trim();
    if (spec.logMessage?.trim()) clean.logMessage = spec.logMessage.trim();
    // Keep the breakpoint even if the spec is empty (an explicit set = "on").
    map.set(line, clean);
    this.commitBreakpoints(path, map);
  }

  private commitBreakpoints(path: string, map: Map<number, BreakpointSpec>): void {
    if (map.size === 0) this.breakpoints.delete(path);
    else this.breakpoints.set(path, map);
    this.setState({});
    if (this.client) void this.pushBreakpoints(path);
  }

  breakpointsFor(path: string): BreakpointView[] {
    const map = this.breakpoints.get(path);
    if (!map) return [];
    return [...map.entries()]
      .map(([line, spec]) => ({ line, ...spec }))
      .sort((a, b) => a.line - b.line);
  }

  private async pushBreakpoints(path: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.request("setBreakpoints", {
        source: { path },
        breakpoints: this.breakpointsFor(path).map((bp) => ({
          line: bp.line,
          // Only include the DAP fields that are set (netcoredbg ignores empties,
          // but keeping the payload minimal avoids surprises).
          ...(bp.condition ? { condition: bp.condition } : {}),
          ...(bp.hitCondition ? { hitCondition: bp.hitCondition } : {}),
          ...(bp.logMessage ? { logMessage: bp.logMessage } : {}),
        })),
      });
    } catch (err) {
      this.appendOutput(`[breakpoints] ${String(err)}`);
    }
  }

  // ── watch expressions ─────────────────────────────────────────────────────
  addWatch(expression: string): void {
    const e = expression.trim();
    if (!e || this.watchExprs.includes(e)) return;
    this.watchExprs.push(e);
    void this.refreshWatches();
  }

  removeWatch(expression: string): void {
    this.watchExprs = this.watchExprs.filter((e) => e !== expression);
    this.setState({ watches: this.state.watches.filter((w) => w.expression !== expression) });
  }

  /** Re-evaluates every watch against the selected frame (on stop / frame change). */
  private async refreshWatches(): Promise<void> {
    const client = this.client;
    const frameId = this.state.selectedFrameId;
    const watches: WatchView[] = [];
    for (const expression of this.watchExprs) {
      if (!client || frameId == null) {
        watches.push({ expression, variablesReference: 0, error: "não pausado" });
        continue;
      }
      try {
        const r = await client.request<{
          result: string;
          type?: string;
          variablesReference?: number;
        }>("evaluate", { expression, frameId, context: "watch" });
        watches.push({
          expression,
          value: r.result,
          type: r.type,
          variablesReference: r.variablesReference ?? 0,
        });
      } catch (err) {
        watches.push({ expression, variablesReference: 0, error: shortErr(err) });
      }
    }
    this.setState({ watches });
  }

  // ── variables tree (lazy) ─────────────────────────────────────────────────
  /** Fetches (once) and caches the children of `variablesReference`. */
  async expand(variablesReference: number): Promise<void> {
    const client = this.client;
    if (!client || !variablesReference || this.state.children[variablesReference]) return;
    try {
      const r = await client.request<{
        variables?: { name: string; value: string; type?: string; variablesReference?: number }[];
      }>("variables", { variablesReference });
      const children: VariableView[] = (r.variables ?? []).map((v) => ({
        name: v.name,
        value: v.value,
        type: v.type,
        variablesReference: v.variablesReference ?? 0,
      }));
      this.setState({ children: { ...this.state.children, [variablesReference]: children } });
    } catch (err) {
      this.appendOutput(`[variables] ${String(err)}`);
    }
  }

  /** Selects a stack frame and refreshes its scopes + watches. */
  async selectFrame(frameId: number): Promise<void> {
    if (this.state.selectedFrameId === frameId) return;
    this.setState({ selectedFrameId: frameId, scopes: [], children: {} });
    await this.loadScopes(frameId);
    await this.refreshWatches();
  }

  private async loadScopes(frameId: number): Promise<void> {
    const client = this.client;
    if (!client) return;
    const sc = await client.request<{ scopes?: { name: string; variablesReference: number }[] }>(
      "scopes",
      { frameId }
    );
    const scopes: ScopeView[] = [];
    for (const s of sc.scopes ?? []) {
      if (!s.variablesReference) continue;
      const vars = await client.request<{
        variables?: { name: string; value: string; type?: string; variablesReference?: number }[];
      }>("variables", { variablesReference: s.variablesReference });
      scopes.push({
        name: s.name,
        variablesReference: s.variablesReference,
        variables: (vars.variables ?? []).map((v) => ({
          name: v.name,
          value: v.value,
          type: v.type,
          variablesReference: v.variablesReference ?? 0,
        })),
      });
    }
    this.setState({ scopes });
  }

  // ── session lifecycle ─────────────────────────────────────────────────────

  /** Build the csproj and launch its DLL under the debugger, honoring a
   *  launchSettings.json profile (env vars, args, ASPNETCORE_URLS) when given. */
  async launchProject(csprojPath: string, cwd: string, profile?: LaunchProfile): Promise<void> {
    await this.start(async (client) => {
      this.appendOutput(`[build] dotnet build ${csprojPath}`);
      const dll = await dapResolveDotnetTarget(csprojPath);
      this.appendOutput(`[launch] dotnet ${dll}${profile ? ` (${profile.name})` : ""}`);
      const env = profile ? { ...profile.environmentVariables } : undefined;
      if (env && profile?.applicationUrl) env.ASPNETCORE_URLS = profile.applicationUrl;
      const args = [dll, ...(profile?.commandLineArgs ?? [])];
      await client.request("launch", {
        name: ".NET Launch",
        type: "coreclr",
        request: "launch",
        program: "dotnet",
        args,
        cwd,
        stopAtEntry: false,
        console: "internalConsole",
        ...(env && Object.keys(env).length ? { env } : {}),
      });
    });
  }

  /** Attach to a running dotnet process. */
  async attach(pid: number): Promise<void> {
    await this.start(async (client) => {
      this.appendOutput(`[attach] pid ${pid}`);
      await client.request("attach", { name: ".NET Attach", type: "coreclr", request: "attach", processId: pid });
    });
  }

  listProcesses(): Promise<DotnetProcess[]> {
    return dapListDotnetProcesses();
  }

  private async start(requestSession: (client: DapClient) => Promise<void>): Promise<void> {
    if (this.client) await this.stop();
    this.setState({
      status: "starting",
      error: undefined,
      output: [],
      frames: [],
      scopes: [],
      children: {},
      selectedFrameId: undefined,
      stoppedAt: undefined,
    });
    try {
      const exe = await dapEnsureNetcoredbg();
      const info = await dapStartSession(SESSION_ID, exe, ["--interpreter=vscode"], ".");
      const client = await DapClient.connect(info.port, info.token);
      this.client = client;
      this.wireEvents(client);

      await client.request("initialize", {
        clientID: "fluent-coder",
        adapterID: "coreclr",
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        locale: "pt-BR",
        supportsRunInTerminalRequest: false,
      });

      // `initialized` may fire during launch/attach — configuration happens in
      // the event handler (wireEvents) per the DAP contract.
      await requestSession(client);
      this.setState({ status: "running" });
    } catch (err) {
      this.appendOutput(`[erro] ${String(err)}`);
      this.setState({ status: "error", error: String(err) });
      await this.stop();
    }
  }

  private wireEvents(client: DapClient): void {
    client.on("initialized", () => {
      void (async () => {
        for (const path of this.breakpoints.keys()) await this.pushBreakpoints(path);
        try {
          await client.request("configurationDone");
        } catch (err) {
          this.appendOutput(`[configurationDone] ${String(err)}`);
        }
      })();
    });
    client.on("output", (body) => {
      const b = body as { output?: string };
      if (b?.output) this.appendOutput(b.output.replace(/\r?\n$/, ""));
    });
    client.on("stopped", (body) => {
      const b = body as { threadId?: number; reason?: string };
      this.threadId = b?.threadId ?? this.threadId;
      this.appendOutput(`[parado] ${b?.reason ?? ""}`);
      void this.refreshStopped();
    });
    client.on("continued", () => {
      this.setState({
        status: "running",
        frames: [],
        scopes: [],
        children: {},
        selectedFrameId: undefined,
        stoppedAt: undefined,
      });
    });
    const ended = (): void => {
      void this.stop();
    };
    client.on("terminated", ended);
    client.on("exited", (body) => {
      const b = body as { exitCode?: number };
      this.appendOutput(`[fim] exit code ${b?.exitCode ?? "?"}`);
      ended();
    });
    client.onceClosed(() => {
      if (this.client === client) {
        this.client = null;
        if (this.state.status !== "idle" && this.state.status !== "error") {
          this.setState({ status: "idle", frames: [], scopes: [], children: {}, stoppedAt: undefined });
        }
      }
    });
  }

  /** On stop: fetch frames, then the top frame's scopes/variables + watches. */
  private async refreshStopped(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      if (this.threadId == null) {
        const t = await client.request<{ threads?: { id: number }[] }>("threads");
        this.threadId = t.threads?.[0]?.id ?? null;
        if (this.threadId == null) return;
      }
      const st = await client.request<{
        stackFrames?: { id: number; name: string; line?: number; source?: { path?: string } }[];
      }>("stackTrace", { threadId: this.threadId, startFrame: 0, levels: 20 });
      const frames: StackFrameView[] = (st.stackFrames ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        path: f.source?.path,
        line: f.line,
      }));
      const top = frames[0];
      this.setState({
        status: "stopped",
        frames,
        selectedFrameId: top?.id,
        scopes: [],
        children: {},
        stoppedAt: top?.path && top.line ? { path: top.path, line: top.line } : undefined,
      });
      if (top) {
        await this.loadScopes(top.id);
        await this.refreshWatches();
      }
      // Reveal the stopped location in the editor via the app's open flow.
      if (top?.path && top.line) {
        window.dispatchEvent(
          new CustomEvent("fluent:debug-stopped", {
            detail: { path: top.path, line: top.line, uri: toFileUri(top.path) },
          })
        );
      }
    } catch (err) {
      this.appendOutput(`[stack] ${String(err)}`);
    }
  }

  // ── execution control ─────────────────────────────────────────────────────
  private async exec(command: string): Promise<void> {
    const client = this.client;
    if (!client || this.threadId == null) return;
    try {
      await client.request(command, { threadId: this.threadId });
    } catch (err) {
      this.appendOutput(`[${command}] ${String(err)}`);
    }
  }
  continue_ = (): Promise<void> => this.exec("continue");
  stepOver = (): Promise<void> => this.exec("next");
  stepIn = (): Promise<void> => this.exec("stepIn");
  stepOut = (): Promise<void> => this.exec("stepOut");
  pause = (): Promise<void> => this.exec("pause");

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.threadId = null;
    if (client) {
      try {
        await client.request("disconnect", { terminateDebuggee: true }, 3000);
      } catch {
        /* adapter may already be gone */
      }
      client.close();
    }
    await dapStopSession(SESSION_ID).catch(() => {});
    this.setState({
      status: "idle",
      frames: [],
      scopes: [],
      children: {},
      selectedFrameId: undefined,
      stoppedAt: undefined,
    });
  }

  private appendOutput(line: string): void {
    const output = [...this.state.output, line];
    if (output.length > MAX_OUTPUT_LINES) output.splice(0, output.length - MAX_OUTPUT_LINES);
    this.setState({ output });
  }
}

/** Trims a thrown error to a short, single-line message for the watch table. */
function shortErr(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "").split("\n")[0].slice(0, 120);
}

/** App-wide singleton (one debug session at a time). */
export const debugSession = new DebugSessionManager();
