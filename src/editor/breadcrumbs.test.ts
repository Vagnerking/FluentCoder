import assert from "node:assert/strict";
import test from "node:test";
import {
  breadcrumbPathBudget,
  collapseCrumbs,
  isVirtualPath,
  parentPath,
  pathCrumbs,
  rootForPath,
  sortDirEntries,
  symbolPathAt,
  symbolSiblings,
  type BreadcrumbRoot,
  type SymbolNode,
} from "./breadcrumbs.ts";

const names = (c: { name: string }[]) => c.map((x) => x.name);

test("arquivo na raiz mostra `workspace › arquivo` (nunca só o nome da aba)", () => {
  const roots: BreadcrumbRoot[] = [{ id: "r", name: "FluentCoder", path: "/home/u/FluentCoder" }];
  const c = pathCrumbs("/home/u/FluentCoder/AGENTS.md", roots);
  assert.deepEqual(names(c), ["FluentCoder", "AGENTS.md"]);
  assert.deepEqual(c.map((x) => x.kind), ["root", "file"]);
});

test("pastas intermediárias carregam o caminho absoluto de cada nível", () => {
  const roots: BreadcrumbRoot[] = [{ id: "r", name: "app", path: "/repo/" }];
  const c = pathCrumbs("/repo/src/components/EditorPane.tsx", roots);
  assert.deepEqual(names(c), ["app", "src", "components", "EditorPane.tsx"]);
  assert.deepEqual(c.map((x) => x.path), [
    "/repo/",
    "/repo/src",
    "/repo/src/components",
    "/repo/src/components/EditorPane.tsx",
  ]);
});

test("multi-root: a raiz mais específica vence (pasta aninhada)", () => {
  const roots: BreadcrumbRoot[] = [
    { id: "app", name: "FluentCoder", path: "/repo" },
    { id: "docs", name: "docs", path: "/repo/docs" },
  ];
  assert.equal(rootForPath("/repo/docs/a.md", roots)?.id, "docs");
  assert.deepEqual(names(pathCrumbs("/repo/docs/context/editor.md", roots)), ["docs", "context", "editor.md"]);
  assert.deepEqual(names(pathCrumbs("/repo/src/a.ts", roots)), ["FluentCoder", "src", "a.ts"]);
});

test("multi-root: preferRootId desambigua raízes iguais (local vs SSH com o mesmo caminho)", () => {
  const roots: BreadcrumbRoot[] = [
    { id: "local", name: "app", path: "/srv/app" },
    { id: "ssh", name: "servidor", path: "/srv/app", connId: "c1" },
  ];
  assert.equal(pathCrumbs("/srv/app/main.go", roots, { preferRootId: "ssh" })[0].name, "servidor");
  assert.equal(pathCrumbs("/srv/app/main.go", roots)[0].name, "app");
});

test("Windows: barra invertida, drive com caixa diferente e separador nativo preservado", () => {
  const roots: BreadcrumbRoot[] = [{ id: "w", name: "Proj", path: "C:\\Users\\Me\\Proj" }];
  const c = pathCrumbs("c:\\Users\\Me\\Proj\\src\\App.cs", roots);
  assert.deepEqual(names(c), ["Proj", "src", "App.cs"]);
  assert.equal(c[1].path, "C:\\Users\\Me\\Proj\\src");
  // "Proj2" não é filho de "Proj".
  assert.equal(rootForPath("C:\\Users\\Me\\Proj2\\a.cs", roots), null);
});

test("fora de qualquer raiz: caminho absoluto (POSIX e Windows)", () => {
  assert.deepEqual(names(pathCrumbs("/etc/hosts", [])), ["etc", "hosts"]);
  assert.equal(pathCrumbs("/etc/hosts", [])[0].path, "/etc");
  const w = pathCrumbs("D:\\tmp\\x.txt", []);
  assert.deepEqual(names(w), ["D:", "tmp", "x.txt"]);
  assert.equal(w[0].path, "D:\\");
  assert.equal(w[1].path, "D:\\tmp");
});

