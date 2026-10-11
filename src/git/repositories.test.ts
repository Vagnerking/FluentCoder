import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceRepositories, uniqueRepoRows, type DiscoveredRepo } from "./repositories.ts";
import {
  defaultTerminalTarget,
  getActiveGitRepository,
  resetActiveGitRepositoryForTests,
  resolveActiveGitRepository,
  selectGitRepository,
  setGitFocusPath,
  setGitRepositories,
  subscribeActiveGitRepository,
} from "./activeRepository.ts";

const folders = [
  { id: "f1", name: "FluentCoder", path: "/w/FluentCoder", provider: "local" as const },
  { id: "f2", name: "docs", path: "/w/FluentCoder/docs", provider: "local" as const },
  { id: "f3", name: "api", path: "/srv/api", provider: "ssh" as const },
];

const discovered: DiscoveredRepo[] = [
  {
    id: "/w/FluentCoder",
    root: "/w/FluentCoder",
    gitDir: "/w/FluentCoder/.git",
    commonDir: "/w/FluentCoder/.git",
    kind: "main",
    folders: ["/w/FluentCoder", "/w/FluentCoder/docs"],
  },
  {
    id: "/w/FluentCoder/libs/ui",
    root: "/w/FluentCoder/libs/ui",
    gitDir: "/w/FluentCoder/libs/ui/.git",
    commonDir: "/w/FluentCoder/libs/ui/.git",
    kind: "nested",
    parentRoot: "/w/FluentCoder",
    folders: [],
  },
];

test("pasta dentro de um repo já listado não vira um segundo repositório", () => {
  const { repos, folderRepo } = buildWorkspaceRepositories(folders, discovered, { f3: "c1" });
  assert.deepEqual(
    repos.map((r) => [r.name, r.provider, r.kind ?? null]),
    [
      ["FluentCoder", "local", "main"],
      ["FluentCoder/ui", "local", "nested"],
      ["api", "ssh", null],
    ]
  );
  assert.equal(folderRepo.f1, folderRepo.f2, "docs aponta para o mesmo repo");
  assert.equal(folderRepo.f3, repos[2].id);
});

test("status bar soma cada repo uma vez", () => {
  const rows = [
    { id: "f1", repoId: "r1", isRepo: true, changes: 5, ahead: 2 },
    { id: "f2", repoId: "r1", isRepo: true, changes: 5, ahead: 2 },
    { id: "f3", repoId: "r2", isRepo: true, changes: 1, ahead: 0 },
    { id: "f4", isRepo: false },
  ];
  const unique = uniqueRepoRows(rows);
  assert.deepEqual(unique.map((r) => r.id), ["f1", "f3"]);
  assert.equal(unique.reduce((n, r) => n + (r.changes ?? 0), 0), 6);
});

test("antes da descoberta cada pasta local é um alvo provisório; SSH com o mesmo toplevel é unido", () => {
  const { repos } = buildWorkspaceRepositories(folders, null, { f3: "c1" });
  assert.equal(repos.filter((r) => r.provider === "local").length, 2);
  const twoSsh = [
    { id: "s1", name: "a", path: "/srv/app", provider: "ssh" as const },
    { id: "s2", name: "b", path: "/srv/app/sub", provider: "ssh" as const },
  ];
  const merged = buildWorkspaceRepositories(twoSsh, [], { s1: "c", s2: "c" }, { s1: "/srv/app", s2: "/srv/app" });
  assert.equal(merged.repos.length, 1);
  assert.equal(merged.folderRepo.s1, merged.folderRepo.s2);
});

test("repo ativo: escolha explícita > repo mais profundo do arquivo focado > primeiro", () => {
  const { repos } = buildWorkspaceRepositories(folders, discovered, { f3: "c1" });
  assert.equal(resolveActiveGitRepository(repos, "/w/FluentCoder/libs/ui/src/a.ts", null)?.name, "FluentCoder/ui");
  assert.equal(resolveActiveGitRepository(repos, "/w/FluentCoder/docs/x.md", null)?.name, "FluentCoder");
  assert.equal(resolveActiveGitRepository(repos, "/srv/api/main.go", null, "c1")?.name, "api");
  assert.equal(resolveActiveGitRepository(repos, "/fora/x", null)?.name, "FluentCoder");
  assert.equal(resolveActiveGitRepository(repos, "/w/FluentCoder/a.ts", repos[2].id)?.name, "api");
});

test("store compartilhado notifica mudanças e a escolha explícita cede ao focar outro repo", () => {
  resetActiveGitRepositoryForTests();
  const { repos } = buildWorkspaceRepositories(folders, discovered, { f3: "c1" });
  let notified = 0;
  subscribeActiveGitRepository(() => notified++);
  setGitRepositories(repos);
  setGitFocusPath("/w/FluentCoder/src/App.tsx");
  assert.equal(getActiveGitRepository()?.name, "FluentCoder");
  selectGitRepository(repos[1].id);
  assert.equal(getActiveGitRepository()?.name, "FluentCoder/ui");
  // Mesmo arquivo de antes (dentro do repo pai): mantém a escolha.
  setGitFocusPath("/w/FluentCoder/src/App.tsx");
  assert.equal(getActiveGitRepository()?.name, "FluentCoder/ui");
  // Arquivo de outro repo: segue o editor.
  setGitFocusPath("/srv/api/main.go", "c1");
  assert.equal(getActiveGitRepository()?.name, "api");
  assert.ok(notified >= 3);
  setGitRepositories(repos);
  const before = notified;
  setGitRepositories([...repos]);
  assert.equal(notified, before, "lista igual não notifica");
});

test("terminal novo abre no repositório ativo (SSH leva a conexão)", () => {
  resetActiveGitRepositoryForTests();
  assert.deepEqual(defaultTerminalTarget("/w"), { cwd: "/w", connId: null });
  const { repos } = buildWorkspaceRepositories(folders, discovered, { f3: "c1" });
  setGitRepositories(repos);
  selectGitRepository(repos[1].id);
  assert.deepEqual(defaultTerminalTarget("/w"), { cwd: repos[1].root, connId: null });
  selectGitRepository(repos[2].id);
  assert.deepEqual(defaultTerminalTarget("/w"), { cwd: "/srv/api", connId: "c1" });
  assert.deepEqual(defaultTerminalTarget("/w", null), { cwd: "/w", connId: null });
});
