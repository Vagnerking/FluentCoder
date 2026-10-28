import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultBuildTask,
  parseExtensionRecommendations,
  parseLaunch,
  parseTasks,
  substituteVariables,
  taskCommandLine,
} from "./vscodeCompat.ts";

const ctx = { workspaceFolder: "/w/app", file: "/w/app/src/main.ts", config: (k: string) => (k === "editor.tabSize" ? 2 : undefined), env: { HOME: "/home/u" } };

test("extensions.json: recomendações sem duplicatas e sem as indesejadas", () => {
  const r = parseExtensionRecommendations([
    '{ // comentário\n "recommendations": ["ms-dotnettools.csharp", "Esbenp.Prettier-VSCode", "lixo"], "unwantedRecommendations": ["ms-dotnettools.csharp"] }',
    { recommendations: ["esbenp.prettier-vscode", "dbaeumer.vscode-eslint"] },
    null,
  ]);
  assert.deepEqual(r.recommendations, ["esbenp.prettier-vscode", "dbaeumer.vscode-eslint"]);
  assert.deepEqual(r.unwanted, ["ms-dotnettools.csharp"]);
});

test("variáveis do VS Code", () => {
  assert.equal(substituteVariables("${workspaceFolder}/out", ctx), "/w/app/out");
  assert.equal(substituteVariables("${workspaceFolderBasename}", ctx), "app");
  assert.equal(substituteVariables("${relativeFile}", ctx), "src/main.ts");
  assert.equal(substituteVariables("${fileBasenameNoExtension}${fileExtname}", ctx), "main.ts");
  assert.equal(substituteVariables("${env:HOME}|${config:editor.tabSize}|${input:x}", ctx), "/home/u|2|${input:x}");
});

test("tasks.json: shell/process/npm, grupo build padrão, dependsOn e tipos sem suporte", () => {
  const tasks = parseTasks(
    `{
      // tarefas
      "version": "2.0.0",
      "tasks": [
        { "label": "restore", "type": "shell", "command": "dotnet", "args": ["restore"] },
        { "label": "build", "type": "process", "command": "dotnet", "args": ["build", "\${workspaceFolder}/App Sln.sln"], "dependsOn": "restore",
          "group": { "kind": "build", "isDefault": true }, "options": { "cwd": "\${workspaceFolder}/src" } },
        { "type": "npm", "script": "lint", "path": "web", "group": "test" },
        { "label": "gulp", "type": "gulp", "task": "x" },
        { "label": "win", "type": "shell", "command": "make", "windows": { "command": "nmake" } }
      ]
    }`,
    ctx,
  );
  assert.equal(tasks.length, 5);
  assert.equal(tasks[1].command, "'dotnet' build '/w/app/App Sln.sln'");
  assert.equal(tasks[1].cwd, "/w/app/src");
  assert.equal(tasks[2].label, "npm: lint");
  assert.equal(tasks[2].cwd, "web");
  assert.equal(tasks[2].group, "test");
  assert.equal(tasks[3].command, null);
  assert.match(tasks[3].unsupported ?? "", /gulp/);
  assert.equal(defaultBuildTask(tasks)?.label, "build");
  assert.equal(taskCommandLine(tasks[1], tasks), "dotnet restore && cd -- /w/app/src && 'dotnet' build '/w/app/App Sln.sln'");
  assert.equal(parseTasks('{"tasks":[{"label":"win","type":"shell","command":"make","windows":{"command":"nmake"}}]}', ctx, "windows")[0].command, "nmake");
});

test("launch.json: node/coreclr/python viram 'executar sem depurar'; attach e tipos desconhecidos não", () => {
  const l = parseLaunch(
    `{ "configurations": [
      { "name": "API", "type": "coreclr", "request": "launch", "preLaunchTask": "build", "program": "\${workspaceFolder}/bin/Debug/net8.0/Api.dll", "args": ["--urls", "http://localhost:5000"], "cwd": "\${workspaceFolder}" },
      { "name": "Node", "type": "node", "request": "launch", "program": "\${file}" },
      { "name": "Anexar", "type": "coreclr", "request": "attach" },
      { "name": "Chrome", "type": "chrome", "request": "launch", "url": "http://localhost" },
      { "name": "C# Dev Kit", "type": "dotnet", "request": "launch", "projectPath": "\${workspaceFolder}/Api.csproj" }
    ] }`,
    ctx,
  );
  assert.equal(l[0].command, "dotnet /w/app/bin/Debug/net8.0/Api.dll --urls http://localhost:5000");
  assert.equal(l[0].preLaunchTask, "build");
  assert.equal(l[1].command, "node /w/app/src/main.ts");
  assert.equal(l[2].command, null);
  assert.equal(l[3].command, null);
  assert.equal(l[4].command, "dotnet run --project /w/app/Api.csproj");
});
