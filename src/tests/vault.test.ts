import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { Vault } from "../vault";

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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const code = await vault.mint("pair", "code", 50);
    const lasting = await vault.mint("pair", "lasting", 60_000);

    expect(await vault.check("pair", code)).toBe("code");
    await pause(100);

    expect(await vault.check("pair", code)).toBeNull();
    expect(await vault.check("pair", lasting)).toBe("lasting");

    await vault.mint("machine", "mac");

    const subjects = await inside(vault, (_instance, state) =>
      state.storage.sql.exec<{ subject: string }>("SELECT subject FROM ky_vault_tokens ORDER BY subject").toArray()
    );

    expect(subjects.map((row) => row.subject)).toEqual(["lasting", "mac"]);
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
      instance.put("chatgpt", "codex", { ...CODEX, accessToken: "signed-in-again" });
      done.open({ ...CODEX, accessToken: "stale" });

      return refresh;
    });

    expect(afterPut).toEqual({ ...CODEX, accessToken: "signed-in-again" });

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

  it("keeps a failed refresh's error on the secret until it is next written, and runs nothing for a missing one", async () => {
    const vault = fresh();
    await vault.put("chatgpt", "codex", CODEX);

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
      { kind: "chatgpt", id: "codex", meta: null, updatedAt: expect.any(Number), error: "refresh token rejected" }
    ]);

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

  it("says what S and K have yet to set up: no credentials, and no ChatGPT sign-in", async () => {
    const vault = fresh();

    expect(await vault.auth("anthropic")).toBeNull();
    expect(await vault.sessionCreds("codex")).toBeNull();
    expect(await vault.githubToken()).toBeNull();
    // From inside: a throw over RPC also surfaces as an unhandled rejection in vitest-pool-workers.
    await inside(vault, (instance) => {
      expect(() => instance.chatgptLogin()).toThrow("not set up");
      expect(() => instance.chatgptPoll("login")).toThrow("not set up");
    });
  });
});
