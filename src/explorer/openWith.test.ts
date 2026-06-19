import assert from "node:assert/strict";
import test from "node:test";
import {
  applicableModes,
  defaultModeFor,
  extensionOf,
  isImagePath,
} from "./openWith.ts";

test("extensionOf lowercases and handles both separators", () => {
  assert.equal(extensionOf("C:\\img\\Photo.PNG"), "png");
  assert.equal(extensionOf("/home/a/b/file.TS"), "ts");
  assert.equal(extensionOf("Makefile"), "");
});

test("isImagePath recognizes common image types only", () => {
  assert.equal(isImagePath("a/logo.svg"), true);
  assert.equal(isImagePath("a/photo.jpeg"), true);
  assert.equal(isImagePath("a/main.rs"), false);
});

test("an image offers both Text and Image modes; default is Image", () => {
  const modes = applicableModes("a/icon.png").map((m) => m.mode);
  assert.deepEqual(modes, ["text", "image"]);
  assert.equal(defaultModeFor("a/icon.png"), "image");
});

test("a text file offers only the Text editor; default is Text", () => {
  const modes = applicableModes("a/index.ts").map((m) => m.mode);
  assert.deepEqual(modes, ["text"]);
  assert.equal(defaultModeFor("a/index.ts"), "text");
});
