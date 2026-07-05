import assert from "node:assert/strict";
import test from "node:test";
import { parseFileRef, resolveWorkspacePath } from "./fileRef.ts";

test("reconhece caminho simples com extensão conhecida", () => {
  assert.deepEqual(parseFileRef("src/App.tsx"), { path: "src/App.tsx" });
});

test("extrai a linha de caminho:linha e caminho:linha:coluna", () => {
  assert.deepEqual(parseFileRef("src/App.tsx:42"), {
    path: "src/App.tsx",
    line: 42,
  });
  assert.deepEqual(parseFileRef("src/App.tsx:42:8"), {
    path: "src/App.tsx",
    line: 42,
  });
});

test("aceita caminho Windows absoluto", () => {
  assert.deepEqual(parseFileRef("C:\\repo\\Program.cs"), {
    path: "C:\\repo\\Program.cs",
  });
});

test("ignora o que não é arquivo", () => {
  // Sem extensão conhecida.
  assert.equal(parseFileRef("StatusRelatorioJuridicoEnum"), null);
  // Chamada de método.
  assert.equal(parseFileRef("cedente.FichaJuridica"), null);
  assert.equal(parseFileRef("Cedente.DeterminarStatus(x)"), null);
  // Texto com espaço.
  assert.equal(parseFileRef("veja o arquivo.ts"), null);
  // Vazio.
  assert.equal(parseFileRef("   "), null);
});

test("resolve caminho relativo à raiz do workspace com o separador nativo", () => {
  assert.equal(
    resolveWorkspacePath("C:\\repo", "src/App.tsx"),
    "C:\\repo\\src\\App.tsx",
  );
  assert.equal(
    resolveWorkspacePath("/home/user/repo", "src/App.tsx"),
    "/home/user/repo/src/App.tsx",
  );
});

test("mantém caminho já absoluto e não exige workspace", () => {
  assert.equal(
    resolveWorkspacePath("C:\\repo", "D:\\outro\\x.ts"),
    "D:\\outro\\x.ts",
  );
  assert.equal(resolveWorkspacePath(null, "src/App.tsx"), "src/App.tsx");
});
