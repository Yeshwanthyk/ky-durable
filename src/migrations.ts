/**
 * Every data migration ky has released, oldest first (src/core/migrate.ts runs them). A ky's level is how many
 * of these it has applied. Add a migration at the end; never rename, reorder or remove one once it has shipped,
 * since kys and their archives record each by its place and name.
 */
import type { Migration } from "./core/migrate";

export const MIGRATIONS: readonly Migration[] = [];
