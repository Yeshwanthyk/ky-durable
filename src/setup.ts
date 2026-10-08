/**
 * What this deploy knows about itself that is not config: the address it
 * answers on, and the GitHub repo of ky's own code. Both live in this
 * object's SQLite. The address is the origin of the first page that
 * connects; the user sets the repo in Settings, and the main prompt offers
 * self-edits only once it is set.
 *
 * It also lists the add-ons this deploy has no binding or secret for, so
 * Settings can show them as not set up.
 */

/** An add-on this deploy has no binding or secret for: Settings shows what it needs, and nothing runs on it. */
export type NotSetUp = { readonly id: string; readonly name: string; readonly needs: string };

export type SetupView = {
  /** ky's GitHub repo, owner/name; null until the user sets it. */
  readonly repo: string | null;
  /** Tools this deploy has no binding or secret for. Providers that are not set up are in the settings' catalog. */
  readonly missing: readonly NotSetUp[];
};

/** Where self-edits happen and what they check after a deploy. */
export type SelfEdit = { readonly repo: string; readonly url: string };

const REPO = /^[\w.-]+\/[\w.-]+$/;

export class Setup {
  readonly #sql: SqlStorage;
  readonly #missing: readonly NotSetUp[];
  readonly #listeners = new Set<() => void>();

  constructor(sql: SqlStorage, missing: readonly NotSetUp[]) {
    this.#sql = sql;
    this.#missing = missing;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_setup (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  /** Keep a page's origin as ky's address, unless one is already kept. */
  seen(origin: string): void {
    this.#sql.exec("INSERT INTO ky_setup (key, value) VALUES ('url', ?) ON CONFLICT(key) DO NOTHING", origin);
  }

  /** Set ky's repo, owner/name; an empty one clears it. */
  setRepo(repo: string): void {
    const value = repo.trim();

    if (value === "") {
      this.#sql.exec("DELETE FROM ky_setup WHERE key = 'repo'");
    } else {
      if (!REPO.test(value)) throw new Error(`"${value}" is not a GitHub repo; write it as owner/name.`);
      this.#sql.exec(
        "INSERT INTO ky_setup (key, value) VALUES ('repo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        value
      );
    }

    for (const listener of this.#listeners) listener();
  }

  view(): SetupView {
    return { repo: this.#get("repo") ?? null, missing: this.#missing };
  }

  /** The repo and address, once both are known. */
  selfEdit(): SelfEdit | undefined {
    const repo = this.#get("repo");
    const url = this.#get("url");

    return repo && url ? { repo, url } : undefined;
  }

  #get(key: "repo" | "url"): string | undefined {
    return this.#sql.exec<{ value: string }>("SELECT value FROM ky_setup WHERE key = ?", key).toArray()[0]?.value;
  }
}
