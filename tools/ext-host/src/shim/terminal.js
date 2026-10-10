// `window.createTerminal` → terminal integrado REAL do Fluent Coder (PTY em
// src-tauri/src/terminal.rs, aba no TerminalPanel). O host só descreve o
// terminal; o app cria o PTY e devolve o pid (`terminalOpened`) e o código de
// saída (`terminalClosed`).
//
// Shell integration (best effort): assim que o PTY existe, o terminal ganha um
// `shellIntegration` cujo `executeCommand` digita a linha no PTY e dispara
// `onDidStartTerminalShellExecution`. Não sabemos quando o comando termina,
// então `onDidEndTerminalShellExecution` nunca dispara (as extensões tratam
// isso como "ainda rodando"). O Claude Code e o Codex esperam a integração
// por ~3 s antes de cair no `sendText`; com ela, o comando sai na hora.
'use strict';
const { EventEmitter, Uri } = require('./types');

let nextTerminal = 1;

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
    });
  }
  sendText(text, shouldExecute = true) {
    if (this._disposed) return;
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
  /** App criou o PTY. */
  _onOpened(pid) {
    if (this._opened) return;
    this._opened = true;
    this._pid = pid;
    this._resolvePid(pid);
    const term = this;
    const cwdUri = this._cwd ? Uri.file(this._cwd) : undefined;
    this.shellIntegration = {
      cwd: cwdUri,
      executeCommand(commandLine, args) {
        const line = args && args.length ? [commandLine, ...args.map(quoteArg)].join(' ') : String(commandLine);
        term.sendText(line, true);
        const execution = {
          commandLine: { value: line, isTrusted: true, confidence: 2 },
          cwd: cwdUri,
          read() {
            return (async function* () {})();
          },
        };
        // Assíncrono, como no VS Code (o listener costuma ser registrado logo após).
        setTimeout(() => term._host.events.startShellExecution.fire({ terminal: term, shellIntegration: term.shellIntegration, execution }), 0);
        return execution;
      },
    };
    this._host.events.terminalShellIntegration.fire({ terminal: this, shellIntegration: this.shellIntegration });
  }
}

function quoteArg(a) {
  const s = String(a);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

module.exports = { Terminal, applyEnvCollections, safeEnv, quoteArg };
