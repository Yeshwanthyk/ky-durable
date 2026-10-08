import { DurableObject } from "cloudflare:workers";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { RunCreds } from "./runner-protocol";

/**
 * The Vault: every secret ky keeps, in a Durable Object of its own,
 * `env.Vault.getByName("owner")`, apart from the agent's storage.
 *
 * - Secrets are JSON values by kind and id: an API key for a provider, the
 *   Claude and ChatGPT subscriptions, GitHub, Executor. `status` lists them
 *   without their values.
 * - Tokens are what ky hands out: pairing codes, machine tokens, task tokens.
 *   `mint` returns the raw token once and keeps only its sha-256; a subject
 *   has one live token per kind, so minting again replaces it. `issue` gives
 *   a task its live token again, for every run of it the runner is sent.
 *
 * Settings doesn't call the secrets yet, and fallow doesn't count the tests'
 * calls through a stub, so fallow/dead-code.json lists those members.
 */

type SecretKind = "provider" | "claude" | "chatgpt" | "github" | "executor";

type TokenKind = "pair" | "machine" | "task";

/** The kinds `issue` can give out again: a task's runs all carry its one token. */
type ReissuedKind = "task";

/** What Settings may show about a secret, like its label, account or repos. Flat, so it crosses RPC typed. */
type SecretMeta = { readonly [field: string]: string | number | boolean | null | readonly string[] };

/** A secret as Settings may show it: never its value. */
type SecretStatus = {
  readonly kind: SecretKind;
  readonly id: string;
  readonly meta: SecretMeta | null;
  readonly updatedAt: number;
  /** Why the last refresh failed, until the secret is next written. */
  readonly error?: string;
};

