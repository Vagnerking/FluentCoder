import assert from "node:assert/strict";
import test from "node:test";

// localStorage mínimo para o idioma de settings do projeto.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

const { resolveGitAvatar, peekGitAvatar, setGitAvatarResolverForTests, gitAvatarInitials } = await import("./avatars.ts");
const { setGitAvatarMode, getGitAvatarMode } = await import("./gitSettings.ts");

test("padrão é github; off nunca chama o backend; resultados são cacheados e deduplicados", async () => {
  assert.equal(getGitAvatarMode(), "github");
  const calls: string[] = [];
  setGitAvatarResolverForTests(async (email, mode) => {
    calls.push(`${mode}:${email}`);
    return email.endsWith("@users.noreply.github.com") ? "data:image/png;base64,AA" : null;
  });
  const [a, b] = await Promise.all([
    resolveGitAvatar("1+ana@users.noreply.github.com"),
    resolveGitAvatar("1+ana@users.noreply.github.com"),
  ]);
  assert.equal(a, "data:image/png;base64,AA");
  assert.equal(b, a);
  assert.equal(calls.length, 1, "deduplicado");
  assert.equal(peekGitAvatar("1+ana@users.noreply.github.com"), a, "peek usa o cache");
  assert.equal(await resolveGitAvatar("bia@empresa.com"), null);
  assert.equal(await resolveGitAvatar("bia@empresa.com"), null);
  assert.equal(calls.length, 2, "negativo também é cacheado");

  setGitAvatarMode("off");
  calls.length = 0;
  assert.equal(await resolveGitAvatar("1+ana@users.noreply.github.com"), null);
  assert.equal(peekGitAvatar("1+ana@users.noreply.github.com"), null);
  assert.equal(calls.length, 0, "off: nenhuma chamada");

  setGitAvatarMode("gravatar");
  await resolveGitAvatar("bia@empresa.com");
  assert.deepEqual(calls, ["gravatar:bia@empresa.com"], "troca de modo invalida o cache");
});

test("iniciais", () => {
  assert.equal(gitAvatarInitials("Rafael Gomes"), "RG");
  assert.equal(gitAvatarInitials("vagner"), "V");
  assert.equal(gitAvatarInitials(""), "?");
});
