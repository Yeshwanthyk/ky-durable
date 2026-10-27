import Type from "typebox";
import { parseOr } from "./core/decode";
import { CLOUD, isMachineName } from "./machines/contract";

/**
 * Sandboxes: ky's own Linux machines in Cloudflare, one container each, such as one per project.
 * Each is a row here and a CloudMachine Durable Object named by its id; the machine hub lists it
 * under its name, like a computer, from the first wake on.
 *
 * - The id never changes, so the Durable Object, and the R2 key of its saved disk, stay put.
 *   Today's cloud machine is the sandbox `cloud`, whose save keeps its old key.
 * - `repos` are its projects (owner/name): a task for one of them goes to it, and the GitHub
 *   handler lets it reach only those (`reposFor`). None means every repo picked in Settings, as the
 *   cloud machine had before, but it then owns none for routing. A repo belongs to at most one.
 * - One may be the default: a task that names no machine and no repo of another goes there.
 * - Deleting one keeps its saved disk: the row stays with `deleted_at` set, as a kept disk, until
 *   the user deletes that too. A new sandbox started from a kept disk takes its id back, so its
 *   first wake restores that save.
 */

/** How many sandboxes may be live at once; the deployer lets one more container run, for a sleep that overlaps a wake. */
export const SANDBOX_CAP = 8;

/** The R2 key of a sandbox's saved disk, in FILES; `cloud` keeps the key it had before there were others. */
export function saveKey(id: string): string {
  return id === CLOUD ? "cloud-machine/save.tar.gz" : `cloud-machine/${id}/save.tar.gz`;
}

export type Sandbox = {
  readonly id: string;
  readonly name: string;
  /** Its projects, owner/name, lowercase. */
  readonly repos: readonly string[];
  /** How long it stays up idle; the deploy's KY_CLOUD_IDLE_MINUTES when null. */
  readonly idleMinutes: number | null;
  readonly isDefault: boolean;
  readonly createdAt: number;
  /** When it was deleted, which makes it a kept disk; null while it is live. */
  readonly deletedAt: number | null;
};

/** A new sandbox: its name, its repos, and the kept disk it starts from, if any. */
export type SandboxDraft = { readonly name: string; readonly repos?: readonly string[]; readonly from?: string };

/** What the user changes about a live sandbox. */
export type SandboxChange = { readonly repos?: readonly string[]; readonly idleMinutes?: number | null; readonly isDefault?: true };

type Row = { id: string; name: string; repos: string; idle_minutes: number | null; is_default: number; created_at: number; deleted_at: number | null };

const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

/** The most idle minutes a sandbox may have: a day. */
const IDLE_MAX = 24 * 60;

/** The `repos` column: JSON, the repos a sandbox clones. */
const Repos = Type.Array(Type.String());

function sandboxOf(row: Row): Sandbox {
  return {
    id: row.id,
    name: row.name,
    // A cell a restore damaged reads as no repos.
    repos: parseOr(Repos, row.repos, []),
    idleMinutes: row.idle_minutes,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    deletedAt: row.deleted_at
  };
}

/** Repos as kept: trimmed, lowercase, each once; throws for one that isn't owner/name. */
function cleanRepos(repos: readonly string[]): string[] {
  const clean = [...new Set(repos.map((repo) => repo.trim().toLowerCase()))];
  const bad = clean.find((repo) => !REPO.test(repo));

  if (bad !== undefined) throw new Error(`A repo is owner/name, not ${JSON.stringify(bad)}.`);

  return clean;
}

