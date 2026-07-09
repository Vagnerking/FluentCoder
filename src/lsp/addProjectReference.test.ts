import { test } from "node:test";
import assert from "node:assert/strict";
import {
  typeNameFromMissingTypeMessage,
  csprojDisplayName,
  isMissingTypeDiagnostic,
  owningCsproj,
  MISSING_TYPE_CODE,
} from "./addProjectReference.ts";

test("extracts the type name from English and pt-BR CS0246 messages", () => {
  assert.equal(
    typeNameFromMissingTypeMessage(
      "The type or namespace name 'RepositorioSql' could not be found (are you missing a using directive or an assembly reference?)"
    ),
    "RepositorioSql"
  );
  assert.equal(
    typeNameFromMissingTypeMessage(
      'O nome do tipo ou do namespace "Cliente" não pode ser encontrado (está faltando uma diretiva using ou uma referência de assembly?)'
    ),
    "Cliente"
  );
});

test("returns null when no quoted identifier is present", () => {
  assert.equal(typeNameFromMissingTypeMessage("algo sem aspas"), null);
  // Quoted but not a valid identifier.
  assert.equal(typeNameFromMissingTypeMessage("'123abc'"), null);
});

test("csprojDisplayName strips path and extension", () => {
  assert.equal(csprojDisplayName("/repo/src/Infra/Infra.csproj"), "Infra");
  assert.equal(csprojDisplayName("C:\\repo\\App\\App.csproj"), "App");
});

test("isMissingTypeDiagnostic accepts string and {value} code shapes", () => {
  assert.ok(isMissingTypeDiagnostic(MISSING_TYPE_CODE));
  assert.ok(isMissingTypeDiagnostic({ value: "CS0246" }));
  assert.ok(!isMissingTypeDiagnostic("CS0103"));
  assert.ok(!isMissingTypeDiagnostic({ value: "CS1061" }));
  assert.ok(!isMissingTypeDiagnostic(undefined));
});

test("owningCsproj picks the nearest ancestor project", () => {
  const csprojs = ["/repo/App.csproj", "/repo/src/Api/Api.csproj"];
  assert.equal(
    owningCsproj("/repo/src/Api/Controllers/Home.cs", csprojs),
    "/repo/src/Api/Api.csproj"
  );
  assert.equal(owningCsproj("/repo/Program.cs", csprojs), "/repo/App.csproj");
  assert.equal(owningCsproj("/other/Foo.cs", csprojs), null);
  // Windows backslashes normalize.
  assert.equal(
    owningCsproj("C:\\repo\\src\\Api\\X.cs", ["C:\\repo\\src\\Api\\Api.csproj"]),
    "C:\\repo\\src\\Api\\Api.csproj"
  );
});
