// Gera `src/extensions/vscode-api-surface.json`: o UNIVERSO da API `vscode`
// (o que existe em runtime: classes, enums, namespaces e os membros de cada
// namespace) a partir do `vscode.d.ts` (+ `vscode.proposed.*.d.ts`) que vem
// com o @codingame/monaco-vscode-api instalado.
//
//   node tools/ext-host/discovery/api-surface.js          → grava o JSON
//   node tools/ext-host/discovery/api-surface.js --check  → falha se divergir
//
// Para que serve: a varredura estática do bundle (`api-scan.js` e o espelho
// Rust em `store.rs`) só conta como "API usada" o que está neste universo.
// Identificadores minificados que reaproveitam o nome da variável do
// `require("vscode")` (`_`, `__esModule`, `glsl`, `deflate`…) e ids de comando
// dentro de strings (`"vscode.diff"`) deixam de virar "APIs ausentes".
//
// Por que é seguro descartar o que está fora do universo: o `.d.ts` é de uma
// versão do VS Code >= `VSCODE_VERSION` do shim (o teste confere). Uma
// extensão que passa no `engines.vscode` só pode depender de APIs até essa
// versão — todas estão aqui (estáveis ou propostas).
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', '..', 'src', 'extensions', 'vscode-api-surface.json');

function dtsDir() {
  // `exports` do pacote não expõe o package.json: caminho direto em node_modules.
  return path.join(__dirname, '..', '..', '..', 'node_modules', '@codingame', 'monaco-vscode-api', 'vscode-dts');
}

/** Versão do VS Code do pacote de tipos (product.json embutido no @codingame). */
function dtsVersion(dir) {
  const product = path.join(dir, '..', 'vscode', 'src', 'vs', 'platform', 'product', 'common', 'product.js');
  try {
    const m = /version:\s*["'](1\.\d+\.\d+)["']/.exec(fs.readFileSync(product, 'utf8'));
    if (m) return m[1];
  } catch {
    /* sem product.js */
  }
  throw new Error('não achei a versão do VS Code do @codingame/monaco-vscode-api');
}

/**
 * Declarações por indentação (o vscode.d.ts usa tabs de forma consistente):
 * `\texport class X` = topo; `\t\texport function y` dentro de `\texport namespace ns {`.
 */
function parse(text, into) {
  let ns = null;
  for (const line of text.split('\n')) {
    const top = /^\t(?:export )?(?:declare )?(class|enum|namespace|const|let|function) ([A-Za-z_$][\w$]*)/.exec(line);
    if (top) {
      into.top.add(top[2]);
      ns = top[1] === 'namespace' ? top[2] : null;
      if (ns && !into.namespaces[ns]) into.namespaces[ns] = new Set();
      continue;
    }
    if (/^\t\}/.test(line)) {
      ns = null;
      continue;
    }
    const member = ns && /^\t\t(?:export )?(?:declare )?(?:function|const|let|class|enum|namespace) ([A-Za-z_$][\w$]*)/.exec(line);
    if (member) into.namespaces[ns].add(member[1]);
  }
  return into;
}

function build() {
  const dir = dtsDir();
  const stable = parse(fs.readFileSync(path.join(dir, 'vscode.d.ts'), 'utf8'), { top: new Set(), namespaces: {} });
  const proposed = { top: new Set(), namespaces: {} };
  for (const f of fs.readdirSync(dir).filter((x) => /^vscode\.proposed\..+\.d\.ts$/.test(x)).sort()) parse(fs.readFileSync(path.join(dir, f), 'utf8'), proposed);
  const sorted = (s) => [...s].sort();
  const out = {
    source: '@codingame/monaco-vscode-api/vscode-dts',
    vscodeVersion: dtsVersion(dir),
    top: sorted(stable.top),
    namespaces: Object.fromEntries(Object.keys(stable.namespaces).sort().map((k) => [k, sorted(stable.namespaces[k])])),
    proposed: {
      top: sorted([...proposed.top].filter((t) => !stable.top.has(t))),
      namespaces: Object.fromEntries(
        Object.keys(proposed.namespaces)
          .sort()
          .map((k) => [k, sorted([...proposed.namespaces[k]].filter((m) => !(stable.namespaces[k] && stable.namespaces[k].has(m))))])
          .filter(([, v]) => v.length),
      ),
    },
  };
  return out;
}

if (require.main === module) {
  const json = JSON.stringify(build(), null, 1) + '\n';
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== json) {
      process.stderr.write('vscode-api-surface.json desatualizado: rode node tools/ext-host/discovery/api-surface.js\n');
      process.exit(1);
    }
    process.stdout.write('vscode-api-surface.json em dia\n');
  } else {
    fs.writeFileSync(OUT, json);
    const b = JSON.parse(json);
    process.stdout.write(`gravado ${path.relative(process.cwd(), OUT)}: VS Code ${b.vscodeVersion}, ${b.top.length} no topo, ${Object.keys(b.namespaces).length} namespaces\n`);
  }
}

module.exports = { build, parse, OUT };
