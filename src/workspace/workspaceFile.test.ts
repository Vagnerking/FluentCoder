import assert from "node:assert/strict";
import test from "node:test";
import {
  fluentWorkspaceFromCodeWorkspace,
  isFluentWorkspaceFile,
  normalizeWorkspaceFile,
  parseWorkspaceFile,
  serializeWorkspaceFile,
} from "./workspaceFile.ts";

test("normalizes local and ssh workspace folders", () => {
  const workspace = normalizeWorkspaceFile(
    {
      fluentWorkspace: 1,
      name: "BlackRed",
      folders: [
        { name: "app", path: "C:/src/app" },
        {
          path: "/srv/site",
          remote: { type: "ssh", host: "prod", user: "deploy", port: 2222 },
        },
      ],
    },
    "C:/work/blackred.fluent-workspace"
  );

  assert.equal(workspace.name, "BlackRed");
  assert.equal(workspace.gitMode, "perFolder");
  assert.equal(workspace.folders[0].provider, "local");
  assert.equal(workspace.folders[0].name, "app");
  assert.equal(workspace.folders[1].provider, "ssh");
  assert.equal(workspace.folders[1].name, "site");
  assert.deepEqual(workspace.folders[1].remote, {
    type: "ssh",
    host: "prod",
    user: "deploy",
    port: 2222,
    keyPath: undefined,
  });
});

test("derives a workspace name from the file path", () => {
  const workspace = normalizeWorkspaceFile(
    {
      fluentWorkspace: 1,
      folders: [{ path: "C:/src/app" }],
    },
    "C:/work/clientes.fluent-workspace"
  );

  assert.equal(workspace.name, "clientes");
});

test("rejects secrets and invalid ssh authorities by schema", () => {
  assert.throws(
    () =>
      normalizeWorkspaceFile({
        fluentWorkspace: 1,
        folders: [{ path: "/srv/site", remote: { type: "ssh", host: "prod" } }],
      }),
    /remote.user/
  );
  assert.throws(
    () =>
      normalizeWorkspaceFile({
        fluentWorkspace: 1,
        folders: [
          {
            path: "/srv/site",
            remote: { type: "ssh", host: "prod", user: "deploy", port: 70000 },
          },
        ],
      }),
    /remote.port/
  );
});

test("serializes a normalized workspace without mutating folders", () => {
  const workspace = parseWorkspaceFile(`{
    "fluentWorkspace": 1,
    "folders": [
      { "name": "api", "path": "C:/src/api" },
      {
        "name": "prod",
        "path": "/srv/api",
        "remote": { "type": "ssh", "host": "prod", "user": "deploy", "keyPath": "C:/Users/me/.ssh/id_ed25519" }
      }
    ],
    "settings": { "editor.tabSize": 2 }
  }`);

  const reparsed = parseWorkspaceFile(serializeWorkspaceFile(workspace));
  assert.equal(reparsed.folders.length, 2);
  assert.equal(reparsed.folders[1].remote?.keyPath, "C:/Users/me/.ssh/id_ed25519");
  assert.deepEqual(reparsed.settings, { "editor.tabSize": 2 });
});

test("converts a basic VS Code code-workspace file to Fluent Workspace format", () => {
  const fluent = fluentWorkspaceFromCodeWorkspace(
    {
      folders: [
        { name: "web", path: "../web" },
        { path: "../api" },
      ],
      settings: { "files.exclude": { "**/bin": true } },
    },
    "stack"
  );

  const normalized = normalizeWorkspaceFile(fluent);
  assert.equal(normalized.name, "stack");
  assert.deepEqual(
    normalized.folders.map((folder) => folder.name),
    ["web", "api"]
  );
  assert.deepEqual(normalized.settings, { "files.exclude": { "**/bin": true } });
});

test("recognizes fluent workspace paths case-insensitively", () => {
  assert.equal(isFluentWorkspaceFile("C:/work/BlackRed.fluent-workspace"), true);
  assert.equal(isFluentWorkspaceFile("C:/work/BlackRed.code-workspace"), false);
});