const newId = () => `sb-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

export class Sandboxes {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_sandboxes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repos TEXT NOT NULL DEFAULT '[]',
      idle_minutes INTEGER,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER)`);
    // A name is one live sandbox's; a kept disk keeps the name it had, which a new sandbox may take.
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS ky_sandboxes_live_name ON ky_sandboxes (name) WHERE deleted_at IS NULL");
    // When the cloud machine became a sandbox: once, so deleting every sandbox doesn't bring it back.
    sql.exec("CREATE TABLE IF NOT EXISTS ky_sandboxes_seeded (at INTEGER NOT NULL)");
  }

  /**
   * On a deploy with containers, today's cloud machine becomes the first sandbox, the default: once,
   * and only into an empty registry; a deploy that had sandboxes keeps what it has.
   */
  migrate(): void {
    if (this.#sql.exec("SELECT 1 FROM ky_sandboxes_seeded").toArray().length > 0) return;
    this.#sql.exec(
      "INSERT INTO ky_sandboxes (id, name, is_default, created_at) SELECT ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM ky_sandboxes)",
      CLOUD,
      CLOUD,
      Date.now()
    );
    this.seeded();
  }

  /** Mark the registry seeded, as a restore does: its sandboxes are the backup's, and no more. */
  seeded(): void {
    this.#sql.exec("DELETE FROM ky_sandboxes_seeded");
    this.#sql.exec("INSERT INTO ky_sandboxes_seeded (at) VALUES (?)", Date.now());
  }

  /** Every sandbox, live or kept. */
  all(): Sandbox[] {
    return this.#rows("1 = 1 ORDER BY created_at");
  }

  /**
   * Keep `lost`, which a restore replaced, as kept disks: their containers and saves are this
   * deploy's, so they stay until the user deletes them, or start again from them.
   */
  keep(lost: readonly Sandbox[]): void {
    for (const sandbox of lost) {
      this.#sql.exec(
        "INSERT OR IGNORE INTO ky_sandboxes (id, name, repos, idle_minutes, is_default, created_at, deleted_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
        sandbox.id,
        sandbox.name,
        JSON.stringify(sandbox.repos),
        sandbox.idleMinutes,
        sandbox.createdAt,
        sandbox.deletedAt ?? Date.now()
      );
    }
  }

  #rows(where: string, ...bindings: SqlStorageValue[]): Sandbox[] {
    return this.#sql.exec<Row>(`SELECT * FROM ky_sandboxes WHERE ${where}`, ...bindings).toArray().map(sandboxOf);
  }

  /** The live sandboxes, the default first, then by name. */
  live(): Sandbox[] {
    return this.#rows("deleted_at IS NULL ORDER BY is_default DESC, name");
  }

  /** The kept disks, the last deleted first. */
  kept(): Sandbox[] {
    return this.#rows("deleted_at IS NOT NULL ORDER BY deleted_at DESC");
  }

  /** A sandbox, live or kept. */
  get(id: string): Sandbox | undefined {
    return this.#rows("id = ?", id)[0];
  }

  /** The live sandbox named `name`. */
  named(name: string): Sandbox | undefined {
    return this.#rows("deleted_at IS NULL AND name = ?", name)[0];
  }

  /** The live sandbox that owns `repo`. */
  owner(repo: string): Sandbox | undefined {
    const wanted = repo.trim().toLowerCase();

    return this.live().find((sandbox) => sandbox.repos.includes(wanted));
  }

  /**
   * The repos the sandbox `id` may reach on GitHub: its own, or every picked one when it has none
   * (`all`); none when it is deleted or unknown. The GitHub handler asks this on each request.
   */
  reposFor(id: string): readonly string[] | "all" | null {
    const sandbox = this.get(id);

    if (!sandbox || sandbox.deletedAt !== null) return null;

    return sandbox.repos.length === 0 ? "all" : sandbox.repos;
  }

  /** Throw unless `repos` are free of every live sandbox but `id`. */
  #checkOwners(repos: readonly string[], id?: string): void {
    for (const repo of repos) {
      const owner = this.owner(repo);

      if (owner && owner.id !== id) throw new Error(`${repo} is already ${owner.name}'s; a repo belongs to one sandbox.`);
    }
  }

  /**
   * A new live sandbox, fresh or from a kept disk. Throws past the cap, for a name that isn't a
   * machine's or is `taken` (a computer's, or a live sandbox's), or for a repo another sandbox owns.
   * The first live one is the default.
   */
  create(draft: SandboxDraft, taken: (name: string) => boolean): Sandbox {
    const name = draft.name.trim();

    if (!isMachineName(name)) throw new Error("A name is lowercase letters, digits and dashes, up to 32.");

    if (taken(name) || this.named(name)) throw new Error(`${name} is taken; pick another name.`);

    if (this.live().length >= SANDBOX_CAP) throw new Error(`ky runs at most ${SANDBOX_CAP} sandboxes; delete one first.`);
    const repos = cleanRepos(draft.repos ?? []);

    this.#checkOwners(repos);
    const first = this.live().length === 0 ? 1 : 0;

    if (draft.from !== undefined) {
      const kept = this.get(draft.from);

      if (!kept || kept.deletedAt === null) throw new Error(`No kept disk ${draft.from}.`);
      this.#sql.exec(
        "UPDATE ky_sandboxes SET name = ?, repos = ?, is_default = ?, created_at = ?, deleted_at = NULL WHERE id = ?",
        name,
        JSON.stringify(repos),
        first,
        Date.now(),
        kept.id
      );

      return this.get(kept.id)!;
    }

    const id = newId();

    this.#sql.exec(
      "INSERT INTO ky_sandboxes (id, name, repos, is_default, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      name,
      JSON.stringify(repos),
      first,
      Date.now()
    );

    return this.get(id)!;
  }

  /** Change a live sandbox's repos, idle minutes, or make it the default. */
  change(id: string, change: SandboxChange): Sandbox {
    const sandbox = this.get(id);

    if (!sandbox || sandbox.deletedAt !== null) throw new Error(`No sandbox ${id}.`);

    if (change.repos !== undefined) {
      const repos = cleanRepos(change.repos);

      this.#checkOwners(repos, id);
      this.#sql.exec("UPDATE ky_sandboxes SET repos = ? WHERE id = ?", JSON.stringify(repos), id);
    }

    if (change.idleMinutes !== undefined) {
      const minutes = change.idleMinutes;

      if (minutes !== null && !(Number.isInteger(minutes) && minutes > 0 && minutes <= IDLE_MAX)) {
        throw new Error(`Idle minutes are a whole number from 1 to ${IDLE_MAX}.`);
      }

      this.#sql.exec("UPDATE ky_sandboxes SET idle_minutes = ? WHERE id = ?", minutes, id);
    }

    if (change.isDefault) this.#sql.exec("UPDATE ky_sandboxes SET is_default = (id = ?)", id);

    return this.get(id)!;
  }

  /** Delete a live sandbox, keeping its row as a kept disk; it stops being the default. */
  delete(id: string): Sandbox {
    const sandbox = this.get(id);

    if (!sandbox || sandbox.deletedAt !== null) throw new Error(`No sandbox ${id}.`);
    this.#sql.exec("UPDATE ky_sandboxes SET deleted_at = ?, is_default = 0 WHERE id = ?", Date.now(), id);

    return this.get(id)!;
  }

  /** Forget a kept disk's row; the caller deletes its save. */
  forget(id: string): Sandbox {
    const kept = this.get(id);

    if (!kept || kept.deletedAt === null) throw new Error(`No kept disk ${id}.`);
    this.#sql.exec("DELETE FROM ky_sandboxes WHERE id = ?", id);

    return kept;
  }
}
