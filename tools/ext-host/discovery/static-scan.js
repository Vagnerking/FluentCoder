// Varredura estática: encontra os identificadores ligados a require("vscode")
// num bundle (esbuild/webpack) e conta os caminhos `vscode.a.b` usados.
// Uso: node static-scan.js <extension.js>
'use strict';
const fs = require('fs');

function scanSource(src) {
  const names = new Set();
  const re = /([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\()?require\("vscode"\)/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  const paths = new Map();
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pr = new RegExp(`(?<![\\w$.])${esc}\\.([A-Za-z_$][\\w$]*)(?:\\.([A-Za-z_$][\\w$]*))?`, 'g');
    let p;
    while ((p = pr.exec(src))) {
      // namespaces (minúsculos) guardam o membro; classes/enums só o nome
      const key = p[2] && /^[a-z]/.test(p[1]) ? `${p[1]}.${p[2]}` : p[1];
      paths.set(key, (paths.get(key) || 0) + 1);
    }
  }
  return { names: [...names], paths };
}

if (require.main === module) {
  const { names, paths } = scanSource(fs.readFileSync(process.argv[2], 'utf8'));
  const sorted = [...paths.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ bindings: names.length, paths: sorted }));
  } else {
    console.log(`# bindings: ${names.length}`);
    for (const [k, v] of sorted) console.log(`${k}\t${v}`);
  }
}
module.exports = { scanSource };
