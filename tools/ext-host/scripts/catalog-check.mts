// Verificação headless do catálogo + classificador (rede real, SOMENTE LEITURA).
//
//   npm run ext-host:catalog-check
//   node --experimental-strip-types tools/ext-host/scripts/catalog-check.mts [--managed <pasta>]
//
// 1. Busca no Open VSX e metadados (plataforma deste computador) de extensões
//    populares + Claude Code/Codex; classifica pelo manifesto (sem código →
//    no máximo "Não avaliada").
// 2. Classifica as embutidas instaladas no VS Code (~/.vscode/extensions, só
//    leitura) COM a varredura do código (api-scan.js).
// 3. `--managed <pasta>`: classifica as extensões de uma pasta gerenciada
//    (ex.: a cópia temporária do teste de instalação real).
// Não instala nada, não escreve fora do stdout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { classify, VERDICT_LABEL, type Capabilities } from "../../../src/extensions/compatibility.ts";

const require = createRequire(import.meta.url);
const { scanExtension } = require("../discovery/api-scan.js");
const { listInstalled, platformTag } = require("../src/installed.js");
const caps: Capabilities = JSON.parse(fs.readFileSync(new URL("../../../src/extensions/capabilities.json", import.meta.url), "utf8"));
const API = "https://open-vsx.org/api";
const platform = platformTag();

async function getJson(url: string): Promise<any> {
  if (!url.startsWith("https://")) throw new Error(`não-HTTPS recusado: ${url}`);
  const r = await fetch(url, { headers: { "user-agent": "FluentCoder catalog-check" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r.json();
}

async function metadata(ns: string, name: string): Promise<any> {
  return (await getJson(`${API}/${ns}/${name}/${platform}/latest`)) ?? (await getJson(`${API}/${ns}/${name}/universal/latest`)) ?? (await getJson(`${API}/${ns}/${name}/latest`));
}

function printReport(title: string, report: ReturnType<typeof classify>): void {
  console.log(`  → ${VERDICT_LABEL[report.verdict]} (${report.verdict}) · código analisado: ${report.analyzed.code ? "sim" : "não"} — ${title}`);
  for (const r of report.reasons.slice(0, 6)) console.log(`     [${r.severity}] ${r.message}`);
}

async function main(): Promise<void> {
  console.log(`Plataforma: ${platform} · API do shim: ${caps.hostVersion}\n`);
  console.log("== Open VSX: busca (\"todo highlight\") ==");
  const search = await getJson(`${API}/-/search?query=todo%20highlight&size=3&targetPlatform=${platform}`);
  for (const e of search.extensions) console.log(`  ${e.namespace}.${e.name} ${e.version} · ${e.downloadCount} downloads · verificado: ${e.verified}`);
  console.log(`  (total ${search.totalSize})\n`);

  console.log("== Open VSX: metadados + classificação pelo manifesto ==");
  const ids = ["esbenp.prettier-vscode", "usernamehw.errorlens", "wayou.vscode-todo-highlight", "anthropic.claude-code", "openai.chatgpt"];
  for (const id of ids) {
    const [ns, name] = id.split(".");
    const meta = await metadata(ns, name);
    if (!meta) {
      console.log(`  ${id}: NÃO encontrada no Open VSX`);
      continue;
    }
    const manifest = meta.files?.manifest ? await getJson(meta.files.manifest) : null;
    const sha = meta.files?.sha256 ? "sim" : "não";
    console.log(`  ${id} ${meta.version} [${meta.targetPlatform}] pré-lançamento: ${meta.preRelease ? "sim" : "não"} · sha256 publicado: ${sha} · engines.vscode ${meta.engines?.vscode ?? "?"}`);
    printReport("manifesto do catálogo", classify({ manifest, targetPlatform: meta.targetPlatform, hostPlatform: platform, apiScan: null }, caps));
  }

  console.log("\n== Instaladas no VS Code (somente leitura) + varredura do código ==");
  const vscodeDir = path.join(os.homedir(), ".vscode", "extensions");
  const installed = listInstalled({ managed: null, vscodeDirs: [vscodeDir] });
  for (const id of ["anthropic.claude-code", "openai.chatgpt"]) {
    const e = installed.find((x: any) => x.id === id);
    if (!e) {
      console.log(`  ${id}: não instalada no VS Code`);
      continue;
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(e.path, "package.json"), "utf8"));
    const scan = scanExtension(e.path, pkg);
    console.log(`  ${id} ${e.version}: ${scan.bindings} binding(s), ${scan.paths.length} caminhos de API em ${scan.filesWithApi} arquivo(s)`);
    const tp = /-(linux|darwin|win32|alpine)-(x64|arm64|armhf)$/.exec(path.basename(e.path));
    printReport("pacote local", classify({ manifest: pkg, targetPlatform: tp ? `${tp[1]}-${tp[2]}` : null, hostPlatform: platform, apiScan: scan, builtin: true, installedIds: new Set(installed.map((x: any) => x.id)) }, caps));
  }

  const mi = process.argv.indexOf("--managed");
  if (mi > 0 && process.argv[mi + 1]) {
    const dir = process.argv[mi + 1];
    console.log(`\n== Pasta gerenciada ${dir} ==`);
    for (const e of listInstalled({ managed: dir, vscodeDirs: [] })) {
      const pkg = JSON.parse(fs.readFileSync(path.join(e.path, "package.json"), "utf8"));
      const scan = scanExtension(e.path, pkg);
      console.log(`  ${e.id} ${e.version} (origem ${e.source}, liberada no host: ${e.supported}, motivo: ${e.blockedReason ?? "-"}): ${scan.paths.length} caminhos de API em ${scan.filesWithApi} arquivo(s)`);
      printReport("instalada", classify({ manifest: pkg, targetPlatform: "universal", hostPlatform: platform, apiScan: scan }, caps));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
