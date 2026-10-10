// `window.createTerminal` → terminal integrado REAL do Fluent Coder (PTY em
// src-tauri/src/terminal.rs, aba no TerminalPanel). O host só descreve o
// terminal; o app cria o PTY e devolve o pid (`terminalOpened`) e o código de
// saída (`terminalClosed`).
//
// Shell integration REAL: o PTY de bash/zsh/fish sobe com os scripts OSC 633
// do app (src-tauri/shell-integration/); o frontend lê as sequências e manda
// `terminalShell` (ready/cwd/start/data/end) → `shellIntegration` com `cwd`
// atualizado, `onDidStartTerminalShellExecution`/`onDidEndTerminalShellExecution`
// com o código de saída e `execution.read()` com a saída do comando.
// Sem as sequências (outro shell, app sem suporte) em ~2,5 s, cai na
// integração SIMULADA: `executeCommand` digita a linha e só dispara o início
// (o Claude Code e o Codex esperam a integração por ~3 s antes do sendText).
'use strict';
const { EventEmitter, Uri } = require('./types');

let nextTerminal = 1;
/** Espera pelas sequências OSC 633 antes de cair na integração simulada. */
const REAL_INTEGRATION_WAIT_MS = 2500;
/** Teto da saída guardada por execução (`execution.read()`). */
const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Execução de comando (`TerminalShellExecution`): `read()` devolve um
 * AsyncIterable com toda a saída (o que já chegou + o que vier até o fim).
 */
function createExecution(commandLine, confidence, cwd) {
  const chunks = [];
  let size = 0;
  let done = false;
  const waiters = new Set();
  const wake = () => {
    for (const w of [...waiters]) w();
  };
  return {
    commandLine: { value: commandLine, isTrusted: confidence === 2, confidence },
    cwd,
    read() {
      let i = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              for (;;) {
                if (i < chunks.length) return { value: chunks[i++], done: false };
                if (done) return { value: undefined, done: true };
                await new Promise((r) => {
                  const w = () => {
                    waiters.delete(w);
                    r();
                  };
                  waiters.add(w);
                });
              }
            },
            return: async () => ({ value: undefined, done: true }),
          };
        },
      };
    },
    _push(data) {
      if (done || size >= MAX_OUTPUT) return;
      const text = String(data).slice(0, MAX_OUTPUT - size);
      size += text.length;
      chunks.push(text);
      wake();
    },
    _end() {
      done = true;
      wake();
    },
  };
}

function safeEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === null || v === undefined) continue;
    if (!k || /[=\0]/.test(k)) continue;
    out[k] = String(v);
  }
  return out;
}

/** Aplica os mutators de `environmentVariableCollection` (replace/append/prepend). */
function applyEnvCollections(base, collections) {
  const env = { ...base };
  for (const coll of collections) {
    if (!coll) continue;
    for (const [k, m] of coll) {
      if (!m) continue;
      const cur = env[k] ?? process.env[k] ?? '';
      if (m.type === 1) env[k] = m.value;
      else if (m.type === 2) env[k] = cur + m.value;
      else if (m.type === 3) env[k] = m.value + cur;
    }
  }
  return env;
}

