import assert from "node:assert/strict";
import test from "node:test";
import { remoteProviderLabel } from "./remoteLabels.ts";

test("remote provider labels use the URL or SCP hostname", () => {
  for (const [domain, label] of [["github.com", "GitHub"], ["gitlab.com", "GitLab"], ["bitbucket.org", "Bitbucket"]]) {
    for (const remote of [
      `https://${domain}/org/repo.git`,
      `ssh://git@${domain}:2222/org/repo.git`,
      `git@${domain}:org/repo.git`,
      `user@ssh.${domain}:org/repo.git`,
      `  HTTPS://${domain.toUpperCase()}/org/repo.git  `,
    ]) assert.equal(remoteProviderLabel(remote), label, remote);
    for (const remote of [
      `https://${domain}.evil.example/org/repo.git`,
      `https://not${domain}/org/repo.git`,
      `https://${domain}@evil.example/org/repo.git`,
      `https://evil.example/${domain}/repo.git`,
      `https://evil.example/repo.git?host=${domain}#${domain}`,
      `git@evil.example:${domain}/repo.git`,
    ]) assert.equal(remoteProviderLabel(remote), "Git", remote);
  }
  for (const remote of ["", "not a remote", "/repos/github.com/repo", "https://[github.com/repo", "git@example.com:repo.git"]) {
    assert.equal(remoteProviderLabel(remote), "Git", remote);
  }
});
