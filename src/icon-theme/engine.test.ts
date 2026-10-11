import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { decodeFontCharacter, extensionCandidates, normalizeIconTheme, resolveFileIcon, resolveFolderIcon } from "./engine.ts";

const require = createRequire(import.meta.url);
const material = normalizeIconTheme(require("material-icon-theme/dist/material-icons.json"));

const doc = normalizeIconTheme({
  iconDefinitions: Object.fromEntries(
    ["file", "folder", "folderOpen", "root", "rootOpen", "ts", "dts", "pkg", "pkgLight", "py", "src", "srcOpen", "docs", "glyph", "rootDocs"].map((k) => [k, { iconPath: `./icons/${k}.svg` }]),
  ),
  file: "file",
  folder: "folder",
  folderExpanded: "folderOpen",
  rootFolder: "root",
  rootFolderExpanded: "rootOpen",
  fileExtensions: { ts: "ts", "D.TS": "dts" },
  fileNames: { "Package.JSON": "pkg" },
  languageIds: { python: "py", shellscript: "glyph" },
  folderNames: { src: "src", docs: "docs" },
  folderNamesExpanded: { src: "srcOpen" },
  rootFolderNames: { docs: "rootDocs" },
  light: { fileNames: { "package.json": "pkgLight" } },
  highContrast: { file: "missing-def" },
});

test("ordem de resolução de arquivo: nome exato → extensão (mais longa) → linguagem → padrão", () => {
  assert.equal(resolveFileIcon(doc, "/a/b/package.json"), "pkg", "fileNames é minúsculo");
  assert.equal(resolveFileIcon(doc, "PACKAGE.JSON"), "pkg");
  assert.equal(resolveFileIcon(doc, "x.d.ts"), "dts", "extensão composta antes da simples");
  assert.equal(resolveFileIcon(doc, "x.ts"), "ts");
  assert.equal(resolveFileIcon(doc, "script", { languageId: "python" }), "py", "languageIds");
  assert.equal(resolveFileIcon(doc, "run.sh", { languageId: "shell" }), "glyph", "alias shell → shellscript");
  assert.equal(resolveFileIcon(doc, "x.ts", { languageId: "python" }), "ts", "extensão vence linguagem");
  assert.equal(resolveFileIcon(doc, "nada.zz"), "file");
  assert.deepEqual(extensionCandidates("a.b.c"), ["b.c", "c"]);
});

test("variantes clara/alto contraste sobrescrevem chave a chave", () => {
  assert.equal(resolveFileIcon(doc, "package.json", { variant: "light" }), "pkgLight");
  assert.equal(resolveFileIcon(doc, "x.ts", { variant: "light" }), "ts", "sem sobrescrita: base");
  assert.equal(resolveFileIcon(doc, "nada.zz", { variant: "highContrast" }), "file", "id inexistente cai no base");
});

test("pastas: aberta, nomeada, raiz do workspace", () => {
  assert.equal(resolveFolderIcon(doc, "/p/src"), "src");
  assert.equal(resolveFolderIcon(doc, "/p/src", { expanded: true }), "srcOpen");
  assert.equal(resolveFolderIcon(doc, "/p/docs", { expanded: true }), "docs", "sem folderNamesExpanded usa folderNames");
  assert.equal(resolveFolderIcon(doc, "/p/zz"), "folder");
  assert.equal(resolveFolderIcon(doc, "/p/zz", { expanded: true }), "folderOpen");
  assert.equal(resolveFolderIcon(doc, "/p/app", { root: true }), "root");
  assert.equal(resolveFolderIcon(doc, "/p/app", { root: true, expanded: true }), "rootOpen");
  assert.equal(resolveFolderIcon(doc, "/p/docs", { root: true }), "rootDocs");
});

test("Material embutido como provedor do motor genérico", () => {
  assert.equal(resolveFileIcon(material, "Foo.cs"), "csharp");
  assert.equal(resolveFileIcon(material, "package.json"), "nodejs");
  assert.equal(resolveFileIcon(material, "Page.cshtml"), "razor");
  assert.equal(resolveFileIcon(material, "Dockerfile"), "docker");
  assert.equal(resolveFileIcon(material, "mystery.zzqq"), "file");
  assert.equal(resolveFolderIcon(material, "ZzQq"), "folder");
  assert.equal(resolveFolderIcon(material, "ZzQq", { expanded: true }), "folder-open");
  assert.equal(resolveFolderIcon(material, "app", { root: true }), "folder-root");
  assert.notEqual(resolveFolderIcon(material, "Controllers"), "folder");
});

test("normalização: só strings, defs sem caminho/glifo descartadas, fontCharacter seguro", () => {
  const d = normalizeIconTheme({ iconDefinitions: { a: { iconPath: 1 }, b: { fontCharacter: "\\E001", fontColor: "#fff" } }, fileNames: { x: 3, y: "b" } });
  assert.deepEqual(Object.keys(d.iconDefinitions), ["b"]);
  assert.deepEqual(d.fileNames, { y: "b" });
  assert.equal(decodeFontCharacter("\\E001"), "");
  assert.equal(decodeFontCharacter("x"), "x");
  assert.equal(decodeFontCharacter("\\'; } body{"), null);
  assert.throws(() => normalizeIconTheme(null));
});