class Terminal {
  /**
   * @param {object} host ExtensionHost (emit + events)
   * @param {object} options TerminalOptions
   * @param {Map[]} envCollections mutators da extensão que criou o terminal
   */
  constructor(host, options, envCollections = []) {
    this._host = host;
    this.id = `t${nextTerminal++}`;
    this.name = options.name || 'Terminal';
    this.creationOptions = Object.freeze({ ...options });
    this.exitStatus = undefined;
    this.state = { isInteractedWith: false, shell: undefined };
    this.shellIntegration = undefined;
    this._pid = undefined;
    this._opened = false;
    this._disposed = false;
    this._resolvePid = null;
    this.processId = new Promise((r) => {
      this._resolvePid = r;
    });
    const cwd = options.cwd ? (typeof options.cwd === 'string' ? options.cwd : options.cwd.fsPath) : host.workspaceFolders[0] ? host.workspaceFolders[0].uri.fsPath : undefined;
    this._cwd = cwd;
    // Pseudoterminal da extensão (`createTerminal({ pty })` / CustomExecution):
    // sem processo; a aba do app é dirigida pelo pty (onDidWrite/onDidClose).
    if (options.pty && typeof options.pty.open === 'function') {
      this._setupPseudo(options.pty, !!options._task);
      host.emit({
        event: 'terminalCreate',
        id: this.id,
        name: this.name,
        cwd,
        pseudo: true,
        hideFromUser: !!options.hideFromUser,
        isTransient: !!options.isTransient,
        extensionId: options._extensionId,
        shellIntegration: false,
      });
      return;
    }
    const env = options.strictEnv ? safeEnv(options.env) : safeEnv(applyEnvCollections(options.env || {}, envCollections));
    host.emit({
      event: 'terminalCreate',
      id: this.id,
      name: this.name,
      cwd,
      env,
      strictEnv: !!options.strictEnv,
      shellPath: typeof options.shellPath === 'string' ? options.shellPath : undefined,
      shellArgs: Array.isArray(options.shellArgs) ? options.shellArgs.map(String) : typeof options.shellArgs === 'string' ? [options.shellArgs] : undefined,
      hideFromUser: !!options.hideFromUser,
      isTransient: !!options.isTransient,
      extensionId: options._extensionId,
      // Tarefas e shells com argumentos próprios não ganham a integração.
      shellIntegration: !options._task && !(Array.isArray(options.shellArgs) ? options.shellArgs.length : options.shellArgs),
    });
  }
  _setupPseudo(pty, isTask) {
    this._pty = pty;
    this._ptyTask = isTask;
    this._ptyClosed = false;
    this._ptySubs = [];
    const on = (ev, fn) => {
      if (typeof ev === 'function') this._ptySubs.push(ev(fn));
    };
    on(pty.onDidWrite, (data) => {
      if (!this._ptyClosed) this._host.emit({ event: 'terminalPtyWrite', id: this.id, data: String(data) });
    });
    on(pty.onDidClose, (code) => this._pseudoExit(typeof code === 'number' ? code : undefined));
    on(pty.onDidChangeName, (name) => {
      if (typeof name !== 'string' || !name) return;
      this.name = name;
      this._host.emit({ event: 'terminalRename', id: this.id, name });
    });
  }

  /** O pty da extensão encerrou (onDidClose): fecha a aba (tarefa: mantém com a saída). */
  _pseudoExit(code) {
    if (this._ptyClosed) return;
    this._ptyClosed = true;
    this._host.emit({ event: 'terminalPtyExit', id: this.id, exitCode: code, close: !this._ptyTask });
    this._host.terminalClosed(this.id, code, 1);
  }

  /** App: entrada do teclado (pty) — `handleInput`. */
  _pseudoInput(data) {
    if (!this._pty || this._ptyClosed || typeof this._pty.handleInput !== 'function') return;
    this.state = { ...this.state, isInteractedWith: true };
    try {
      this._pty.handleInput(String(data));
    } catch (err) {
      this._host.log('pty.handleInput falhou:', err);
    }
  }

  /** App: a aba mudou de tamanho — `setDimensions`. */
  _pseudoResize(cols, rows) {
    if (!this._pty || this._ptyClosed || typeof this._pty.setDimensions !== 'function') return;
    try {
      this._pty.setDimensions({ columns: cols, rows });
    } catch (err) {
      this._host.log('pty.setDimensions falhou:', err);
    }
  }

