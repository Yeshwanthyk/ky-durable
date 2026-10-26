import { DurableObject } from "cloudflare:workers";
import type { JsonValue } from "@earendil-works/pi-ai";
import Type from "typebox";
import { decode, decodeOr, parseAs } from "./core/decode";
import { type ChatGptLogin, DEVICE_CODE_TTL_MS, type Device, type Fetch, pollDevice, refreshLogin, startDevice, VERIFICATION_URL } from "./chatgpt";
import type { ExecutorConnection } from "./executor";
import { type GithubLogin, listRepos } from "./github";
import type { ChatGptCode, ChatGptState } from "./protocol";
import { base64url, fromBase64url, vapidToken } from "./push/webpush";
import type { ProviderKey } from "./providers/api-key";
import { type Agent, ISSUED_TTL_MS, type RunCreds } from "./machines/contract";
import { credentialFetch, type CredentialReply, type CredentialRequest, CredentialSchema, HTTP_KIND, signedWith } from "./inbound/credentials";

/**
 * The Vault: every secret ky keeps, in a Durable Object of its own,
 * `env.Vault.getByName("owner")`, apart from the agent's storage.
 *
 * - Secrets are JSON values by kind and id: an API key for a provider, the
 *   Claude and ChatGPT subscriptions, GitHub, Executor. `status` lists them
 *   without their values. A kind is any name, so a new kind of secret needs
 *   no change here.
 * - Tokens are what ky hands out: pairing codes, machine tokens, task tokens.
 *   `mint` returns the raw token once and keeps only its sha-256; a subject
 *   has one live token per kind, so minting again replaces it. `issue` gives
 *   a task its live token again, for every run of it the runner is sent: the
 *   Vault keeps what it derives that token from, so it can make it again.
 *
 * - Subscriptions are the user's Claude and ChatGPT logins, which tasks on
 *   machines run with (`sessionCreds`). The Claude token is only ever handed
 *   to the `claude` CLI; the Vault never calls Anthropic with it. ChatGPT's
 *   is signed in with a device code the Vault's alarm polls for, and
 *   refreshed here; its refresh token never leaves the Vault.
 *
 * - HTTP credentials, ("http", name), are an API's token the user typed into a
 *   masked field. Only the Vault reads one: `httpRequest` makes the call with
 *   it, to its own origin only, and redacts it from what comes back
 *   (src/inbound/credentials.ts). A webhook's signing secret, ("hook-signing",
 *   its id), never leaves either: `hookSigned` checks a post with it.
 *
 * - ky's VAPID key pair signs its Web Push (src/push.ts): made the first
 *   time it is needed, kept with the HMAC key, and never handed out; only
 *   its public half and the tokens it signs leave the Vault.
 *
 * models.ts keeps the api-key providers' keys here. fallow follows no call
 * through a stub, the Worker's and the agent's included, so
 * fallow/dead-code.json lists the members.
 */

/** What a secret is for, like "provider", "claude" or "github". */
type SecretKind = string;

/**
 * `peer-invite` and `peer` are src/peers/peers.ts's: a code another ky pairs with, and the token it calls this ky with.
 * `hook` is a webhook's, in its URL (src/inbound/routes.ts); its subject is the hook's id.
 */
export type TokenKind = "pair" | "machine" | "task" | "peer-invite" | "peer" | "hook";

/** The kinds `issue` can give out again: a task's runs all carry its one token. */
export type ReissuedKind = "task";

/** What Settings may show about a secret, like its label, account or repos. Flat, so it crosses RPC typed. */
type SecretMeta = { readonly [field: string]: string | number | boolean | null | readonly string[] };

/** A secret as Settings may show it: never its value. */
export type SecretStatus = {
  readonly kind: SecretKind;
  readonly id: string;
  readonly meta: SecretMeta | null;
  readonly updatedAt: number;
  /** Why the last refresh failed, until the secret is next written. */
  readonly error?: string;
};

/** The id each subscription is kept under: `("claude" | "chatgpt" | "github", SUBSCRIPTION)`. */
export const SUBSCRIPTION = "subscription";

/**
 * A Codex task is handed a ChatGPT login that lasts at least this long:
 * `sessionCreds` refreshes one with less left, and the agent pushes the new
 * one to a task still open, at the runner's next hello.
 */
const CODEX_RENEW_BEFORE_MS = 60 * 60_000;

/** A secret's JSON text, and the write that stored it. */
type Stored = { readonly value: string; readonly generation: number };

const encoder = new TextEncoder();

/** A row of ky_vault_keys, as the VAPID key is read. */
const KeyRow = Type.Object({ key: Type.String() });

