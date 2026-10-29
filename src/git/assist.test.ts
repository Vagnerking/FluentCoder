import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGitAssistPrompt,
  normalizeGitAssistValue,
  suggestWithGitAssistant,
  type GitAssistRequest,
} from "./assist.ts";

const request: GitAssistRequest = {
  kind: "commitMessage",
  repoName: "FluentCoder",
  rootPath: "C:/repo",
  branch: "main",
  provider: "local",
  files: [
    {
      path: "src/components/GitPanel.tsx",
      code: " M",
      staged: true,
      untracked: false,
      conflicted: false,
    },
  ],
  recentCommits: [
    {
      hash: "abc",
      short: "abc",
      author: "Rafael",
      date: "hoje",
      subject: "feat: improve source control panel",
    },
  ],
  fallback: "feat: update git panel",
};

test("prompt de assistência inclui arquivos alterados e commits recentes", () => {
  const prompt = buildGitAssistPrompt(request);

  assert.match(prompt, /Gere apenas uma mensagem de commit em uma linha/);
  assert.match(prompt, /Siga o padrão dominante dos commits recentes/);
  assert.match(prompt, /M staged src\/components\/GitPanel\.tsx/);
  assert.match(prompt, /feat: improve source control panel/);
});

test("prompt aceita instruções futuras de configuração", () => {
  const prompt = buildGitAssistPrompt({
    ...request,
    preferences: {
      instructions: {
        commitMessage: "Sempre use escopo git quando possível.",
      },
      maxFiles: 1,
      maxRecentCommits: 1,
    },
  });

  assert.match(prompt, /Sempre use escopo git quando possível/);
  assert.doesNotMatch(prompt, /Use português ou inglês conforme/);
});

test("normaliza resposta de commit para uma linha sem aspas", () => {
  assert.equal(
    normalizeGitAssistValue("commitMessage", '"feat: polish source control"\n\nexplicação'),
    "feat: polish source control",
  );
});

test("normaliza nome de branch para slug git seguro", () => {
  assert.equal(
    normalizeGitAssistValue("branchName", "Feat / Git Panel Polish!"),
    "feat/git-panel-polish",
  );
});

test("usa agente quando disponível e fallback quando indisponível", async () => {
  const assisted = await suggestWithGitAssistant(request, async () => "fix: tune git assist");
  assert.deepEqual(assisted, {
    value: "fix: tune git assist",
    source: "agent",
  });

  const fallback = await suggestWithGitAssistant(request, async () => null);
  assert.deepEqual(fallback, {
    value: request.fallback,
    source: "heuristic",
  });
});
