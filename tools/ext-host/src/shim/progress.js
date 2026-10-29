// `window.withProgress` com cancelamento real.
//
// Cada progresso vira o evento `progress` (upsert, coalescido em 50 ms) com
// onde mostrar (`notification` = aviso com barra e botão Cancelar; `window`/
// `scm` = item com spinner na barra de status), título, mensagem, percentual
// acumulado (`increment`) e se é cancelável. O app pede `cancelProgress` →
// o CancellationToken da tarefa dispara. `progressEnd` quando a tarefa termina
// (resolvida ou rejeitada).
'use strict';
const { CancellationTokenSource } = require('./types');

let nextProgress = 1;
const FLUSH_MS = 50;

function locationName(loc) {
  if (loc === 15) return 'notification';
  if (loc === 1) return 'scm';
  // Window (10) e `{ viewId }` (progresso de uma view): barra de status.
  return 'window';
}

class ProgressService {
  constructor(host) {
    this.host = host;
    this.active = new Map(); // id → { cts, cancellable }
  }

  withProgress(ext, options, task) {
    options = options || {};
    const id = `p${nextProgress++}`;
    const cts = new CancellationTokenSource();
    const cancellable = !!options.cancellable;
    const state = {
      event: 'progress',
      id,
      extensionId: ext.id,
      extensionName: (ext.packageJSON && (ext.packageJSON.displayName || ext.packageJSON.name)) || ext.id,
      location: locationName(options.location),
      title: options.title ? String(options.title).slice(0, 500) : '',
      message: '',
      percent: undefined,
      cancellable,
    };
    let timer = null;
    let ended = false;
    const flush = () => {
      timer = null;
      if (!ended) this.host.emit({ ...state });
    };
    const schedule = () => {
      if (ended || timer) return;
      timer = setTimeout(flush, FLUSH_MS);
      if (timer.unref) timer.unref();
    };
    this.active.set(id, { cts, cancellable });
    // Primeiro estado já sai (o app mostra o spinner na hora).
    this.host.emit({ ...state });
    const progress = {
      report: (v) => {
        if (ended || !v) return;
        if (v.message !== undefined) state.message = String(v.message).slice(0, 1000);
        if (typeof v.increment === 'number' && Number.isFinite(v.increment)) state.percent = Math.max(0, Math.min(100, (state.percent || 0) + v.increment));
        schedule();
      },
    };
    const done = () => {
      ended = true;
      if (timer) clearTimeout(timer);
      this.active.delete(id);
      this.host.emit({ event: 'progressEnd', id });
      cts.dispose && cts.dispose();
    };
    return Promise.resolve()
      .then(() => task(progress, cts.token))
      .finally(done);
  }

  /** Botão Cancelar do app: só progressos `cancellable`. */
  cancel(id) {
    const p = this.active.get(id);
    if (!p || !p.cancellable) return false;
    p.cts.cancel();
    return true;
  }
}

module.exports = { ProgressService, locationName };
