import assert from "node:assert/strict";
import test from "node:test";
import { parseLaunch, parseTasks } from "./vscodeCompat.ts";
import { taskExecutionPlan, launchExecutionPlan } from "./taskExecution.ts";

test("process preserva programa e argv como dados, independentemente da prévia", () => {
  const values = ["--%", "a b", "%PATH%", "@args", "$env:PATH", "a$($script:ran = 1)b", "", 'a"b', "it's", "C:\\trailing\\"];
  const tasks = parseTasks(JSON.stringify({ tasks: [{ label: "run", type: "process", command: "C:\\my apps\\node.exe", args: values }] }), { workspaceFolder: "C:\\repo" }, "windows");
  tasks[0].command = "THIS DISPLAY STRING MUST NEVER EXECUTE";
  const plan = taskExecutionPlan(tasks[0], tasks, "C:\\repo");
  assert.deepEqual(plan.steps, [{ kind: "process", executable: "C:\\my apps\\node.exe", args: values, cwd: "" }]);
  assert.equal(plan.stopOnFailure, true);
  assert.equal(plan.baseCwd, "C:\\repo");
});

test("dependências e launch mantêm ordem, cwd independente e variáveis", () => {
  const context = { workspaceFolder: "/workspace", file: "file with $() and 'quotes'.js" };
  const tasks = parseTasks(JSON.stringify({ tasks: [
    { label: "restore", type: "process", command: "dotnet", args: ["restore"], options: { cwd: "sub" } },
    { label: "build", type: "process", command: "dotnet", args: ["build"], dependsOn: "restore" },
  ] }), context);
  const launch = parseLaunch(JSON.stringify({ configurations: [{ type: "node", program: "${file}", args: ["--%"], preLaunchTask: "build" }] }), context)[0];
  const plan = launchExecutionPlan(launch, tasks, context.workspaceFolder);
  assert.deepEqual(plan.steps.map((step) => [step.kind, step.args, step.cwd]), [["process", ["restore"], "sub"], ["process", ["build"], ""], ["process", [context.file, "--%"], ""]]);
});

test("dependência ausente, ciclo e preLaunchTask ausente não são ignorados", () => {
  const tasks = parseTasks('{"tasks":[{"label":"a","dependsOn":"b"},{"label":"b","dependsOn":"a"}]}', { workspaceFolder: "/w" });
  assert.throws(() => taskExecutionPlan(tasks[0], tasks, "/w"), /circular/);
  assert.throws(() => taskExecutionPlan(tasks[0], tasks.slice(0, 1), "/w"), /não encontrada/);
  const launch = parseLaunch('{"configurations":[{"type":"node","program":"a.js","preLaunchTask":"missing"}]}', { workspaceFolder: "/w" })[0];
  assert.throws(() => launchExecutionPlan(launch, [], "/w"), /preLaunchTask/);
});

test("shell intencional e npm têm representações distintas", () => {
  const tasks = parseTasks('{"tasks":[{"type":"shell","command":"echo a; echo b","args":["literal"]},{"type":"npm","script":"lint","path":"web"}]}', { workspaceFolder: "/w" });
  assert.deepEqual(tasks[0].execution, { kind: "shell", source: "echo a; echo b", args: ["literal"], cwd: "" });
  assert.deepEqual(taskExecutionPlan(tasks[1], tasks, "/w").steps, [{ kind: "process", executable: "npm", args: ["run", "lint"], cwd: "web" }]);
});
