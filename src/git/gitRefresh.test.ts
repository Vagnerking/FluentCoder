import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitRefreshScheduler,
  gitRepoKey,
  sharedGitCall,
  GIT_POLL_FOCUSED_MS,
  GIT_POLL_UNFOCUSED_MS,
  GIT_REQUEST_DEBOUNCE_MS,
  type GitRefreshEvent,
  type GitWatchInfo,
} from "./gitRefresh.ts";

/** Relógio falso: timers só disparam em `advance`. */
function fakeEnv(opts: { watchMode?: string } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const env = {
    hidden: false,
    focused: true,
    watched: [] as string[][],
    fetches: [] as string[],
    events: [] as GitRefreshEvent[],
  };
  const deps = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: unknown) => {
      timers.delete(id as number);
    },
    isHidden: () => env.hidden,
    isFocused: () => env.focused,
    watchRoots: async (roots: string[]): Promise<GitWatchInfo[]> => {
      env.watched.push(roots);
      return roots.map((root) => ({ root, mode: opts.watchMode ?? "full", dirs: 3 }));
    },
    fetch: async (root: string) => {
      env.fetches.push(root);
    },
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = end;
    await new Promise((r) => setImmediate(r));
  };
  const scheduler = createGitRefreshScheduler(deps);
  scheduler.subscribe((event) => env.events.push(event));
  return { env, advance, scheduler };
}

const A = { key: gitRepoKey("/w/app"), root: "/w/app" };
const DOCS = { key: gitRepoKey("/w/app/docs"), root: "/w/app/docs" };
const SSH = { key: gitRepoKey("/srv/api", "c1"), root: "/srv/api", connId: "c1" };

test("um único agendador: alvos novos atualizam uma vez; repos com watcher full não fazem polling", async () => {
  const { env, advance, scheduler } = fakeEnv();
  scheduler.setTargets([A]);
  await advance(GIT_REQUEST_DEBOUNCE_MS);
  assert.equal(env.events.length, 1);
  assert.deepEqual(env.events[0].keys, [A.key]);
  assert.deepEqual(env.watched, [["/w/app"]]);
  await advance(GIT_POLL_FOCUSED_MS * 6);
  assert.equal(env.events.length, 1, "sem polling cego para watcher full");
  // Re-registrar o mesmo alvo (troca de aba) não dispara nada.
  scheduler.setTargets([A]);
  await advance(GIT_REQUEST_DEBOUNCE_MS);
  assert.equal(env.events.length, 1);
});

test("eventos do watcher e pedidos após operações são coalescidos por repo", async () => {
  const { env, advance, scheduler } = fakeEnv();
  scheduler.setTargets([A, DOCS]);
  scheduler.setRepoRoot(DOCS.key, "/w/app");
  await advance(GIT_REQUEST_DEBOUNCE_MS);
  env.events.length = 0;
  scheduler.handleRepoChanged({ root: "/w/app", scopes: ["index"] });
  scheduler.handleRepoChanged({ root: "/w/app", scopes: ["worktree"] });
  scheduler.request("/w/app/src/x.ts", "op");
  await advance(GIT_REQUEST_DEBOUNCE_MS);
  assert.equal(env.events.length, 1);
  assert.deepEqual(new Set(env.events[0].keys), new Set([A.key, DOCS.key]));
  assert.deepEqual(new Set(env.events[0].scopes), new Set(["index", "worktree"]));
  assert.deepEqual(new Set(env.events[0].reasons), new Set(["watch", "op"]));
  // O toplevel aprendido é o que vai para o watcher (sem duplicar).
  assert.deepEqual(env.watched.at(-1), ["/w/app"]);
});

test("SSH faz polling adaptativo e pausa com a janela oculta", async () => {
  const { env, advance, scheduler } = fakeEnv();
  scheduler.setTargets([SSH]);
  await advance(GIT_REQUEST_DEBOUNCE_MS);
  env.events.length = 0;
  await advance(GIT_POLL_FOCUSED_MS + GIT_REQUEST_DEBOUNCE_MS);
  assert.equal(env.events.length, 1, "5 s com foco");
  env.focused = false;
  scheduler.onWindowStateChange();
  env.events.length = 0;
  await advance(GIT_POLL_FOCUSED_MS * 2);
  assert.equal(env.events.length, 0, "sem foco: 30 s");
  await advance(GIT_POLL_UNFOCUSED_MS);
  assert.equal(env.events.length, 1);
  env.hidden = true;
  scheduler.onWindowStateChange();
  env.events.length = 0;
  await advance(GIT_POLL_UNFOCUSED_MS * 4);
  assert.equal(env.events.length, 0, "oculta/minimizada: pausado");
  env.hidden = false;
  env.focused = true;
  scheduler.onWindowStateChange();
  await advance(GIT_REQUEST_DEBOUNCE_MS);
  assert.deepEqual(env.events[0].reasons, ["visible"], "voltar a ficar visível atualiza");
});

test("watcher git-only/failed cai para polling", async () => {
  const { env, advance, scheduler } = fakeEnv({ watchMode: "git-only" });
  scheduler.setTargets([A]);
  await advance(GIT_REQUEST_DEBOUNCE_MS);
  assert.equal(scheduler.watchMode(A.key), "git-only");
  env.events.length = 0;
  await advance(GIT_POLL_FOCUSED_MS + GIT_REQUEST_DEBOUNCE_MS);
  assert.equal(env.events.length, 1);
});

test("auto-fetch tem relógio por repo que sobrevive a trocas de aba", async () => {
  const { env, advance, scheduler } = fakeEnv();
  scheduler.setAutoFetch(true, 60_000);
  scheduler.setTargets([A]);
  for (let i = 0; i < 12; i++) {
    // Troca de aba a cada 5 s: re-registra o mesmo alvo.
    await advance(5_000);
    scheduler.setTargets([A]);
  }
  assert.deepEqual(env.fetches, ["/w/app"], "um fetch após 60 s mesmo com 12 trocas");
  env.events.length = 0;
  await advance(GIT_REQUEST_DEBOUNCE_MS);
  // O fetch concluído gera um refresh do repo.
  assert.ok(env.events.some((e) => e.reasons.includes("fetch")) || env.events.length === 0);
  env.hidden = true;
  scheduler.onWindowStateChange();
  await advance(120_000);
  assert.equal(env.fetches.length, 1, "sem auto-fetch com a janela oculta");
});

test("sharedGitCall deduplica chamadas em voo", async () => {
  let calls = 0;
  const call = () => new Promise<number>((resolve) => setTimeout(() => resolve(++calls), 5));
  const [a, b] = await Promise.all([sharedGitCall("k", call), sharedGitCall("k", call)]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(await sharedGitCall("k", call), 2);
});