/** A secret's JSON text, and the write that stored it. */
type Stored = { readonly value: string; readonly generation: number };

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export class Vault extends DurableObject<Env> {
  readonly #sql = this.ctx.storage.sql;
  /** The refresh running from each stored generation of a secret, which callers that arrive meanwhile share. */
  readonly #refreshing = new Map<string, Promise<JsonValue | null>>();
  /** The `issue` running for each subject, which callers that arrive meanwhile share. */
  readonly #issuing = new Map<string, Promise<string>>();
  /** The HMAC key reissued tokens are derived with, once read or made. */
  #key: Promise<CryptoKey> | undefined;
  /** The clock for updated_at and token expiry; tests move it. */
  now = (): number => Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Every write is a new row, so a new generation; AUTOINCREMENT never hands one out twice, even after a remove.
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS ky_vault_secrets (
      generation INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL,
      meta TEXT,
      updated_at INTEGER NOT NULL,
      error TEXT,
      UNIQUE (kind, id))`);
    // `nonce`: what an issued token is derived from, so `issue` can give it again; null for a minted one.
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS ky_vault_tokens (
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER,
      nonce TEXT,
      PRIMARY KEY (kind, subject))`);
    const columns = this.#sql.exec<{ name: string }>("PRAGMA table_info(ky_vault_tokens)").toArray();

    if (!columns.some((column) => column.name === "nonce")) this.#sql.exec("ALTER TABLE ky_vault_tokens ADD COLUMN nonce TEXT");
    this.#sql.exec("CREATE TABLE IF NOT EXISTS ky_vault_keys (name TEXT PRIMARY KEY, key TEXT NOT NULL)");
  }

  put(kind: SecretKind, id: string, value: JsonValue, meta?: SecretMeta): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO ky_vault_secrets (kind, id, value, meta, updated_at) VALUES (?, ?, ?, ?, ?)",
      kind,
      id,
      JSON.stringify(value),
      meta === undefined ? null : JSON.stringify(meta),
      this.now()
    );
  }

  remove(kind: SecretKind, id: string): void {
    this.#sql.exec("DELETE FROM ky_vault_secrets WHERE kind = ? AND id = ?", kind, id);
  }

  status(): SecretStatus[] {
    const rows = this.#sql
      .exec<{ kind: SecretKind; id: string; meta: string | null; updated_at: number; error: string | null }>(
        "SELECT kind, id, meta, updated_at, error FROM ky_vault_secrets ORDER BY kind, id"
      )
      .toArray();

    return rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      meta: row.meta === null ? null : JSON.parse(row.meta),
      updatedAt: row.updated_at,
      error: row.error ?? undefined
    }));
  }

  /**
   * Replace a secret with what `fn` makes of it, the way Scotty's CredsObject
   * refreshes OAuth tokens. Inside the Vault only, for sessionCreds: a function
   * argument can't cross the typed RPC stub.
   *
   * Callers that arrive while a refresh of the same stored generation runs
   * share it. The write lands only over the generation `fn` was given; when a
   * put or remove got there first, the refresh answers with what is stored
   * now, or null, whether `fn` succeeded or failed. A missing secret is null
   * and runs nothing.
   *
   * When `fn` fails on an unchanged secret, its message is stored verbatim as
   * the secret's error, which Settings shows, and the refresh throws. So `fn`
   * must throw messages that hold no secret.
   *
   * The caller decides when a refresh is due; this always runs `fn` unless one
   * is already running.
   */
  refresh(kind: SecretKind, id: string, fn: (value: JsonValue) => Promise<JsonValue>): Promise<JsonValue | null> {
    const stored = this.#stored(kind, id);

    if (!stored) return Promise.resolve(null);
    const key = JSON.stringify([kind, id, stored.generation]);
    const running = this.#refreshing.get(key);

    if (running) return running;
    const refresh = this.#refresh(kind, id, stored, fn).finally(() => this.#refreshing.delete(key));
    this.#refreshing.set(key, refresh);

    return refresh;
  }

  /** An API key provider's credential. K fills this in. */
  auth(_providerId: string): { apiKey: string; headers?: Record<string, string> } | null {
    return null;
  }

  /** The credentials a task on a machine runs with; Codex's are refreshed with `refresh`. S fills this in. */
  sessionCreds<A extends keyof RunCreds>(_agent: A): NonNullable<RunCreds[A]> | null {
    return null;
  }

  /** Starts ChatGPT's device code sign-in. S fills this in. */
  chatgptLogin(): { userCode: string; verificationUrl: string; loginId: string } {
    throw new Error("ChatGPT sign-in is not set up.");
  }

  chatgptPoll(_loginId: string): "pending" | "done" | { error: string } {
    throw new Error("ChatGPT sign-in is not set up.");
  }

  /** The GitHub token tasks get, and the repos it may touch. CM fills this in. */
  githubToken(): { token: string; repos: string[] } | null {
    return null;
  }

  /** A new token for `subject`, replacing its last one of this kind; without `ttlMs` it never expires. */
  async mint(kind: TokenKind, subject: string, ttlMs?: number): Promise<string> {
    if (ttlMs !== undefined && !(Number.isFinite(ttlMs) && ttlMs > 0)) {
      throw new Error(`A token's ttl must be a positive number of milliseconds, not ${ttlMs}.`);
    }

    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    await this.#store(kind, subject, token, ttlMs === undefined ? null : this.now() + ttlMs, null);

    return token;
  }

  /**
   * The subject's live token, the same one each time until it is revoked, or
   * a new one. A task's token is in the env of the Claude Code process its
   * first run started, and every later run of it, a resend or a steer into
   * that process, must carry the same token, so the caller keeps nothing.
   *
   * It is an HMAC of a random nonce under a key only the Vault holds, so the
   * Vault keeps the nonce rather than the token. Callers racing for one
   * subject share one issue.
   */
  issue(kind: ReissuedKind, subject: string): Promise<string> {
    const key = JSON.stringify([kind, subject]);
    const running = this.#issuing.get(key);

    if (running) return running;
    const issue = this.#issue(kind, subject).finally(() => this.#issuing.delete(key));
    this.#issuing.set(key, issue);

    return issue;
  }

  /**
   * The subject a live token of this kind was minted for, or null. Looked up
   * by hash: nobody can pick a guess's sha-256, so the lookup's timing gives
   * nothing away.
   */
  async check(kind: TokenKind, token: string): Promise<string | null> {
    const hash = await sha256(token);

    return (
      this.#sql
        .exec<{ subject: string }>(
          "SELECT subject FROM ky_vault_tokens WHERE kind = ? AND hash = ? AND (expires_at IS NULL OR expires_at > ?)",
          kind,
          hash,
          this.now()
        )
        .toArray()[0]?.subject ?? null
    );
  }

  /** Like `check`, and the token is used up: of callers racing with one token, only one gets its subject. */
  async consume(kind: TokenKind, token: string): Promise<string | null> {
    const hash = await sha256(token);

    // One statement, after the only await: nothing can run between finding the token and deleting it.
    return (
      this.#sql
        .exec<{ subject: string }>(
          `DELETE FROM ky_vault_tokens WHERE kind = ? AND hash = ? AND (expires_at IS NULL OR expires_at > ?)
           RETURNING subject`,
          kind,
          hash,
          this.now()
        )
        .toArray()[0]?.subject ?? null
    );
  }

  revoke(kind: TokenKind, subject: string): void {
    this.#sql.exec("DELETE FROM ky_vault_tokens WHERE kind = ? AND subject = ?", kind, subject);
  }

  async #issue(kind: ReissuedKind, subject: string): Promise<string> {
    const live = this.#sql
      .exec<{ nonce: string }>(
        `SELECT nonce FROM ky_vault_tokens
         WHERE kind = ? AND subject = ? AND nonce IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)`,
        kind,
        subject,
        this.now()
      )
      .toArray()[0];

    if (live) return this.#derive(live.nonce);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
    const token = await this.#derive(nonce);
    await this.#store(kind, subject, token, null, nonce);

    return token;
  }

  /** Keep `token`'s hash as the subject's one live token of this kind. */
  async #store(kind: TokenKind, subject: string, token: string, expiresAt: number | null, nonce: string | null): Promise<void> {
    const hash = await sha256(token);
    this.#sql.exec("DELETE FROM ky_vault_tokens WHERE expires_at <= ?", this.now());
    this.#sql.exec(
      `INSERT INTO ky_vault_tokens (kind, subject, hash, expires_at, nonce) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, subject) DO UPDATE SET hash = excluded.hash, expires_at = excluded.expires_at, nonce = excluded.nonce`,
      kind,
      subject,
      hash,
      expiresAt,
      nonce
    );
  }

  /** The token issued from `nonce`. */
  async #derive(nonce: string): Promise<string> {
    this.#key ??= this.#hmacKey();

    return hex(await crypto.subtle.sign("HMAC", await this.#key, encoder.encode(nonce)));
  }

  /** The Vault's HMAC key, made the first time it is needed. */
  #hmacKey(): Promise<CryptoKey> {
    const made = hex(crypto.getRandomValues(new Uint8Array(32)));
    this.#sql.exec("INSERT OR IGNORE INTO ky_vault_keys (name, key) VALUES ('issue', ?)", made);
    const { key } = this.#sql.exec<{ key: string }>("SELECT key FROM ky_vault_keys WHERE name = 'issue'").one();
    const bytes = Uint8Array.from(key.match(/../g)!, (pair) => Number.parseInt(pair, 16));

    return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }

  async #refresh(
    kind: SecretKind,
    id: string,
    stored: Stored,
    fn: (value: JsonValue) => Promise<JsonValue>
  ): Promise<JsonValue | null> {
    try {
      // JSON.stringify gives undefined for undefined, and throws for what it can't serialize.
      const next: string | undefined = JSON.stringify(await fn(JSON.parse(stored.value)));

      if (next === undefined) throw new Error("The refresh returned no value.");

      // A new row, so a new generation, that keeps the meta and drops the error; only over the generation fn was given.
      const saved = this.#sql
        .exec(
          `INSERT OR REPLACE INTO ky_vault_secrets (kind, id, value, meta, updated_at)
           SELECT kind, id, ?, meta, ? FROM ky_vault_secrets WHERE kind = ? AND id = ? AND generation = ?
           RETURNING generation`,
          next,
          this.now(),
          kind,
          id,
          stored.generation
        )
        .toArray();

      if (saved.length > 0) return JSON.parse(next);
    } catch (error) {
      if (this.#stored(kind, id)?.generation !== stored.generation) return this.#current(kind, id);
      this.#sql.exec(
        "UPDATE ky_vault_secrets SET error = ? WHERE kind = ? AND id = ? AND generation = ?",
        error instanceof Error ? error.message : String(error),
        kind,
        id,
        stored.generation
      );
      throw error;
    }

    return this.#current(kind, id);
  }

  #stored(kind: SecretKind, id: string): Stored | undefined {
    return this.#sql
      .exec<Stored>("SELECT value, generation FROM ky_vault_secrets WHERE kind = ? AND id = ?", kind, id)
      .toArray()[0];
  }

  #current(kind: SecretKind, id: string): JsonValue | null {
    const stored = this.#stored(kind, id);

    return stored === undefined ? null : JSON.parse(stored.value);
  }
}
