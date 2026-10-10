import { test } from "node:test";
import assert from "node:assert/strict";
import {
  containerOfPosition,
  isLikelyCall,
  parseSupertypes,
  lspKindToVscode,
  TYPE_KINDS,
  CALL_KINDS,
  type RangedSymbol,
} from "./csharpHierarchy.ts";

const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

test("lspKindToVscode maps 1-based LSP to 0-based vscode kinds", () => {
  assert.equal(lspKindToVscode(5), 4); // Class: LSP 5 → vscode 4
  assert.equal(lspKindToVscode(6), 5); // Method: LSP 6 → vscode 5
  assert.equal(lspKindToVscode(11), 10); // Interface
  assert.equal(lspKindToVscode(10), 9); // Enum
});

test("containerOfPosition finds the deepest callable containing a position", () => {
  const symbols: RangedSymbol[] = [
    {
      name: "MyClass",
      kind: 5, // Class
      range: r(0, 0, 20, 1),
      selectionRange: r(0, 6, 0, 13),
      children: [
        { name: "Foo", kind: 6 /* Method */, range: r(2, 4, 6, 5), selectionRange: r(2, 8, 2, 11) },
        { name: "Bar", kind: 6, range: r(8, 4, 14, 5), selectionRange: r(8, 8, 8, 11) },
      ],
    },
  ];
  // Inside Bar.
  assert.equal(containerOfPosition(symbols, { line: 10, character: 8 })?.name, "Bar");
  // Between methods but inside the class → the class.
  assert.equal(containerOfPosition(symbols, { line: 7, character: 0 })?.name, "MyClass");
  // Outside everything.
  assert.equal(containerOfPosition(symbols, { line: 30, character: 0 }), null);
});

test("containerOfPosition with TYPE_KINDS finds the enclosing type from a method body", () => {
  const symbols: RangedSymbol[] = [
    {
      name: "MyClass",
      kind: 5, // Class
      range: r(0, 0, 20, 1),
      selectionRange: r(0, 6, 0, 13),
      children: [{ name: "Foo", kind: 6, range: r(2, 4, 6, 5), selectionRange: r(2, 8, 2, 11) }],
    },
  ];
  // Cursor inside the METHOD Foo, but Type Hierarchy wants the enclosing TYPE.
  assert.equal(
    containerOfPosition(symbols, { line: 4, character: 8 }, TYPE_KINDS)?.name,
    "MyClass"
  );
  // With CALL_KINDS, the same position resolves to the method.
  assert.equal(
    containerOfPosition(symbols, { line: 4, character: 8 }, CALL_KINDS)?.name,
    "Foo"
  );
});

test("isLikelyCall: distinguishes a call from a method group", () => {
  // "Describe()" — the () right after → call.
  assert.equal(isLikelyCall("obj.Describe();", "obj.Describe".length), true);
  // "= Describe;" — no ( → not a call (method group).
  assert.equal(isLikelyCall("var f = Describe;", "var f = Describe".length), false);
  // whitespace before ( still a call.
  assert.equal(isLikelyCall("Foo ()", "Foo".length), true);
});

test("isLikelyCall: generic call Foo<T>() is a call, Foo<T> assignment is not", () => {
  assert.equal(isLikelyCall("Foo<int>()", "Foo".length), true);
  assert.equal(isLikelyCall("var x = a < b;", "var x = a".length), false);
});

test("parseSupertypes: class with base + interfaces", () => {
  assert.deepEqual(
    parseSupertypes("public class Circle : Base, IShape { }"),
    ["Base", "IShape"]
  );
});

test("parseSupertypes: strips generics, namespaces, and where constraints", () => {
  assert.deepEqual(
    parseSupertypes("class Repo<T> : Base.Entity, IList<T> where T : class"),
    ["Entity", "IList"]
  );
});

test("parseSupertypes: no base clause → empty", () => {
  assert.deepEqual(parseSupertypes("public class Standalone { }"), []);
  assert.deepEqual(parseSupertypes("int x = 1;"), []);
});

test("parseSupertypes: record and interface", () => {
  assert.deepEqual(parseSupertypes("public record Pedido : Entidade;"), ["Entidade"]);
  assert.deepEqual(parseSupertypes("interface IDerived : IBase { }"), ["IBase"]);
});
