// Proxy de gravação para a descoberta da superfície da API: envolve o objeto
// `vscode` entregue à extensão e anota todo caminho acessado/chamado
// (ex.: `window.registerWebviewViewProvider()`), marcando os que NÃO existem
// no shim como "missing". Os ausentes devolvem um stub chamável que segue
// gravando, para a ativação avançar o máximo possível.
'use strict';

function createRecorder() {
  const hits = new Map(); // path → { gets, calls, missing }
  const note = (p, kind, missing) => {
    const h = hits.get(p) || { gets: 0, calls: 0, missing: false };
    h[kind]++;
    if (missing) h.missing = true;
    hits.set(p, h);
  };

  function missingStub(p) {
    const fn = function () {};
    return new Proxy(fn, {
      get(_t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        const sub = `${p}.${String(prop)}`;
        note(sub, 'gets', true);
        return missingStub(sub);
      },
      apply() {
        note(p, 'calls', true);
        return missingStub(`${p}()`);
      },
      construct() {
        note(p, 'calls', true);
        return missingStub(`new ${p}()`);
      },
    });
  }

  const NAMESPACES = new Set(['commands', 'window', 'workspace', 'env', 'extensions', 'languages', 'comments', 'authentication', 'l10n', 'tasks', 'debug', 'notebooks', 'scm', 'lm', 'chat', 'tests', 'fs', 'clipboard', 'tabGroups']);

  function wrap(obj, p, depth) {
    return new Proxy(obj, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON' || prop === '__esModule' || prop === 'default' && p === 'vscode') return Reflect.get(target, prop, receiver);
        const sub = p === 'vscode' ? String(prop) : `${p}.${String(prop)}`;
        const exists = prop in target;
        if (!exists) {
          note(sub, 'gets', true);
          // Namespaces propostos (lm/chat) ficam ausentes de verdade.
          if (p === 'vscode' && (prop === 'lm' || prop === 'chat' || prop === 'tests')) return undefined;
          return missingStub(sub);
        }
        note(sub, 'gets', false);
        const v = Reflect.get(target, prop, receiver);
        if (typeof v === 'function' && !/^[A-Z]/.test(String(prop))) {
          return function (...args) {
            note(sub, 'calls', false);
            return v.apply(this === undefined || this === receiver ? target : this, args);
          };
        }
        if (v && typeof v === 'object' && depth < 2 && NAMESPACES.has(String(prop))) return wrap(v, sub, depth + 1);
        return v;
      },
    });
  }

  return {
    hits,
    wrapApi(api) {
      return wrap(api, 'vscode', 0);
    },
    report() {
      return [...hits.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([path, h]) => ({ path, ...h }));
    },
  };
}

module.exports = { createRecorder };
