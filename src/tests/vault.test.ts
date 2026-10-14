import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ISSUED_TTL_MS } from "../machines/contract";
import { SUBSCRIPTION, type Vault } from "../vault";
import { ACCOUNT_ID, type FakeOpenAi, fakeOpenAi } from "../../test/fakes/openai";

/**
 * The Vault (src/vault.ts) through its real Durable Object: over RPC as the
 * Worker and PiAgent will call it, and from inside for `refresh`, whose
 * argument is a function, and for what is actually stored.
 */

/** A Vault of its own, so tests share no storage; ky's one is `getByName("owner")`. */
function fresh(): DurableObjectStub<Vault> {
  return env.Vault.getByName(crypto.randomUUID());
}

function inside<T>(vault: DurableObjectStub<Vault>, work: (instance: Vault, state: DurableObjectState) => Promise<T> | T): Promise<T> {
  return runInDurableObject(vault, work);
}

/** A promise the test settles by hand. */
type Gate<T> = { promise: Promise<T>; open: (value: T) => void; fail: (error: Error) => void };

function gate<T>(): Gate<T> {
  let open!: (value: T) => void;
  let fail!: (error: Error) => void;

  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });

  return { promise, open, fail };
}

const CODEX = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: 1 };

describe("vault", () => {
  it("puts, replaces and removes secrets, and status lists them without their values", async () => {
    const vault = fresh();
    await vault.put("provider", "anthropic", { apiKey: "sk-ant-secret-1" }, { label: "Anthropic" });
    await vault.put("github", "token", "ghp_secret_2", { repos: ["me/ky"] });
    await vault.put("provider", "anthropic", { apiKey: "sk-ant-secret-3" });

    const status = await vault.status();

    expect(status).toEqual([
      { kind: "github", id: "token", meta: { repos: ["me/ky"] }, updatedAt: expect.any(Number) },
      { kind: "provider", id: "anthropic", meta: null, updatedAt: expect.any(Number) }
    ]);
    expect(JSON.stringify(status)).not.toMatch(/secret/);

    await vault.remove("provider", "anthropic");

    expect((await vault.status()).map((secret) => secret.id)).toEqual(["token"]);
  });

  it("mints a token that checks as its subject for its own kind only, and stores only its sha-256", async () => {
    const vault = fresh();
    const token = await vault.mint("machine", "mac");

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await vault.check("machine", token)).toBe("mac");
    expect(await vault.check("task", token)).toBeNull();
    expect(await vault.check("machine", "0".repeat(64))).toBeNull();
    expect(await vault.check("machine", "")).toBeNull();

    const stored = await inside(vault, (_instance, state) =>
      state.storage.sql.exec<{ hash: string }>("SELECT hash FROM ky_vault_tokens").toArray()
    );

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));

    expect(stored).toEqual([{ hash: Buffer.from(digest).toString("hex") }]);
  });

  it("tells subjects apart, and minting again replaces the subject's last token", async () => {
    const vault = fresh();
    const first = await vault.mint("machine", "mac");
    const other = await vault.mint("machine", "linux");
    const second = await vault.mint("machine", "mac");

    expect(await vault.check("machine", first)).toBeNull();
    expect(await vault.check("machine", second)).toBe("mac");
    expect(await vault.check("machine", other)).toBe("linux");
  });

  it("revokes a subject's token and no other", async () => {
    const vault = fresh();
    const task = await vault.mint("task", "t1");
    const machine = await vault.mint("machine", "t1");
    await vault.revoke("task", "t1");

    expect(await vault.check("task", task)).toBeNull();
    expect(await vault.check("machine", machine)).toBe("t1");
  });

  it("refuses a token once its ttl has passed, and forgets it at the next mint", async () => {
    const vault = fresh();

    const subjects = await inside(vault, async (instance, state) => {
      let clock = 1_000_000;
      instance.now = () => clock;
      const code = await instance.mint("pair", "code", 50);
      const lasting = await instance.mint("pair", "lasting", 60_000);
      clock += 49;

      expect(await instance.check("pair", code)).toBe("code");
      clock += 1;

      expect(await instance.check("pair", code)).toBeNull();
      expect(await instance.consume("pair", code)).toBeNull();
      expect(await instance.check("pair", lasting)).toBe("lasting");

      await instance.mint("machine", "mac");

      return state.storage.sql.exec<{ subject: string }>("SELECT subject FROM ky_vault_tokens ORDER BY subject").toArray();
    });

    expect(subjects.map((row) => row.subject)).toEqual(["lasting", "mac"]);
  });

  it("refuses a ttl that isn't a positive number of milliseconds, and stores nothing for it", async () => {
    const vault = fresh();

    // From inside: a throw over RPC also surfaces as an unhandled rejection in vitest-pool-workers.
    const stored = await inside(vault, async (instance, state) => {
      for (const ttl of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
        await expect(instance.mint("pair", "code", ttl)).rejects.toThrow("ttl must be a positive number");
      }

      return state.storage.sql.exec("SELECT subject FROM ky_vault_tokens").toArray();
    });

    expect(stored).toEqual([]);
  });

  it("consumes a token once: of two racing callers, one gets its subject", async () => {
    const vault = fresh();
    const code = await vault.mint("pair", "code", 60_000);

    expect(await vault.consume("machine", code)).toBeNull();

    const results = await Promise.all([vault.consume("pair", code), vault.consume("pair", code)]);

    expect(results.filter((subject) => subject !== null)).toEqual(["code"]);
    expect(await vault.check("pair", code)).toBeNull();
  });

  it("issues a task its one live token again until it is revoked, then a new one, kept as its hash and nonce", async () => {
    const vault = fresh();
    const [first, racing] = await Promise.all([vault.issue("task", "t1"), vault.issue("task", "t1")]);
    const other = await vault.issue("task", "t2");

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(racing).toBe(first);
    expect(await vault.issue("task", "t1")).toBe(first);
    expect(other).not.toBe(first);
    expect(await vault.check("task", first)).toBe("t1");

    // An eviction loses nothing it needs: the token comes again from what is stored.
    await evictDurableObject(vault);
    expect(await vault.issue("task", "t1")).toBe(first);

    const stored = await inside(vault, (_instance, state) =>
      JSON.stringify([
        state.storage.sql.exec("SELECT * FROM ky_vault_tokens").toArray(),
        state.storage.sql.exec("SELECT * FROM ky_vault_keys").toArray()
      ])
    );

    expect(stored).not.toContain(first);
    expect(stored).not.toContain(other);

    await vault.revoke("task", "t1");
    expect(await vault.check("task", first)).toBeNull();
    const next = await vault.issue("task", "t1");
    expect(next).not.toBe(first);
    expect(await vault.check("task", next)).toBe("t1");
  });

  it("lets an issued token expire a day after its last issue", async () => {
    const vault = fresh();

    await inside(vault, async (instance) => {
      let clock = 1_000_000;
      instance.now = () => clock;
      const token = await instance.issue("task", "t1");
      clock += ISSUED_TTL_MS - 1;

      // Issued again just before it ends: a new day from now.
      expect(await instance.issue("task", "t1")).toBe(token);
      clock += ISSUED_TTL_MS - 1;

      expect(await instance.check("task", token)).toBe("t1");
      clock += 1;

      expect(await instance.check("task", token)).toBeNull();
      expect(await instance.issue("task", "t1")).not.toBe(token);
    });
  });

  it("lets a revoke that comes while an issue derives its token win: the issue stores a new one after it", async () => {
    const vault = fresh();

    await inside(vault, async (instance) => {
      const first = await instance.issue("task", "t1");
      const issuing = instance.issue("task", "t1");
      // The issue is deriving; it has read nothing yet.
      instance.revoke("task", "t1");
      const next = await issuing;

      expect(next).not.toBe(first);
      expect(await instance.check("task", first)).toBeNull();
      expect(await instance.check("task", next)).toBe("t1");
    });
  });

  it("revokes the issued tokens of all the subjects named, and no others", async () => {
    const vault = fresh();
    const one = await vault.issue("task", "t1");
    const two = await vault.issue("task", "t2");
    const three = await vault.issue("task", "t3");
    const machine = await vault.mint("machine", "t1");

    await vault.revokeAll("task", ["t1", "t3", "t9"]);

    expect(await vault.check("task", one)).toBeNull();
    expect(await vault.check("task", two)).toBe("t2");
    expect(await vault.check("task", three)).toBeNull();
    expect(await vault.check("machine", machine)).toBe("t1");
  });

  it("shares one refresh among concurrent callers and stores its result", async () => {
    const vault = fresh();
    await vault.put("chatgpt", "codex", CODEX, { account: "me" });

    const seen = await inside(vault, async (instance) => {
      const done = gate<JsonValue>();
      const given: JsonValue[] = [];

      const fn = (value: JsonValue) => {
        given.push(value);

        return done.promise;
      };

      const both = Promise.all([instance.refresh("chatgpt", "codex", fn), instance.refresh("chatgpt", "codex", fn)]);
      done.open({ ...CODEX, accessToken: "access-2" });

      return { given, results: await both };
    });

    expect(seen.given).toEqual([CODEX]);
    expect(seen.results).toEqual([
      { ...CODEX, accessToken: "access-2" },
      { ...CODEX, accessToken: "access-2" }
    ]);
    expect(await inside(vault, (instance) => instance.refresh("chatgpt", "codex", async (value) => value))).toEqual({
      ...CODEX,
      accessToken: "access-2"
    });
    expect(await vault.status()).toEqual([{ kind: "chatgpt", id: "codex", meta: { account: "me" }, updatedAt: expect.any(Number) }]);
  });

  it("drops a refresh that a put or remove beat, and answers with what is stored now", async () => {
    const vault = fresh();
    await vault.put("chatgpt", "codex", CODEX);

    const afterPut = await inside(vault, async (instance) => {
      const done = gate<JsonValue>();
      const refresh = instance.refresh("chatgpt", "codex", () => done.promise);
      instance.put("chatgpt", "codex", { ...CODEX, accessToken: "signed-in-again" }, { account: "again" });
      done.open({ ...CODEX, accessToken: "stale" });

      return refresh;
    });

    expect(afterPut).toEqual({ ...CODEX, accessToken: "signed-in-again" });
    expect(await vault.status()).toEqual([{ kind: "chatgpt", id: "codex", meta: { account: "again" }, updatedAt: expect.any(Number) }]);

    const afterRemove = await inside(vault, async (instance) => {
      const done = gate<JsonValue>();
      const refresh = instance.refresh("chatgpt", "codex", () => done.promise);
      instance.remove("chatgpt", "codex");
      done.open({ ...CODEX, accessToken: "stale" });

      return refresh;
    });

    expect(afterRemove).toBeNull();
    expect(await vault.status()).toEqual([]);
  });

  it("lets a put of the very same value beat a refresh, and runs a new refresh for callers after it", async () => {
    const vault = fresh();
    await vault.put("chatgpt", "codex", CODEX, { account: "me" });

    const seen = await inside(vault, async (instance) => {
      const stale = gate<JsonValue>();
      const later = gate<JsonValue>();
      let runs = 0;

      const first = instance.refresh("chatgpt", "codex", () => {
        runs++;

        return stale.promise;
      });

      instance.put("chatgpt", "codex", CODEX, { account: "again" });

      const second = instance.refresh("chatgpt", "codex", () => {
        runs++;

        return later.promise;
      });

      stale.open({ ...CODEX, accessToken: "stale" });
      const lost = await first;
      later.open({ ...CODEX, accessToken: "access-2" });

      return { runs, lost, won: await second };
    });

    expect(seen).toEqual({ runs: 2, lost: CODEX, won: { ...CODEX, accessToken: "access-2" } });
    expect(await vault.status()).toEqual([{ kind: "chatgpt", id: "codex", meta: { account: "again" }, updatedAt: expect.any(Number) }]);
  });

  it("answers a failed refresh that a put or remove beat with what is stored now, and records no error", async () => {
    const vault = fresh();
    await vault.put("chatgpt", "codex", CODEX);

    const afterPut = await inside(vault, async (instance) => {
      const done = gate<JsonValue>();
      const refresh = instance.refresh("chatgpt", "codex", () => done.promise);
      instance.put("chatgpt", "codex", { ...CODEX, accessToken: "signed-in-again" });
      done.fail(new Error("refresh token rejected"));

      return refresh;
    });

    expect(afterPut).toEqual({ ...CODEX, accessToken: "signed-in-again" });
    expect(await vault.status()).toEqual([{ kind: "chatgpt", id: "codex", meta: null, updatedAt: expect.any(Number) }]);

    const afterRemove = await inside(vault, async (instance) => {
      const done = gate<JsonValue>();
      const refresh = instance.refresh("chatgpt", "codex", () => done.promise);
      instance.remove("chatgpt", "codex");
      done.fail(new Error("refresh token rejected"));

      return refresh;
    });

    expect(afterRemove).toBeNull();
    expect(await vault.status()).toEqual([]);
  });

  it("keeps a failed refresh's error on the secret until a refresh or put next writes it, and runs nothing for a missing one", async () => {
    const vault = fresh();
    await vault.put("chatgpt", "codex", CODEX, { account: "me" });

    const failed = await inside(vault, async (instance) => {
      const done = gate<JsonValue>();
      const both = [instance.refresh("chatgpt", "codex", () => done.promise), instance.refresh("chatgpt", "codex", () => done.promise)];
      done.fail(new Error("refresh token rejected"));

      return Promise.allSettled(both);
    });

    expect(failed.map((result) => (result.status === "rejected" ? String(result.reason) : result.status))).toEqual([
      "Error: refresh token rejected",
      "Error: refresh token rejected"
    ]);
    expect(await vault.status()).toEqual([
      { kind: "chatgpt", id: "codex", meta: { account: "me" }, updatedAt: expect.any(Number), error: "refresh token rejected" }
    ]);

    const refreshed = await inside(vault, (instance) =>
      instance.refresh("chatgpt", "codex", async () => ({ ...CODEX, accessToken: "access-2" }))
    );

    expect(refreshed).toEqual({ ...CODEX, accessToken: "access-2" });
    expect(await vault.status()).toEqual([{ kind: "chatgpt", id: "codex", meta: { account: "me" }, updatedAt: expect.any(Number) }]);

    await inside(vault, (instance) =>
      expect(instance.refresh("chatgpt", "codex", () => Promise.reject(new Error("offline")))).rejects.toThrow("offline")
    );
    await vault.put("chatgpt", "codex", CODEX);

    expect((await vault.status())[0]?.error).toBeUndefined();

    let ran = false;

    const missing = await inside(vault, (instance) =>
      instance.refresh("claude", "token", async (value) => {
        ran = true;

        return value;
      })
    );

    expect(missing).toBeNull();
    expect(ran).toBe(false);
  });

  it("fails a refresh that returns nothing or what JSON can't hold, and keeps the secret", async () => {
    const vault = fresh();
    await vault.put("chatgpt", "codex", CODEX);

    const errors = await inside(vault, async (instance) => {
      const loop: { [key: string]: JsonValue } = {};
      loop.self = loop;
      const seen: (string | undefined)[] = [];

      // JSON.parse's `any` stands in for a refresh that returns undefined.
      for (const fn of [async () => JSON.parse("{}").missing, async () => loop]) {
        await expect(instance.refresh("chatgpt", "codex", fn)).rejects.toThrow();
        seen.push(instance.status()[0]?.error);
      }

      return seen;
    });

    expect(errors).toEqual(["The refresh returned no value.", expect.stringMatching(/circular/)]);
    expect(await inside(vault, (instance) => instance.refresh("chatgpt", "codex", async (value) => value))).toEqual(CODEX);
  });

  it("says what CM has yet to set up: no GitHub token", async () => {
    expect(await fresh().githubToken()).toBeNull();
  });
});