/** The VAPID private key as kept: a P-256 JWK. */
const VapidJwk = Type.Object({ kty: Type.Literal("EC"), crv: Type.Literal("P-256"), x: Type.String(), y: Type.String(), d: Type.String() });

/** The VAPID key pair: the private key to sign with, and the public one as browsers take it, base64url. */
type Vapid = { readonly signer: CryptoKey; readonly publicKey: string };

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
  /** The VAPID key pair, once read or made. */
  #vapid: Promise<Vapid> | undefined;
  /** The clock for updated_at and token expiry; tests move it. */
  now = (): number => Date.now();
  /** OpenAI, as ChatGPT's sign-in and refresh reach it; tests answer instead. */
  openai: Fetch = (input, init) => fetch(input, init);
  /** GitHub's API, as Settings lists a token's repos; tests answer instead. */
  github: Fetch = (input, init) => fetch(input, init);
  /** The APIs HTTP credentials are for, as `httpRequest` calls them; tests answer instead. */
  http: Fetch = (input, init) => fetch(input, init);

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
    // A machine token from before pairings had ids names only the machine; no route takes it, so it goes.
    this.#sql.exec("DELETE FROM ky_vault_tokens WHERE kind = 'machine' AND instr(subject, ':') = 0");
    this.#sql.exec("CREATE TABLE IF NOT EXISTS ky_vault_keys (name TEXT PRIMARY KEY, key TEXT NOT NULL)");
    // ChatGPT sign-ins: the device code the alarm polls with until `poll_at`, then how it ended.
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS ky_vault_logins (
      id TEXT PRIMARY KEY,
      device TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      poll_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      error TEXT)`);
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

  /** An api-key provider's credential, which models.ts saved under ("provider", its id) once a test call took it. */
  auth(providerId: string): ProviderKey | null {
    // SAFETY: only Models.addKey writes this kind, each value a ProviderKey.
    return this.#current("provider", providerId) as ProviderKey | null;
  }

  /**
   * What a task running as `agent` is handed when it doesn't use the
   * machine's own login, or null without a subscription. A ChatGPT login
   * with less than CODEX_RENEW_BEFORE_MS left is refreshed first; one whose
   * refresh failed is handed while it lasts, and the error shows in Settings.
   */
  async sessionCreds<A extends Agent>(agent: A): Promise<NonNullable<RunCreds[A]> | null> {
    const creds: RunCreds = agent === "claude" ? { claude: this.#claudeCreds() } : { codex: await this.#codexCreds() };

    return creds[agent] ?? null;
  }

  /** Start a ChatGPT sign-in: the user enters `userCode` at `verificationUrl`, and the Vault's alarm polls until they have. */
  async chatgptLogin(): Promise<ChatGptCode> {
    const device = await startDevice(this.openai);
    const loginId = crypto.randomUUID();
    // One sign-in at a time: a new one replaces any other.
    this.#sql.exec("DELETE FROM ky_vault_logins");
    this.#sql.exec(
      "INSERT INTO ky_vault_logins (id, device, expires_at, poll_at, state) VALUES (?, ?, ?, ?, 'pending')",
      loginId,
      JSON.stringify(device),
      this.now() + DEVICE_CODE_TTL_MS,
      this.now() + device.intervalMs
    );
    await this.#arm();

    return { userCode: device.userCode, verificationUrl: VERIFICATION_URL, loginId };
  }

  chatgptPoll(loginId: string): ChatGptState {
    const row = this.#sql
      .exec<{ state: "pending" | "done" | "error"; error: string | null }>("SELECT state, error FROM ky_vault_logins WHERE id = ?", loginId)
      .toArray()[0];

    if (!row) return { error: "This sign-in was replaced or cancelled. Start again." };

    return row.state === "error" ? { error: row.error ?? "The sign-in failed." } : row.state;
  }

  /** Poll each ChatGPT sign-in that is due, then wait for the next. */
  override async alarm(): Promise<void> {
    const due = this.#sql
      .exec<{ id: string; device: string; expires_at: number }>(
        "SELECT id, device, expires_at FROM ky_vault_logins WHERE state = 'pending' AND poll_at <= ?",
        this.now()
      )
      .toArray();

    for (const row of due) await this.#poll(row.id, JSON.parse(row.device), row.expires_at);
    await this.#arm();
  }

  async #poll(id: string, device: Device, expiresAt: number): Promise<void> {
    if (expiresAt <= this.now()) return this.#ended(id, "The code expired before it was entered. Start again.");

    try {
      const login = await pollDevice(this.openai, device);

      if (login === "pending") {
        this.#sql.exec("UPDATE ky_vault_logins SET poll_at = ? WHERE id = ? AND state = 'pending'", this.now() + device.intervalMs, id);

        return;
      }

      // A sign-in replaced or cancelled meanwhile stores nothing.
      if (this.chatgptPoll(id) !== "pending") return;
      this.put("chatgpt", SUBSCRIPTION, login);
      this.#sql.exec("UPDATE ky_vault_logins SET state = 'done' WHERE id = ?", id);
    } catch (error) {
      this.#ended(id, error instanceof Error ? error.message : String(error));
    }
  }

  #ended(id: string, error: string): void {
    this.#sql.exec("UPDATE ky_vault_logins SET state = 'error', error = ? WHERE id = ? AND state = 'pending'", error, id);
  }

  /** Wake for the next sign-in poll, or not at all. The alarm runs on the real clock; polls are due by `now`. */
  async #arm(): Promise<void> {
    const next = this.#sql.exec<{ at: number | null }>("SELECT MIN(poll_at) AS at FROM ky_vault_logins WHERE state = 'pending'").one().at;

    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Date.now() + Math.max(0, next - this.now()));
  }

  #claudeCreds(): { oauthToken: string } | undefined {
    // SAFETY: only the set-claude message writes ("claude", SUBSCRIPTION).
    return (this.#current("claude", SUBSCRIPTION) as { oauthToken: string } | null) ?? undefined;
  }

  async #codexCreds(): Promise<NonNullable<RunCreds["codex"]> | undefined> {
    // SAFETY: only #poll and the refresh below write ("chatgpt", SUBSCRIPTION), each a ChatGptLogin.
    const stored = this.#current("chatgpt", SUBSCRIPTION) as ChatGptLogin | null;

    if (!stored) return undefined;
    let login: ChatGptLogin | null = stored;

    if (stored.expiresAt - this.now() < CODEX_RENEW_BEFORE_MS) {
      try {
        // SAFETY: as above. Null when the login was removed meanwhile.
        login = (await this.refresh("chatgpt", SUBSCRIPTION, (value) => refreshLogin(this.openai, value as ChatGptLogin))) as ChatGptLogin | null;
      } catch {
        // Kept as the secret's error, which Settings shows.
        if (stored.expiresAt <= this.now()) return undefined;
      }
    }

    if (!login) return undefined;

    return { accessToken: login.accessToken, refreshToken: null, idToken: login.idToken, accountId: login.accountId, expiresAt: login.expiresAt };
  }

  /** The agent's Executor connection, which Settings saved under ("executor", agent) once ky signed in with it. */
  executor(agent: string): ExecutorConnection | null {
    // SAFETY: only ExecutorLink.connect writes this kind, each value an ExecutorConnection.
    return this.#current("executor", agent) as ExecutorConnection | null;
  }

  /**
   * ky's GitHub token, and the repos (owner/name) it may touch. Only the Worker uses it: the
   * github.internal proxy fetches and pushes with it, and its GitHub tools call GitHub's API with it
   * (src/github.ts). No task ever gets it.
   */
  githubToken(): GithubLogin | null {
    // SAFETY: only setGithub writes ("github", SUBSCRIPTION), each a GithubLogin.
    return (this.#current("github", SUBSCRIPTION) as GithubLogin | null) ?? null;
  }

  /** The token ky calls the peer `name` with, which its ky minted when they paired (src/peers/peers.ts); null once unpaired. */
  peerToken(name: string): string | null {
    // SAFETY: only src/peers/peers.ts writes this kind, each value a token string.
    return this.#current("peer", name) as string | null;
  }

  /** Call an API with the HTTP credential `name`: only its own origin, the answer redacted (src/inbound/credentials.ts). */
  httpRequest(name: string, request: CredentialRequest): Promise<CredentialReply> {
    const credential = decodeOr(CredentialSchema, this.#current(HTTP_KIND, name), null);

    if (!credential) return Promise.resolve({ refused: `There is no credential ${name}. list_secrets shows the ones there are.`, sent: false });

    return credentialFetch(this.http, credential, request);
  }

  /**
   * Whether a post's body passes the hook's signature check: any body for a hook that isn't `signed`. A signed hook
   * whose secret isn't here (a restore brings no Vault, or its write failed) passes nothing, until it is rotated.
   */
  async hookSigned(id: string, signed: boolean, body: string, signature: string | null): Promise<boolean> {
    if (!signed) return true;
    const secret = decodeOr(Type.String(), this.#current("hook-signing", id), null);

    return secret !== null && signedWith(secret, body, signature);
  }

  /** The repos a GitHub token reaches, for Settings to pick from, or why GitHub refused it. */
  githubRepos(token: string): Promise<{ repos: string[] } | { refused: string }> {
    return listRepos(this.github, token.trim());
  }

  /** Keep a GitHub token for the cloud machine, with the repos it may touch: some of those it reaches. */
  async setGithub(token: string, repos: readonly string[]): Promise<{ refused?: string }> {
    const listed = await this.githubRepos(token);

    if ("refused" in listed) return listed;

    if (repos.length === 0) return { refused: "Pick at least one repo." };
    const unknown = repos.filter((repo) => !listed.repos.includes(repo));

    if (unknown.length > 0) return { refused: `The token doesn't reach ${unknown.join(", ")}.` };
    const login: GithubLogin = { token: token.trim(), repos: [...repos] };

    this.put("github", SUBSCRIPTION, login, { repos: login.repos });

    return {};
  }

  /** ky's VAPID public key, base64url, which a browser subscribes to its pushes with. */
  async vapidKey(): Promise<string> {
    this.#vapid ??= this.#vapidKeys();

    return (await this.#vapid).publicKey;
  }

  /** The Authorization header of a push to the push service at `audience` (RFC 8292), naming `subject` as ky's contact. */
  async vapidAuth(audience: string, subject: string): Promise<string> {
    this.#vapid ??= this.#vapidKeys();
    const { signer, publicKey } = await this.#vapid;

    return `vapid t=${await vapidToken(signer, audience, subject, this.now())}, k=${publicKey}`;
  }

  /** A new token for `subject`, replacing its last one of this kind; without `ttlMs` it never expires. */
  async mint(kind: TokenKind, subject: string, ttlMs?: number): Promise<string> {
    if (ttlMs !== undefined && !(Number.isFinite(ttlMs) && ttlMs > 0)) {
      throw new Error(`A token's ttl must be a positive number of milliseconds, not ${ttlMs}.`);
    }

    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    this.#store(kind, subject, await sha256(token), ttlMs === undefined ? null : this.now() + ttlMs, null);

    return token;
  }

  /**
   * The subject's live token, the same one each time until it is revoked, or
   * a new one. A task's token is in the env of the Claude Code process its
   * first run started, and every later run of it, a resend or a steer into
   * that process, must carry the same token, so the caller keeps nothing.
   *
   * It is an HMAC of a random nonce under a key only the Vault holds. The
   * Vault keeps the nonce and the token's hash, not the token; but with the
   * key, in the same storage, it can derive the token again, which is what
   * `issue` does. Each issue moves the token's expiry to ISSUED_TTL_MS from
   * now. Callers racing for one subject share one issue.
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

  /** Revoke the tokens of all of `subjects`: an agent's sweep, for revokes a failure lost. */
  revokeAll(kind: ReissuedKind, subjects: readonly string[]): void {
    this.#sql.exec(
      "DELETE FROM ky_vault_tokens WHERE kind = ? AND subject IN (SELECT value FROM json_each(?))",
      kind,
      JSON.stringify(subjects)
    );
  }

  async #issue(kind: ReissuedKind, subject: string): Promise<string> {
    // Every await comes first, so nothing, a revoke least of all, runs between reading the live token and storing a new one.
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
    const token = await this.#derive(nonce);
    const hash = await sha256(token);
    const now = this.now();

    const live = this.#sql
      .exec<{ nonce: string }>(
        `UPDATE ky_vault_tokens SET expires_at = ?
         WHERE kind = ? AND subject = ? AND nonce IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)
         RETURNING nonce`,
        now + ISSUED_TTL_MS,
        kind,
        subject,
        now
      )
      .toArray()[0];

    if (live) return this.#derive(live.nonce);
    this.#store(kind, subject, hash, now + ISSUED_TTL_MS, nonce);

    return token;
  }

  /** Keep `hash` as the subject's one live token of this kind. */
  #store(kind: TokenKind, subject: string, hash: string, expiresAt: number | null, nonce: string | null): void {
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

  /** The VAPID key pair, made the first time it is needed; of two made at once, the first stored wins. */
  async #vapidKeys(): Promise<Vapid> {
    const made = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    this.#sql.exec("INSERT OR IGNORE INTO ky_vault_keys (name, key) VALUES ('vapid', ?)", JSON.stringify(await crypto.subtle.exportKey("jwk", made.privateKey)));
    const { key } = decode(KeyRow, this.#sql.exec("SELECT key FROM ky_vault_keys WHERE name = 'vapid'").one(), "The VAPID key's row");
    const jwk = parseAs(VapidJwk, key, "The VAPID key");
    const signer = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

    return { signer, publicKey: base64url(Uint8Array.of(4, ...fromBase64url(jwk.x), ...fromBase64url(jwk.y))) };
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
