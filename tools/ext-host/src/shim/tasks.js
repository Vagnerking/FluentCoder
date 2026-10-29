// `vscode.tasks` mínimo: providers (`registerTaskProvider`/`fetchTasks`) e
// `executeTask` rodando no terminal integrado do app (um terminal de extensão
// com o processo da tarefa), com `onDidStart/EndTask` e
// `onDidStart/EndTaskProcess` (pid e código de saída reais do PTY).
//
// Sem app conectado (headless/testes) a tarefa roda com child_process.
// CustomExecution: o callback da extensão devolve um Pseudoterminal, que dirige
// uma aba do terminal do app (onDidWrite/handleInput/setDimensions/onDidClose).
'use strict';
const { spawn } = require('child_process');
const { EventEmitter, Disposable, CancellationTokenSource, ShellExecution, ProcessExecution, CustomExecution } = require('./types');

function defaultShell() {
  if (process.platform === 'win32') return { shellPath: 'powershell.exe', shellArgs: (line) => ['-NoProfile', '-Command', line] };
  return { shellPath: '/bin/sh', shellArgs: (line) => ['-c', line] };
}

function quote(arg) {
  const v = typeof arg === 'string' ? arg : arg && typeof arg.value === 'string' ? arg.value : String(arg);
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Como o processo da tarefa é iniciado: { shellPath, shellArgs, cwd, env, label }. */
function resolveExecution(task, workspaceCwd) {
  const ex = task && task.execution;
  if (!ex) throw new Error('A tarefa não tem execution.');
  if (ex instanceof CustomExecution || typeof ex.callback === 'function') return { custom: true, label: task.name || 'tarefa' };
  const opts = ex.options || {};
  const cwd = opts.cwd || workspaceCwd;
  const env = opts.env || undefined;
  if (ex instanceof ProcessExecution || typeof ex.process === 'string') {
    return { shellPath: ex.process, shellArgs: (ex.args || []).map(String), cwd, env, label: [ex.process, ...(ex.args || [])].join(' ') };
  }
  if (ex instanceof ShellExecution || ex.commandLine !== undefined || ex.command !== undefined) {
    const line = ex.commandLine !== undefined ? String(ex.commandLine) : [quote(ex.command), ...(ex.args || []).map(quote)].join(' ');
    const sh = opts.executable ? { shellPath: opts.executable, shellArgs: (l) => [...(opts.shellArgs || ['-c']), l] } : defaultShell();
    return { shellPath: sh.shellPath, shellArgs: sh.shellArgs(line), cwd, env, label: line };
  }
  throw new Error('Tipo de execution de tarefa desconhecido.');
}

class TaskService {
  constructor(host) {
    this.host = host;
    this.providers = new Map(); // type → [{provider, ext}]
    this.executions = [];
    this.onDidStartTask = new EventEmitter();
    this.onDidEndTask = new EventEmitter();
    this.onDidStartTaskProcess = new EventEmitter();
    this.onDidEndTaskProcess = new EventEmitter();
  }

  registerTaskProvider(ext, type, provider) {
    const list = this.providers.get(type) || [];
    const reg = { provider, ext };
    list.push(reg);
    this.providers.set(type, list);
    return new Disposable(() => {
      const cur = this.providers.get(type) || [];
      this.providers.set(
        type,
        cur.filter((r) => r !== reg),
      );
    });
  }

  async fetchTasks(filter) {
    const out = [];
    for (const [type, regs] of this.providers) {
      if (filter && filter.type && filter.type !== type) continue;
      for (const { provider, ext } of regs) {
        try {
          const tasks = (await provider.provideTasks(new CancellationTokenSource().token)) || [];
          out.push(...tasks);
        } catch (err) {
          this.host.log(`provideTasks (${ext.id}) falhou:`, err);
        }
      }
    }
    return out;
  }

  async executeTask(ext, task) {
    const spec = resolveExecution(task, this.host.workspaceFolders[0] ? this.host.workspaceFolders[0].uri.fsPath : process.cwd());
    const service = this;
    let ended = false;
    let terminal = null;
    let child = null;
    const execution = {
      task,
      terminate() {
        if (ended) return;
        if (terminal) terminal.dispose();
        if (child) child.kill();
      },
    };
    this.executions.push(execution);
    const finish = (exitCode) => {
      if (ended) return;
      ended = true;
      service.executions = service.executions.filter((e) => e !== execution);
      service.onDidEndTaskProcess.fire({ execution, exitCode });
      service.onDidEndTask.fire({ execution });
    };
    this.onDidStartTask.fire({ execution });
    if (spec.custom) {
      // Pseudoterminal da extensão: termina quando o pty dispara onDidClose
      // (ou a aba é fechada). Sem processo (sem onDidStartTaskProcess).
      let pty;
      try {
        pty = await task.execution.callback(task.definition || {});
      } catch (err) {
        finish(undefined);
        throw err;
      }
      if (!pty || typeof pty.open !== 'function' || typeof pty.onDidWrite !== 'function') {
        finish(undefined);
        throw new Error('CustomExecution não devolveu um Pseudoterminal.');
      }
      terminal = this.host.createTerminal(ext, { name: `Tarefa: ${task.name || spec.label}`, pty, _task: true });
      const sub = this.host.events.closeTerminal.event((t) => {
        if (t !== terminal) return;
        sub.dispose();
        finish(t.exitStatus ? t.exitStatus.code : undefined);
      });
      if (!task.presentationOptions || task.presentationOptions.reveal !== 3) terminal.show(true);
      return execution;
    }
    if (this.host.appConnected) {
      // Terminal integrado do app com o processo da tarefa (aba "Tarefa: …").
      terminal = this.host.createTerminal(ext, {
        name: `Tarefa: ${task.name || spec.label}`,
        shellPath: spec.shellPath,
        shellArgs: spec.shellArgs,
        cwd: spec.cwd,
        env: spec.env,
        _task: true,
      });
      terminal.processId.then((pid) => {
        if (pid !== undefined && !ended) this.onDidStartTaskProcess.fire({ execution, processId: pid });
      });
      const sub = this.host.events.closeTerminal.event((t) => {
        if (t !== terminal) return;
        sub.dispose();
        finish(t.exitStatus ? t.exitStatus.code : undefined);
      });
      if (task.presentationOptions && task.presentationOptions.reveal !== 3) terminal.show(true);
    } else {
      child = spawn(spec.shellPath, spec.shellArgs, { cwd: spec.cwd, env: { ...process.env, ...(spec.env || {}) }, stdio: 'ignore' });
      child.on('spawn', () => this.onDidStartTaskProcess.fire({ execution, processId: child.pid }));
      child.on('error', () => finish(undefined));
      child.on('exit', (code) => finish(code === null ? undefined : code));
    }
    return execution;
  }
}

module.exports = { TaskService, resolveExecution };