  sendText(text, shouldExecute = true) {
    if (this._disposed) return;
    if (this._pty) {
      this._pseudoInput(String(text) + (shouldExecute ? '\r' : ''));
      return;
    }
    this.state = { ...this.state, isInteractedWith: true };
    // VS Code normaliza quebras para \r ao enviar ao PTY.
    const data = String(text).replace(/\r?\n/g, '\r') + (shouldExecute ? '\r' : '');
    this._host.emit({ event: 'terminalSendText', id: this.id, text: data });
  }
  show(preserveFocus) {
    if (this._disposed) return;
    this._host._setActiveTerminal(this);
    this._host.emit({ event: 'terminalShow', id: this.id, preserveFocus: !!preserveFocus });
  }
  hide() {}
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._host.emit({ event: 'terminalDispose', id: this.id });
    // O fechamento chega por `terminalClosed` quando o app mata o PTY; sem app
    // conectado, fecha já.
    if (!this._host.appConnected) this._host.terminalClosed(this.id, undefined, 4);
  }
  /**
   * App criou o PTY. `integrationRequested` = o PTY subiu com os scripts OSC
   * 633 (bash/zsh/fish): espera as sequências; sem elas, integração simulada.
   */
  _onOpened(pid, integrationRequested, dims) {
    if (this._opened) return;
    this._opened = true;
    if (this._pty) {
      this._resolvePid(undefined);
      try {
        const r = this._pty.open(dims && dims.cols > 0 && dims.rows > 0 ? { columns: dims.cols, rows: dims.rows } : undefined);
        if (r && typeof r.catch === 'function') r.catch((err) => this._host.log('pty.open falhou:', err));
      } catch (err) {
        this._host.log('pty.open falhou:', err);
      }
      return;
    }
    this._pid = pid;
    this._resolvePid(pid);
    if (integrationRequested && this._host.appConnected) {
      this._fallbackTimer = setTimeout(() => {
        if (!this._real && !this._disposed) this._installSimulated();
      }, REAL_INTEGRATION_WAIT_MS);
      if (this._fallbackTimer.unref) this._fallbackTimer.unref();
      return;
    }
    this._installSimulated();
  }

  _installSimulated() {
    const term = this;
    const cwdUri = this._cwd ? Uri.file(this._cwd) : undefined;
    this.shellIntegration = {
      cwd: cwdUri,
      executeCommand(commandLine, args) {
        const line = commandLineOf(commandLine, args);
        term.sendText(line, true);
        const execution = createExecution(line, 2, cwdUri);
        // Assíncrono, como no VS Code (o listener costuma ser registrado logo após).
        setTimeout(() => term._host.events.startShellExecution.fire({ terminal: term, shellIntegration: term.shellIntegration, execution }), 0);
        return execution;
      },
    };
    this._host.events.terminalShellIntegration.fire({ terminal: this, shellIntegration: this.shellIntegration });
  }

  _installReal() {
    if (this._real) return;
    this._real = true;
    clearTimeout(this._fallbackTimer);
    const term = this;
    this._pendingExecs = [];
    this._currentExec = null;
    this.shellIntegration = {
      cwd: this._cwd ? Uri.file(this._cwd) : undefined,
      executeCommand(commandLine, args) {
        const line = commandLineOf(commandLine, args);
        // A execução "nasce" agora; o início/fim reais vêm das sequências do shell.
        const execution = createExecution(line, 2, term.shellIntegration.cwd);
        term._pendingExecs.push(execution);
        term.sendText(line, true);
        return execution;
      },
    };
    this._host.events.terminalShellIntegration.fire({ terminal: this, shellIntegration: this.shellIntegration });
  }

  /** Evento OSC 633 já interpretado pelo app (`terminalShell`). */
  _shellEvent(p) {
    if (this._disposed) return;
    if (!this._real) this._installReal();
    const si = this.shellIntegration;
    switch (p.type) {
      case 'ready':
        break;
      case 'cwd': {
        if (typeof p.cwd !== 'string' || !p.cwd) break;
        const prev = si.cwd ? si.cwd.fsPath : undefined;
        this._cwd = p.cwd;
        si.cwd = Uri.file(p.cwd);
        if (prev !== p.cwd) this._host.events.terminalShellIntegration.fire({ terminal: this, shellIntegration: si });
        break;
      }
      case 'start': {
        if (this._currentExec) this._finishExec(undefined);
        // Execução pedida por executeCommand (FIFO) ou digitada pelo usuário.
        const typed = typeof p.commandLine === 'string' ? p.commandLine : '';
        let exec = this._pendingExecs.shift();
        if (!exec) exec = createExecution(typed, typed ? 2 : 0, si.cwd);
        else exec.cwd = si.cwd;
        this._currentExec = exec;
        this.state = { ...this.state, isInteractedWith: true };
        this._host.events.startShellExecution.fire({ terminal: this, shellIntegration: si, execution: exec });
        break;
      }
      case 'data':
        if (this._currentExec && typeof p.data === 'string') this._currentExec._push(p.data);
        break;
      case 'end':
        this._finishExec(typeof p.exitCode === 'number' ? p.exitCode : undefined);
        break;
      default:
        break;
    }
  }

  _finishExec(exitCode) {
    const exec = this._currentExec;
    if (!exec) return;
    this._currentExec = null;
    exec._end();
    this._host.events.endShellExecution.fire({ terminal: this, shellIntegration: this.shellIntegration, execution: exec, exitCode });
  }

  /** PTY encerrou: execução em andamento termina sem código. */
  _onClosed() {
    clearTimeout(this._fallbackTimer);
    if (this._pty) {
      // Aba fechada pelo usuário/dispose: o pty recebe close() uma vez.
      const wasOpen = !this._ptyClosed;
      this._ptyClosed = true;
      if (wasOpen && typeof this._pty.close === 'function') {
        try {
          this._pty.close();
        } catch (err) {
          this._host.log('pty.close falhou:', err);
        }
      }
      for (const d of this._ptySubs) d && d.dispose && d.dispose();
      this._ptySubs = [];
    }
    if (this._currentExec) this._finishExec(undefined);
  }
}

function commandLineOf(commandLine, args) {
  return args && args.length ? [commandLine, ...args.map(quoteArg)].join(' ') : String(commandLine);
}

function quoteArg(a) {
  const s = String(a);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

module.exports = { Terminal, applyEnvCollections, safeEnv, quoteArg, createExecution, REAL_INTEGRATION_WAIT_MS };
