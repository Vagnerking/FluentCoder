import type { VscodeLaunch, VscodeTask } from "./vscodeCompat.ts";

/** IPC data, never a shell command assembled from a display string. */
export type RunStep =
  | { kind: "process"; executable: string; args: string[]; cwd: string }
  | { kind: "shell"; source: string; args: string[]; cwd: string };

export interface TaskExecutionPlan {
  baseCwd: string;
  steps: RunStep[];
  stopOnFailure: boolean;
}

/** Legacy free-form Run configurations remain intentional shell source. */
export type TerminalCommand = string | TaskExecutionPlan;

export function taskExecutionPlan(task: VscodeTask, tasks: readonly VscodeTask[], baseCwd: string): TaskExecutionPlan {
  const steps: RunStep[] = [];
  const active = new Set<string>();
  const completed = new Set<string>();
  const visit = (current: VscodeTask) => {
    if (active.has(current.label)) throw new Error(`Dependência circular na tarefa "${current.label}".`);
    if (completed.has(current.label)) return;
    if (current.unsupported) throw new Error(`Tarefa "${current.label}": ${current.unsupported}.`);
    active.add(current.label);
    for (const label of current.dependsOn) {
      const dep = tasks.find((entry) => entry.label === label);
      if (!dep) throw new Error(`Dependência "${label}" da tarefa "${current.label}" não encontrada.`);
      visit(dep);
    }
    if (current.execution) steps.push({ ...current.execution, args: [...current.execution.args], cwd: current.cwd });
    else if (!current.dependsOn.length) throw new Error(`Tarefa "${current.label}" sem execução.`);
    active.delete(current.label);
    completed.add(current.label);
  };
  visit(task);
  if (!steps.length) throw new Error("Nenhuma etapa executável na tarefa.");
  return { baseCwd, steps, stopOnFailure: true };
}

export function launchExecutionPlan(launch: VscodeLaunch, tasks: readonly VscodeTask[], baseCwd: string): TaskExecutionPlan {
  if (!launch.execution) throw new Error(launch.unsupported ?? "Configuração sem execução.");
  const steps: RunStep[] = [];
  if (launch.preLaunchTask) {
    const task = tasks.find((entry) => entry.label === launch.preLaunchTask);
    if (!task) throw new Error(`preLaunchTask "${launch.preLaunchTask}" não encontrada.`);
    steps.push(...taskExecutionPlan(task, tasks, baseCwd).steps);
  }
  steps.push({ ...launch.execution, args: [...launch.execution.args], cwd: launch.cwd });
  return { baseCwd, steps, stopOnFailure: true };
}
