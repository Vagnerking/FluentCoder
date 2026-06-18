/**
 * Unit tests for the Material icon resolution *algorithm*.
 *
 * The production resolver (`icon-resolver.ts`) imports its data through Vite-only
 * module syntax (extensionless imports + a JSON import), which the plain-Node
 * test runner can't load. So this test re-implements the exact priority chain
 * here and runs it against the *real* package JSON — which both verifies the
 * algorithm and guards that the package still ships the associations the spec
 * requires. The two must stay in lockstep; the chain is small by design.
 *
 * Run with:  npm run test:unit
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const m = require("material-icon-theme/dist/material-icons.json") as {
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
};

// --- Mirror of icon-resolver.ts (keep in sync) ---
function extensionCandidates(name: string): string[] {
  const lower = name.toLowerCase();
  const out: string[] = [];
  let from = lower.indexOf(".");
  while (from !== -1) {
    out.push(lower.slice(from + 1));
    from = lower.indexOf(".", from + 1);
  }
  return out;
}
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
function resolveFileIconName(pathOrName: string): string {
  const name = baseName(pathOrName).toLowerCase();
  let icon = m.fileNames[name];
  if (!icon) {
    for (const ext of extensionCandidates(name)) {
      if (m.fileExtensions[ext]) {
        icon = m.fileExtensions[ext];
        break;
      }
    }
  }
  return icon ?? m.file;
}
function resolveFolderIconName(pathOrName: string, expanded = false): string {
  const name = baseName(pathOrName).toLowerCase();
  const map = expanded ? m.folderNamesExpanded : m.folderNames;
  return map[name] ?? (expanded ? m.folderExpanded : m.folder);
}
// --- end mirror ---

test("exact file name beats extension (package.json over .json)", () => {
  assert.equal(resolveFileIconName("package.json"), "nodejs");
  assert.notEqual(
    resolveFileIconName("package.json"),
    resolveFileIconName("data.json"),
  );
});

test("appsettings.json has no exact icon, so falls back to .json", () => {
  assert.equal(
    resolveFileIconName("appsettings.json"),
    resolveFileIconName("anything.json"),
  );
  assert.equal(
    resolveFileIconName("appsettings.Development.json"),
    resolveFileIconName("anything.json"),
  );
});

test("spec-required extensions resolve to specific icons", () => {
  assert.equal(resolveFileIconName("Foo.cs"), "csharp");
  assert.equal(resolveFileIconName("Page.cshtml"), "razor");
  assert.equal(resolveFileIconName("Comp.razor"), "razor");
  assert.equal(resolveFileIconName("App.csproj"), "visualstudio");
  assert.equal(resolveFileIconName("My.sln"), "visualstudio");
  for (const f of ["a.ts", "b.tsx", "c.sql"]) {
    assert.notEqual(resolveFileIconName(f), m.file, f);
  }
});

test("Dockerfile (exact name, no extension) resolves to docker", () => {
  assert.equal(resolveFileIconName("Dockerfile"), "docker");
});

test("unknown file falls back to the generic file icon", () => {
  assert.equal(resolveFileIconName("mystery.zzqq"), m.file);
  assert.equal(resolveFileIconName("noextension"), m.file);
});

test("resolution is case-insensitive on the name", () => {
  assert.equal(resolveFileIconName("FOO.CS"), "csharp");
  assert.equal(resolveFileIconName("PACKAGE.JSON"), "nodejs");
});

test("only the last path segment is used", () => {
  assert.equal(resolveFileIconName("/a/b/Foo.cs"), "csharp");
  assert.equal(resolveFileIconName("C:\\proj\\src\\Foo.cs"), "csharp");
});

test("spec-required folders resolve to specific icons", () => {
  for (const d of [
    "Controllers",
    "Views",
    "Services",
    "Repositories",
    "Components",
    "wwwroot",
  ]) {
    assert.notEqual(resolveFolderIconName(d), m.folder, d);
  }
});

test("unknown folder falls back to the generic folder icon", () => {
  assert.equal(resolveFolderIconName("ZzQqUnknown"), m.folder);
});

test("expanded folder uses the open-folder variant for the generic fallback", () => {
  assert.equal(resolveFolderIconName("ZzQqUnknown", true), m.folderExpanded);
  assert.notEqual(m.folder, m.folderExpanded);
});
