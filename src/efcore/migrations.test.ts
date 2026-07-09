import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidMigrationName,
  migrationStatus,
  migrationsSummary,
  pendingCount,
  sortMigrations,
  type EfMigration,
} from "./migrations.ts";

function mig(id: string, applied: boolean | null): EfMigration {
  const name = id.split("_").slice(1).join("_") || id;
  return { id, name, safeName: name, applied };
}

test("migrationStatus deriva aplicada/pendente/desconhecida", () => {
  assert.equal(migrationStatus(mig("20240101000000_Initial", true)), "aplicada");
  assert.equal(migrationStatus(mig("20240202000000_AddOrders", false)), "pendente");
  // Sem conexão com o banco o EF omite `applied` ⇒ estado desconhecido.
  assert.equal(migrationStatus(mig("20240303000000_Fix", null)), "desconhecida");
});

test("sortMigrations ordena por id (timestamp) sem mutar a entrada", () => {
  const input = [
    mig("20240303000000_C", null),
    mig("20240101000000_A", true),
    mig("20240202000000_B", false),
  ];
  const sorted = sortMigrations(input);
  assert.deepEqual(
    sorted.map((m) => m.name),
    ["A", "B", "C"]
  );
  // Entrada intacta (a UI reusa o array do estado).
  assert.equal(input[0].name, "C");
});

test("pendingCount conta só applied === false", () => {
  assert.equal(pendingCount([]), 0);
  assert.equal(
    pendingCount([mig("1_a", true), mig("2_b", false), mig("3_c", null), mig("4_d", false)]),
    2
  );
});

test("migrationsSummary formata singular/plural e pendências", () => {
  assert.equal(migrationsSummary([]), null);
  assert.equal(migrationsSummary([mig("1_a", true)]), "1 migration");
  assert.equal(
    migrationsSummary([mig("1_a", true), mig("2_b", true)]),
    "2 migrations"
  );
  assert.equal(
    migrationsSummary([mig("1_a", true), mig("2_b", false)]),
    "2 migrations · 1 pendente"
  );
  assert.equal(
    migrationsSummary([mig("1_a", false), mig("2_b", false)]),
    "2 migrations · 2 pendentes"
  );
});

test("isValidMigrationName espelha a validação do backend", () => {
  assert.ok(isValidMigrationName("AddOrders"));
  assert.ok(isValidMigrationName("_Interna2"));
  assert.ok(!isValidMigrationName(""));
  assert.ok(!isValidMigrationName("2Fast"));
  assert.ok(!isValidMigrationName("Add Orders"));
  assert.ok(!isValidMigrationName("--force"));
  assert.ok(!isValidMigrationName("a;rm"));
});
