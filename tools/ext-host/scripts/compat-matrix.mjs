// Matriz de compatibilidade regenerável: roda a varredura (api-scan.js) e o
// classificador REAL (src/extensions/compatibility.ts + capabilities.json)
// sobre uma pasta de extensões e imprime o veredito de cada uma. Nada é
// executado: só leitura estática dos arquivos.
//
//   node --experimental-strip-types tools/ext-host/scripts/compat-matrix.mjs <pasta> [--json saída.json] [--compare antes.json]
//
// <pasta> aceita dois formatos:
//   - o da auditoria/pré-avaliação: <pasta>/<id>/meta.json + <pasta>/<id>/ext/package.json
//   - uma pasta de extensões instaladas (~/.vscode/extensions): <pasta>/<dir>/package.json
// `--compare` recebe um JSON com [{id, verdict}] (ex.: a matriz anterior) e
// mostra "antes → depois".
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const { scanExtension } = require(path.join(ROOT, 'tools/ext-host/discovery/api-scan.js'));
const { classify, VERDICT_LABEL } = await import(path.join(ROOT, 'src/extensions/compatibility.ts'));
const caps = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/extensions/capabilities.json'), 'utf8'));

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--json' && args[args.indexOf(a) - 1] !== '--compare');
if (!dir) {
  process.stderr.write('uso: compat-matrix.mjs <pasta> [--json saída.json] [--compare antes.json]\n');
  process.exit(2);
}
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const hostPlatform = process.env.FLUENT_HOST_PLATFORM || `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;

function entries(root) {
  const out = [];
  for (const name of fs.readdirSync(root).sort()) {
    const d = path.join(root, name);
    if (!fs.statSync(d).isDirectory()) continue;
    if (fs.existsSync(path.join(d, 'ext', 'package.json'))) {
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8'));
      } catch {
        /* sem meta */
      }
      out.push({ ext: path.join(d, 'ext'), targetPlatform: meta.targetPlatform || 'universal' });
    } else if (fs.existsSync(path.join(d, 'package.json'))) {
      const m = /-(win32|linux|darwin|alpine)-(x64|arm64|armhf|ia32)$/.exec(name);
      out.push({ ext: d, targetPlatform: m ? `${m[1]}-${m[2]}` : 'universal' });
    }
  }
  return out;
}

const list = entries(dir).map((e) => ({ ...e, pkg: JSON.parse(fs.readFileSync(path.join(e.ext, 'package.json'), 'utf8')) }));
const installedIds = new Set(list.map((e) => `${e.pkg.publisher}.${e.pkg.name}`.toLowerCase()));
const before = opt('--compare') ? new Map(JSON.parse(fs.readFileSync(opt('--compare'), 'utf8')).map((r) => [r.id, r.verdict])) : null;
const rows = [];
for (const e of list) {
  const id = `${e.pkg.publisher}.${e.pkg.name}`.toLowerCase();
  let scan = null;
  if (typeof e.pkg.main === 'string') {
    try {
      scan = scanExtension(e.ext, e.pkg);
    } catch (err) {
      scan = { error: String(err), bindings: 0, paths: [] };
    }
  }
  const r = classify({ manifest: e.pkg, targetPlatform: e.targetPlatform, hostPlatform, apiScan: scan, installedIds }, caps);
  const top = r.reasons.find((x) => x.severity === 'blocker') || r.reasons.find((x) => x.severity === 'limit') || r.reasons.find((x) => x.code.startsWith('code-'));
  rows.push({
    id,
    version: e.pkg.version,
    verdict: r.verdict,
    before: before ? before.get(id) ?? null : undefined,
    bindings: scan ? scan.bindings : null,
    paths: scan && scan.paths ? scan.paths.length : null,
    unresolved: scan ? scan.unresolved ?? null : null,
    ignored: scan ? scan.ignored ?? null : null,
    reason: top ? `${top.code}: ${top.message}` : '',
    reasons: r.reasons.map((x) => `${x.severity}:${x.code}`),
  });
}
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(rows, null, 1));
const label = (v) => (v ? VERDICT_LABEL[v] ?? v : '—');
for (const r of rows) {
  const change = before ? `${label(r.before).padEnd(12)} → ${label(r.verdict).padEnd(12)}` : label(r.verdict).padEnd(12);
  const scan = r.bindings === null ? 'sem código'.padEnd(26) : `b=${r.bindings} api=${r.paths} unres=${r.unresolved}`.padEnd(26);
  process.stdout.write(`${r.id.padEnd(44)} ${change} ${scan} ${r.reason.slice(0, 110)}\n`);
}
const count = (k) => rows.filter((r) => r.verdict === k).length;
process.stdout.write(`\n${rows.length} extensões: ${count('compatible')} Compatível · ${count('partial')} Parcial · ${count('incompatible')} Incompatível · ${count('unknown')} Não avaliada\n`);
