/**
 * Where self-edits happen: the GitHub repo of ky's own code and the address
 * ky answers on, both in this object's SQLite. The user sets the repo in
 * Settings, and the page that sets it gives the address; the main prompt
 * offers self-edits only once both are known.
 */

/** An add-on this deploy has no binding or secret for: Settings shows what it needs, and nothing runs on it. */
export type NotSetUp = { readonly id: string; readonly name: string; readonly needs: string };

export type SetupView = {
  /** ky's GitHub repo, owner/name; null until the user sets it. */
  readonly repo: string | null;
  /** The origin of the page that last set the repo; null until then. */
  readonly url: string | null;
  /** The providers and tools this deploy has no config for. */
  readonly missing: readonly NotSetUp[];
};

/** A repo saved, or why it was not. */
export type RepoSaved = { readonly refused?: string };

/** Where self-edits happen and what they check after a deploy. */
export type SelfEdit = { readonly repo: string; readonly url: string };

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** `seeded`: when the first start seeded ky's starter skills, specialist and automations. */
type Key = "repo" | "url" | "seeded";

export class Setup {
  readonly #sql: SqlStorage;
  readonly #listeners = new Set<() => void>();

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_setup (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  /**
   * Set ky's repo, owner/name, and keep the origin of `page`, the URL of the
   * page that sets it, as ky's address; an empty repo clears it. `refused`
   * says why it was not saved.
   */
  setRepo(repo: string, page: string | null): RepoSaved {
    const value = repo.trim();

    if (value === "") {
      this.#sql.exec("DELETE FROM ky_setup WHERE key = 'repo'");
    } else {
      if (!REPO.test(value)) return { refused: `"${value}" is not a GitHub repo; write it as owner/name.` };

      if (!page) return { refused: "This page's address is unknown; reload it and try again." };

      this.#set("repo", value);
      this.#set("url", new URL(page).origin);
    }

    for (const listener of this.#listeners) listener();

    return {};
  }

  view(): Omit<SetupView, "missing"> {
    return { repo: this.#get("repo") ?? null, url: this.#get("url") ?? null };
  }

  /** The repo and address, once both are known. */
  selfEdit(): SelfEdit | undefined {
    const repo = this.#get("repo");
    const url = this.#get("url");

    return repo && url ? { repo, url } : undefined;
  }

  /** True only the first time it is asked, ever: the first start seeds what a new ky starts with (src/seeds.ts). */
  firstStart(): boolean {
    if (this.#get("seeded") !== undefined) return false;
    this.#set("seeded", String(Date.now()));

    return true;
  }

  #set(key: Key, value: string): void {
    this.#sql.exec(
      "INSERT INTO ky_setup (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    );
  }

  #get(key: Key): string | undefined {
    return this.#sql.exec<{ value: string }>("SELECT value FROM ky_setup WHERE key = ?", key).toArray()[0]?.value;
  }
}