test("caminhos virtuais (Git/untitled) só mostram o nome", () => {
  assert.equal(isVirtualPath("fluentcoder://git-diff/a.ts"), true);
  assert.equal(isVirtualPath("untitled:Untitled-1"), true);
  assert.equal(isVirtualPath("C:\\a.ts"), false);
  assert.deepEqual(names(pathCrumbs("untitled:Untitled-1", [], { fileName: "Untitled-1" })), ["Untitled-1"]);
});

test("caminhos longos colapsam o meio em …", () => {
  const items = ["root", "a", "b", "c", "d", "file"];
  const out = collapseCrumbs(items, 4);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { kind: "crumb", crumb: "root", index: 0 });
  assert.deepEqual(out[1], { kind: "ellipsis", hidden: ["a", "b", "c"] });
  assert.deepEqual(out.slice(2).map((x) => (x.kind === "crumb" ? x.index : -1)), [4, 5]);
  assert.equal(collapseCrumbs(items, 10).length, 6);
});

const sym = (name: string, s: number, e: number, children?: SymbolNode[]): SymbolNode => ({
  name,
  kind: 4,
  range: { startLineNumber: s, startColumn: 1, endLineNumber: e, endColumn: 2 },
  selectionRange: { startLineNumber: s, startColumn: 1, endLineNumber: s, endColumn: 2 },
  children,
});

test("símbolo sob o cursor: cadeia externo → interno", () => {
  const tree = [
    sym("EditorPane", 10, 100, [sym("loadBlame", 20, 40), sym("render", 50, 90)]),
    sym("helper", 110, 120),
  ];
  assert.deepEqual(names(symbolPathAt(tree, 25, 3)), ["EditorPane", "loadBlame"]);
  assert.deepEqual(names(symbolPathAt(tree, 45, 1)), ["EditorPane"]);
  assert.deepEqual(names(symbolPathAt(tree, 105, 1)), []);
  const chain = symbolPathAt(tree, 25, 3);
  assert.deepEqual(names([...symbolSiblings(tree, chain, 1)]), ["loadBlame", "render"]);
  assert.deepEqual(names([...symbolSiblings(tree, chain, 0)]), ["EditorPane", "helper"]);
});

test("pasta pai e ordenação de entradas", () => {
  assert.equal(parentPath("/repo/src/a.ts"), "/repo/src");
  assert.equal(parentPath("/repo"), "/");
  assert.equal(parentPath("C:\\a\\b.txt"), "C:\\a");
  assert.equal(parentPath("C:\\a"), "C:\\");
  const sorted = sortDirEntries([
    { name: "b.ts", isDir: false },
    { name: "src", isDir: true },
    { name: "A.md", isDir: false },
  ]);
  assert.deepEqual(names(sorted), ["src", "A.md", "b.ts"]);
});

test("orçamento de segmentos segue a largura (grupo estreito colapsa o meio)", () => {
  assert.equal(breadcrumbPathBudget(0, 0, 5), 5);
  assert.equal(breadcrumbPathBudget(170, 0, 5), 3);
  assert.equal(breadcrumbPathBudget(330, 0, 5), 4);
  assert.equal(breadcrumbPathBudget(900, 0, 5), 5);
  // Símbolos ocupam parte do espaço.
  assert.equal(breadcrumbPathBudget(400, 2, 5), 3);
  // Nunca abaixo de raiz › … › arquivo.
  assert.equal(breadcrumbPathBudget(40, 3, 5), 3);
  const path = collapseCrumbs(["root", "src", "git", "gitFluent.ts"], breadcrumbPathBudget(170, 0, 5));
  assert.deepEqual(path.map((d) => (d.kind === "ellipsis" ? "…" : d.crumb)), ["root", "…", "gitFluent.ts"]);
});
