import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRemoteAttach,
  encodeRemoteAttach,
  shouldOpenRemoteInNewWindow,
  type RemoteAttach,
} from "./window.ts";

test("a new SSH connection reuses an empty workbench", () => {
  assert.equal(shouldOpenRemoteInNewWindow(null, true), false);
});

test("a new SSH connection opens a window when a project is loaded", () => {
  assert.equal(shouldOpenRemoteInNewWindow("C:\\workspace", true), true);
  assert.equal(shouldOpenRemoteInNewWindow("/home/user/project", true), true);
});

test("changing folders in the current remote connection stays in place", () => {
  assert.equal(shouldOpenRemoteInNewWindow("/home/user/old", false), false);
});

test("remote attach payload round-trips Unicode through URL-safe base64", () => {
  const attach: RemoteAttach = {
    connId: "ssh-1",
    host: "máquina.local",
    user: "josé",
    rootPath: "/home/josé/projeto ação",
  };
  const encoded = encodeRemoteAttach(attach);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeRemoteAttach(encoded), attach);
});
