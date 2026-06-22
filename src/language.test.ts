import assert from "node:assert/strict";
import test from "node:test";
import {
  getLanguageOverride,
  languageForFile,
  setLanguageOverride,
} from "./language.ts";
import { setActiveRemote, type RemoteSession } from "./remote/host.ts";

function remote(connId: string, host: string): RemoteSession {
  return { connId, host, user: "dev", rootPath: "/workspace" };
}

test("language overrides are isolated between local and remote workspaces", () => {
  const path = "/workspace/component.ts";
  setActiveRemote(null);
  setLanguageOverride(path, "typescriptreact");
  assert.equal(getLanguageOverride(path), "typescriptreact");

  setActiveRemote(remote("ssh-1", "host-a"));
  assert.equal(languageForFile("component.ts", path), "typescript");
  setLanguageOverride(path, "javascriptreact");
  assert.equal(getLanguageOverride(path), "javascriptreact");

  setActiveRemote(remote("ssh-2", "host-b"));
  assert.equal(languageForFile("component.ts", path), "typescript");

  setActiveRemote(null);
  assert.equal(getLanguageOverride(path), "typescriptreact");
  setLanguageOverride(path, null);
  setActiveRemote(remote("ssh-1", "host-a"));
  setLanguageOverride(path, null);
  setActiveRemote(null);
});
