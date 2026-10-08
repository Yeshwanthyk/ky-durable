// Nothing calls the Vault yet: pairing, keys and subscriptions will, and fallow
// doesn't count the tests' calls through a stub. Drop this once they do.
// fallow-ignore-file unused-class-member
import { DurableObject } from "cloudflare:workers";
import type { JsonValue } from "@earendil-works/pi-ai";

/**
 * The Vault: every secret ky keeps, in a Durable Object of its own,
 * `env.Vault.getByName("owner")`, apart from the agent's storage.
 *
 * - Secrets are JSON values by kind and id: an API key for a provider, the
 *   Claude and ChatGPT subscriptions, GitHub, Executor. `status` lists them
 *   without their values.
 * - Tokens are what ky hands out: pairing codes, machine tokens, task tokens.
 *   `mint` returns the raw token once and keeps only its sha-256; a subject
 *   has one live token per kind, so minting again replaces it.
 */

// The Workers runtime has this; the DOM typings, which win for `crypto`, do not.
declare global {
  interface SubtleCrypto {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  }
}

type SecretKind = "provider" | "claude" | "chatgpt" | "github" | "executor";

type TokenKind = "pair" | "machine" | "task";

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

/** What a task's `run` frame may carry so the machine needn't be signed in itself (C1). */
type RunCreds = {
  readonly claude: { readonly oauthToken: string };
  readonly codex: {
    readonly accessToken: string;
    readonly refreshToken: null;
    readonly idToken: string;
    readonly accountId: string;
    readonly expiresAt: number;
  };
};

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export class Vault extends DurableObject<Env> {
  readonly #sql = this.ctx.storage.sql;
  /** The refresh running for each secret, which callers that arrive meanwhile share. */
  readonly #refreshing = new Map<string, Promise<JsonValue | null>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS ky_vault_secrets (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL,
      meta TEXT,
      updated_at INTEGER NOT NULL,
      error TEXT,
      PRIMARY KEY (kind, id))`);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS ky_vault_tokens (
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      hash TEXT NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (kind, subject))`);
  }

  put(kind: SecretKind, id: string, value: JsonValue, meta?: SecretMeta): void {
    this.#sql.exec(
      `INSERT INTO ky_vault_secrets (kind, id, value, meta, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET
         value = excluded.value, meta = excluded.meta, updated_at = excluded.updated_at, error = NULL`,
      kind,
      id,
      JSON.stringify(value),
      meta === undefined ? null : JSON.stringify(meta),
      Date.now()
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
   * refreshes OAuth tokens. Callers that arrive while a refresh runs share it.
   * The write lands only if the secret is still the value `fn` was given; when
   * a put or remove got there first, the refresh loses and the answer is what
   * is stored now. A secret that isn't there is null. When `fn` throws, its
   * message is kept as the secret's error (unless the secret changed) and the
   * refresh throws.
   *
   * The caller decides when a refresh is due; this always runs `fn` unless one
   * is already running.
   */
  refresh(kind: SecretKind, id: string, fn: (value: JsonValue) => Promise<JsonValue>): Promise<JsonValue | null> {
    const key = JSON.stringify([kind, id]);
    const running = this.#refreshing.get(key);

    if (running) return running;
    const refresh = this.#refresh(kind, id, fn).finally(() => this.#refreshing.delete(key));
    this.#refreshing.set(key, refresh);

    return refresh;
  }

  /** An API key provider's credential. K fills this in. */
  auth(_providerId: string): { apiKey: string; headers?: Record<string, string> } | null {
    return null;
  }

  /** The credentials a task on a machine runs with; Codex's are refreshed with `refresh`. S fills this in. */
  sessionCreds<A extends keyof RunCreds>(_agent: A): RunCreds[A] | null {
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
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await sha256(token);
    const now = Date.now();
    this.#sql.exec("DELETE FROM ky_vault_tokens WHERE expires_at <= ?", now);
    this.#sql.exec(
      `INSERT INTO ky_vault_tokens (kind, subject, hash, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, subject) DO UPDATE SET hash = excluded.hash, expires_at = excluded.expires_at`,
      kind,
      subject,
      hash,
      ttlMs === undefined ? null : now + ttlMs
    );

    return token;
  }

  /** The subject a live token of this kind was minted for, or null. Every candidate is compared in constant time. */
  async check(kind: TokenKind, token: string): Promise<string | null> {
    const presented = encoder.encode(await sha256(token));

    const rows = this.#sql
      .exec<{ subject: string; hash: string }>(
        "SELECT subject, hash FROM ky_vault_tokens WHERE kind = ? AND (expires_at IS NULL OR expires_at > ?)",
        kind,
        Date.now()
      )
      .toArray();

    let subject: string | null = null;

    for (const row of rows) {
      if (crypto.subtle.timingSafeEqual(encoder.encode(row.hash), presented)) subject = row.subject;
    }

    return subject;
  }

  revoke(kind: TokenKind, subject: string): void {
    this.#sql.exec("DELETE FROM ky_vault_tokens WHERE kind = ? AND subject = ?", kind, subject);
  }

  async #refresh(kind: SecretKind, id: string, fn: (value: JsonValue) => Promise<JsonValue>): Promise<JsonValue | null> {
    const stored = this.#value(kind, id);

    if (stored === undefined) return null;
    let next: JsonValue;

    try {
      next = await fn(JSON.parse(stored));
    } catch (error) {
      this.#sql.exec(
        "UPDATE ky_vault_secrets SET error = ? WHERE kind = ? AND id = ? AND value = ?",
        error instanceof Error ? error.message : String(error),
        kind,
        id,
        stored
      );
      throw error;
    }

    const saved = this.#sql
      .exec(
        `UPDATE ky_vault_secrets SET value = ?, updated_at = ?, error = NULL
         WHERE kind = ? AND id = ? AND value = ? RETURNING id`,
        JSON.stringify(next),
        Date.now(),
        kind,
        id,
        stored
      )
      .toArray();

    if (saved.length > 0) return next;
    const now = this.#value(kind, id);

    return now === undefined ? null : JSON.parse(now);
  }

  /** A secret's stored JSON text. */
  #value(kind: SecretKind, id: string): string | undefined {
    return this.#sql
      .exec<{ value: string }>("SELECT value FROM ky_vault_secrets WHERE kind = ? AND id = ?", kind, id)
      .toArray()[0]?.value;
  }
}
