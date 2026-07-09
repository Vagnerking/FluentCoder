/**
 * EF Core (issue #97) — lógica de apresentação das migrations, pura (sem
 * react/monaco) para ser testável. O backend (`efcore.rs`) devolve as
 * migrations do `dotnet ef migrations list --json`; aqui derivamos ordem,
 * estado (aplicada/pendente/desconhecida) e o resumo exibido no RunPanel.
 */

/** Uma migration como devolvida por `efcore_migrations_list`. */
export interface EfMigration {
  /** Id completo, ex.: "20240101000000_Initial" (prefixo = timestamp UTC). */
  id: string;
  name: string;
  safeName: string;
  /** null quando o EF não conseguiu conectar ao banco para saber. */
  applied: boolean | null;
}

/** Estado derivado de uma migration para exibição. */
export type MigrationStatus = "aplicada" | "pendente" | "desconhecida";

/** Estado de exibição: `applied` null ⇒ "desconhecida" (sem conexão ao banco). */
export function migrationStatus(m: EfMigration): MigrationStatus {
  if (m.applied === true) return "aplicada";
  if (m.applied === false) return "pendente";
  return "desconhecida";
}

/**
 * Ordena migrations da mais antiga para a mais recente pelo id (o prefixo
 * numérico é um timestamp UTC, então a ordem lexicográfica é a cronológica).
 * Não muta o array de entrada.
 */
export function sortMigrations(migrations: EfMigration[]): EfMigration[] {
  return [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Quantidade de migrations pendentes (applied === false). */
export function pendingCount(migrations: EfMigration[]): number {
  return migrations.filter((m) => m.applied === false).length;
}

/**
 * Resumo curto para o cabeçalho da seção, ex.: "3 migrations · 1 pendente".
 * Sem migrations ⇒ null (o cabeçalho fica só com o título).
 */
export function migrationsSummary(migrations: EfMigration[]): string | null {
  if (migrations.length === 0) return null;
  const total = `${migrations.length} migration${migrations.length === 1 ? "" : "s"}`;
  const pending = pendingCount(migrations);
  if (pending === 0) return total;
  return `${total} · ${pending} pendente${pending === 1 ? "" : "s"}`;
}

/**
 * Nome de migration válido: identificador C#-like (letra ou `_` inicial, depois
 * alfanumérico/`_`). Espelha a validação do backend para o form desabilitar o
 * botão antes de chamar o CLI.
 */
export function isValidMigrationName(name: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name);
}
