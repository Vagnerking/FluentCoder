import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function reviewErrors(files, pr) {
  const errors = [];
  if (files.length > 100) errors.push(`${files.length} arquivos alterados; divida o PR em partes de até 100 arquivos para permitir revisão.`);
  if (!pr) return errors;
  if (!/^(feat|fix|perf|refactor|docs|test|chore|build|ci|revert)(\([^\r\n()]+\))?!?: \S[^\r\n]*$/.test(pr.title ?? '')) {
    errors.push('Título deve seguir Conventional Commits, por exemplo: fix(git): validar host do remoto.');
  }
  const body = (pr.body ?? '').replace(/<!--[\s\S]*?-->/g, '');
  for (const heading of ['Descrição', 'Como testar']) {
    const section = body.split(`## ${heading}`)[1]?.split(/^## /m)[0] ?? '';
    const content = section.replace(/^\s*Closes\s+#\s*$/gim, '').replace(/^\s*(?:\d+\.|- \[[ x]\])\s*/gm, '').trim();
    if (!content) errors.push(`Preencha a seção "${heading}" com resultado e evidência reais.`);
  }
  if (/^\s*Closes\s+#\s*$/im.test(body)) errors.push('Remova "Closes #" vazio ou informe a issue.');
  return errors;
}

export function changedFiles(base, head, cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
  // Resolve refs to hashes before forming revision expressions. No shell execution.
  const resolve = (ref) => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  const baseSha = resolve(base);
  const headSha = resolve(head ?? 'HEAD');
  const files = git('diff', '--name-only', '-z', `${baseSha}...${headSha}`, '--');
  const local = head ? '' : git('diff', '--name-only', '-z', 'HEAD', '--') + git('ls-files', '--others', '--exclude-standard', '-z');
  return [...new Set((files + local).split('\0').filter(Boolean))];
}

export function main(args) {
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!['--base', '--head', '--event'].includes(key) || !args[0] || args[0].startsWith('--')) {
      throw new Error('Uso: node scripts/pr-check.mjs --base <ref> [--head <ref>] [--event <event.json>]');
    }
    options[key.slice(2)] = args.shift();
  }
  if (!options.base) throw new Error('Informe --base explicitamente: use a base real do PR.');
  const files = changedFiles(options.base, options.head);
  const pr = options.event ? JSON.parse(readFileSync(options.event, 'utf8')).pull_request : undefined;
  if (options.event && !pr) throw new Error('Evento não contém pull_request.');
  const errors = reviewErrors(files, pr);
  console.log(`${files.length} arquivos no escopo. Este check valida tamanho e metadados; não substitui testes ou análise de segurança.`);
  for (const error of errors) console.error(error);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
