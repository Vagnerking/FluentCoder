import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote, parseTasks, parseLaunch, taskCommandLine, launchCommandLine } from "./vscodeCompat.ts";

const args = [
  "", "normal", "com espaço", "C:\\pasta com espaço\\", "a\\b", "a\"b", "it's",
  "@args", "a,b", "$env:PATH", "a$($script:ran = 1)b", "a`nb", "a;b&c|d", "linha\nseguinte",
  ...["'", "\u2018", "\u2019", "\u201a", "\u201b"].map((quote) => `a${quote}; $script:ran = 1; #`),
];

test("argumentos PowerShell são literais, incluindo aspas Unicode e splatting", () => {
  assert.equal(shellQuote("@args", true), "'@args'");
  for (const quote of ["'", "\u2018", "\u2019", "\u201a", "\u201b"]) {
    assert.equal(shellQuote(`a${quote}b`, true), `'a${quote}${quote}b'`);
  }
  assert.equal(shellQuote("C:\\pasta\\", true), "'C:\\pasta\\'");
});

test("argumentos POSIX com barras e aspas sobrevivem ao shell real", { skip: process.platform === "win32" }, () => {
  const values = [...args, "`printf unexpected`", "$(printf unexpected)"];
  const result = spawnSync("/bin/sh", ["-c", `printf '%s\\0' ${values.map((arg) => shellQuote(arg)).join(" ")}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split("\0").slice(0, -1), values);
});

// Regressão executável nos interpretadores disponíveis; não simula seu parser.
const shells = process.env.FLUENT_TEST_POWERSHELL
  ? [process.env.FLUENT_TEST_POWERSHELL]
  : process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh"];

function run(shell: string, source: string) {
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; $script:ran = 0; $script:got = @(); function Capture { $script:got = @($args) }; ${source}; ConvertTo-Json -Compress -Depth 10 -InputObject @{ran=$script:ran; got=$script:got}`;
  return spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 20_000 });
}

for (const shell of shells) {
  const available = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 20_000 });
  test(`PowerShell real (${shell}): marcador de subexpressão permanece texto`, { skip: available.status !== 0 }, () => {
    const value = "a$($script:ran = 1)b";
    const result = run(shell, `Capture ${shellQuote(value, true)}`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ran: 0, got: [value] });
  });
  test(`PowerShell real (${shell}): dados não executam expressões e argumentos chegam intactos`, { skip: available.status !== 0 }, () => {
    const context = { workspaceFolder: "C:\\repo", file: "a$($script:ran = 1)b.cs", config: () => "@args" };
    const task = parseTasks(JSON.stringify({ tasks: [{ label: "t", type: "process", command: "Capture", args: [...args, "${file}", "${config:x}"] }] }), context, "windows")[0];
    const result = run(shell, task.command!);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ran: 0, got: [...args, context.file, "@args"] });
    const launch = parseLaunch(JSON.stringify({ configurations: [{ type: "node", program: context.file, args }] }), context, "windows")[0];
    const launchResult = run(shell, `function node { $script:got = @($args) }; ${launch.command}`);
    assert.equal(launchResult.status, 0, launchResult.stderr);
    assert.deepEqual(JSON.parse(launchResult.stdout), { ran: 0, got: [context.file, ...args] });
  });

  test(`PowerShell real (${shell}): process.command não é uma linha de código`, { skip: available.status !== 0 }, () => {
    const task = parseTasks(JSON.stringify({ tasks: [{ label: "t", type: "process", command: "Capture; $script:ran = 1; #" }] }), { workspaceFolder: "C:\\repo" }, "windows")[0];
    const result = run(shell, `try { ${task.command} } catch { }`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ran, 0);
    // O tipo shell continua aceitando código intencional.
    assert.equal(parseTasks('{"tasks":[{"type":"shell","command":"echo a; echo b"}]}', { workspaceFolder: "C:\\repo" }, "windows")[0].command, "echo a; echo b");
  });

  // A regressão --% com programa nativo migrou para task_execution.rs:
  // process.command não atravessa mais o binder PowerShell em produção.

  test(`PowerShell real (${shell}): cwd literal em tarefas, launch e preLaunchTask`, { skip: available.status !== 0 }, (t) => {
    const root = mkdtempSync(join(tmpdir(), "fluent-shell-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cwd = join(root, "it's ’ [literal] $envPATH");
    mkdirSync(cwd);
    const context = { workspaceFolder: cwd };
    const tasks = parseTasks(JSON.stringify({ tasks: [{ label: "pre", type: "process", command: "Capture", args: ["before"], options: { cwd } }] }), context, "windows");
    const launch = parseLaunch(JSON.stringify({ configurations: [{ type: "node", program: "it's.js", cwd, preLaunchTask: "pre", args: ["after"] }] }), context, "windows")[0];
    const result = run(shell, `function node { $script:got = @($PWD.Path) + @($args) }; ${launchCommandLine(launch, tasks, true)}`);
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.ran, 0);
    // Windows may expand an 8.3 TEMP prefix in $PWD.Path, while Node's
    // realpathSync preserves that alias. Compare filesystem identity instead.
    const expectedDir = statSync(cwd, { bigint: true });
    const actualDir = statSync(actual.got[0], { bigint: true });
    assert.notEqual(expectedDir.ino, 0n, "the filesystem must provide a directory identity");
    assert.equal(actualDir.isDirectory(), true);
    assert.deepEqual([actualDir.dev, actualDir.ino], [expectedDir.dev, expectedDir.ino]);
    assert.deepEqual(actual.got.slice(1), ["it's.js", "after"]);
    assert.equal(launchCommandLine({ ...launch, command: null }, tasks, true), null);
  });
}

test("POSIX: launch com cwd e process.command mantêm dados literais", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "fluent-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "it's [literal] $(printf unexpected)");
  mkdirSync(cwd);
  const launch = parseLaunch(JSON.stringify({ configurations: [{ type: "node", program: "it's.js", cwd, args: ["after"] }] }), { workspaceFolder: cwd })[0];
  const result = spawnSync("/bin/sh", ["-c", `node() { printf '%s\\0' "$PWD" "$@"; }; ${launchCommandLine(launch, [])}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split("\0").slice(0, -1), [cwd, "it's.js", "after"]);
  const task = parseTasks('{"tasks":[{"type":"process","command":"INJECTED=value"}]}', { workspaceFolder: cwd })[0];
  assert.equal(task.command, "'INJECTED=value'");
});

test("cwd usa o mesmo escape dos argumentos", () => {
  const cwd = "C:\\it's [literal] $env:PATH";
  const task = parseTasks(JSON.stringify({ tasks: [{ label: "t", type: "shell", command: "Capture", options: { cwd } }] }), { workspaceFolder: cwd }, "windows")[0];
  assert.equal(taskCommandLine(task, [task], true), `Set-Location -LiteralPath ${shellQuote(cwd, true)}; Capture`);
});