describe("subscriptions in the vault", () => {
  /** A fresh Vault answered by a fake OpenAI of its own, on the Vault's clock. */
  async function withOpenAi(): Promise<{ vault: DurableObjectStub<Vault>; openai: FakeOpenAi }> {
    const vault = fresh();

    const openai = await inside(vault, (instance) => {
      const fake = fakeOpenAi(() => instance.now());
      instance.openai = fake.fetch;

      return fake;
    });

    return { vault, openai };
  }

  /** Move the Vault's clock `ms` ahead of the real one. */
  const ahead = (vault: DurableObjectStub<Vault>, ms: number) =>
    inside(vault, (instance) => {
      instance.now = () => Date.now() + ms;
    });

  it("has nothing to hand out before the user sets anything up", async () => {
    const vault = fresh();

    expect(await vault.sessionCreds("claude")).toBeNull();
    expect(await vault.sessionCreds("codex")).toBeNull();
  });

  it("signs in to ChatGPT: its alarm polls until the code is entered, then keeps the login and stops", async () => {
    const { vault, openai } = await withOpenAi();
    const code = await vault.chatgptLogin();

    expect(code).toMatchObject({ userCode: "FAKE-1", verificationUrl: "https://auth.openai.com/codex/device" });
    expect(await vault.chatgptPoll(code.loginId)).toBe("pending");
    expect(await inside(vault, (_instance, state) => state.storage.getAlarm())).not.toBeNull();

    // Each poll is due a second after the last: the fake asks to wait once, then approves.
    await ahead(vault, 1_000);
    expect(await runDurableObjectAlarm(vault)).toBe(true);
    expect(await vault.chatgptPoll(code.loginId)).toBe("pending");
    await ahead(vault, 2_000);
    expect(await runDurableObjectAlarm(vault)).toBe(true);

    expect(await vault.chatgptPoll(code.loginId)).toBe("done");
    expect(await inside(vault, (_instance, state) => state.storage.getAlarm())).toBeNull();
    expect(openai.calls.map((call) => call.grant ?? call.path)).toEqual([
      "/api/accounts/deviceauth/usercode",
      "/api/accounts/deviceauth/token",
      "/api/accounts/deviceauth/token",
      "authorization_code"
    ]);
    expect(await vault.sessionCreds("codex")).toMatchObject({ accountId: ACCOUNT_ID, refreshToken: null });
    expect(JSON.stringify(await vault.status())).not.toMatch(/refresh-1|eyJ/);
  });

  it("ends a sign-in whose code expired, and one a newer sign-in replaced", async () => {
    const { vault } = await withOpenAi();
    const first = await vault.chatgptLogin();
    const second = await vault.chatgptLogin();

    expect(await vault.chatgptPoll(first.loginId)).toEqual({ error: "This sign-in was replaced or cancelled. Start again." });
    await ahead(vault, 16 * 60_000);
    await runDurableObjectAlarm(vault);
    expect(await vault.chatgptPoll(second.loginId)).toEqual({ error: "The code expired before it was entered. Start again." });
    expect(await vault.sessionCreds("codex")).toBeNull();
  });

  it("refreshes the ChatGPT login under an hour before it expires, and uses a live one while a refresh fails", async () => {
    const { vault, openai } = await withOpenAi();
    const expiresAt = Date.now() + 90 * 60_000;
    const login = { accessToken: "access-0", refreshToken: "refresh-0", idToken: "id-0", accountId: ACCOUNT_ID, expiresAt };
    await vault.put("chatgpt", SUBSCRIPTION, login);

    // An hour and a half left: as it is.
    expect(await vault.sessionCreds("codex")).toEqual({ ...login, refreshToken: null });

    // Under an hour left: refreshed, once, keeping the new refresh token for the next.
    await ahead(vault, 31 * 60_000);
    // From inside: over RPC the stub loses which agent's creds these are.
    const refreshed = await inside(vault, (instance) => instance.sessionCreds("codex"));
    expect(refreshed?.accessToken).not.toBe("access-0");
    expect(refreshed?.expiresAt).toBeGreaterThan(expiresAt);
    expect(await vault.sessionCreds("codex")).toEqual(refreshed);
    expect(openai.calls.filter((call) => call.grant === "refresh_token")).toHaveLength(1);

    // A refused refresh keeps the last token while it lasts, and says why in Settings, without a token.
    openai.revoke();
    await ahead(vault, 31 * 60_000 + 61 * 60_000);
    expect(await vault.sessionCreds("codex")).toEqual(refreshed);
    expect((await vault.status()).find((secret) => secret.kind === "chatgpt")?.error).toBe("ChatGPT refresh failed: 401 refresh_token_invalidated.");
    await ahead(vault, 31 * 60_000 + 2 * 60 * 60_000);
    expect(await vault.sessionCreds("codex")).toBeNull();
  });

  it("hands out the Claude token as it was saved", async () => {
    const vault = fresh();
    await vault.put("claude", SUBSCRIPTION, { oauthToken: "sk-ant-oat01-saved" });

    expect(await vault.sessionCreds("claude")).toEqual({ oauthToken: "sk-ant-oat01-saved" });
  });
});
