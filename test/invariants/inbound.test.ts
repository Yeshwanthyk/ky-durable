import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Credential, credentialFetch } from "../../src/inbound/credentials";
import { budget } from "../parity/kit";
import {
  HOOK_CAP,
  ORIGIN,
  PASS_MS,
  SEEN_MS,
  START,
  TIMEOUT_MS,
  VALUE,
  useTimingSafeEqual,
  world
} from "../parity/inbound/world";

fc.configureGlobal({ baseSize: "large" });

beforeEach(() => {
  useTimingSafeEqual();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const runs = () => ({ numRuns: budget().numRuns * 4, seed: budget().seed });

const BEARER = { origin: ORIGIN, scheme: "bearer", header: null, purpose: "the API" } as const;

const CREDENTIAL: Credential = { ...BEARER, value: VALUE };

type Ky = Awaited<ReturnType<typeof primed>>;

async function primed() {
  const time = { at: START };
  vi.spyOn(Date, "now").mockImplementation(() => time.at);
  const db = new DatabaseSync(":memory:");
  const ky = world(db);
  await ky.prime();
  ky.seen.told.splice(0);
  const [signed, plain] = ky.inbound.hooks().map((hook) => hook.id);

  if (signed === undefined || plain === undefined) throw new Error("prime adds two hooks");

  return { db, ky, time, signed, plain };
}

const tokenOf = (ky: Ky["ky"], id: string) => [...ky.tokens].find(([key, subject]) => key.startsWith("hook:") && subject === id)?.[0].slice("hook:".length) ?? "";

const secretOf = (ky: Ky["ky"], id: string) => ky.signings.get(id) ?? "";

const addedOf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ hook: Schema.Struct({ id: Schema.String }) })));

const hmac = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

type Sent = { readonly body?: string; readonly signature?: string; readonly delivery?: string; readonly token?: string; readonly length?: number };

function headersOf(signature: string | undefined, sent: Sent): Headers {
  const headers = new Headers({ "User-Agent": "ci" });

  if (signature !== undefined) headers.set("X-Hub-Signature-256", signature);

  if (sent.delivery !== undefined) headers.set("X-GitHub-Delivery", sent.delivery);

  if (sent.length !== undefined) headers.set("Content-Length", String(sent.length));

  return headers;
}

async function send(world: Ky, id: string, sent: Sent = {}): Promise<number> {
  const body = sent.body ?? '{"action":"opened"}';
  const signature = sent.signature ?? (id === world.signed ? hmac(secretOf(world.ky, id), body) : undefined);
  const shown = await world.ky.route("POST", `/hooks/${id}/${sent.token ?? tokenOf(world.ky, id)}`, body, headersOf(signature, sent));

  return shown?.status ?? 0;
}

async function each<T>(arbitrary: fc.Arbitrary<T>, check: (world: Ky, value: T) => Promise<void>): Promise<void> {
  await fc.assert(
    fc.asyncProperty(arbitrary, async (value) => {
      const made = await primed();

      try {
        await check(made, value);
      } finally {
        made.db.close();
      }
    }),
    runs()
  );
}

const told = (world: Ky) => world.ky.seen.told.length;

describe("a hook's delivery", () => {
  it("posted again within SEEN_MS is a replay (409) and tells no one; once SEEN_MS has passed it is new", async () => {
    const gaps = fc.oneof(fc.integer({ min: 0, max: SEEN_MS }), fc.integer({ min: SEEN_MS + 1, max: 3 * SEEN_MS }), fc.constantFrom(SEEN_MS, SEEN_MS + 1));

    await each(fc.record({ gap: gaps, signed: fc.boolean() }), async (world, { gap, signed }) => {
      const id = signed ? world.signed : world.plain;

      expect(await send(world, id, { delivery: "d1" })).toBe(202);
      world.time.at += gap;
      const before = told(world);

      expect(await send(world, id, { delivery: "d1" })).toBe(gap <= SEEN_MS ? 409 : 202);
      expect(told(world) - before).toBe(gap <= SEEN_MS ? 0 : 1);
    });
  });

  it("to a signed hook is known by its signature: the same post under a new delivery id is a replay; an unsigned post with no id never is", async () => {
    await each(fc.record({ ids: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }).filter((id) => id.trim() === id), { minLength: 2, maxLength: 2 }), body: fc.string({ maxLength: 40 }) }), async (world, { ids, body }) => {
      expect(await send(world, world.signed, { body, delivery: ids[0] })).toBe(202);
      expect(await send(world, world.signed, { body, delivery: ids[1] })).toBe(409);
      expect(await send(world, world.plain, { body })).toBe(202);
      expect(await send(world, world.plain, { body })).toBe(202);
    });
  });

  it("to a signed hook is taken only with the HMAC-SHA256 of its body under the hook's signing secret; else 401 and no one is told", async () => {
    const signatures = fc.oneof(
      fc.constant({ good: true }),
      fc.constant({ none: true }),
      fc.string({ maxLength: 20 }).map((key) => ({ key })),
      fc.stringMatching(/^sha256=[0-9a-f]{64}$/).map((raw) => ({ raw }))
    );

    await each(fc.record({ body: fc.string({ maxLength: 60 }), signature: signatures }), async (world, { body, signature }) => {
      const secret = secretOf(world.ky, world.signed);
      const sent = "good" in signature ? hmac(secret, body) : "none" in signature ? "" : "raw" in signature ? signature.raw : hmac(`${secret}${signature.key}x`, body);
      const good = sent === hmac(secret, body);

      expect(await send(world, world.signed, { body, signature: sent })).toBe(good ? 202 : 401);
      expect(told(world)).toBe(good ? 1 : 0);
    });
  });

  it("with any token but its own hook's is 404 and reaches no chat, a rotated-out token too", async () => {
    const tokens = fc.oneof(fc.constantFrom("other" as const, "rotated" as const), fc.stringMatching(/^[0-9a-f]{64}$/));

    await each(tokens, async (world, kind) => {
      const old = tokenOf(world.ky, world.plain);

      if (kind === "rotated") await world.ky.route("POST", `/api/inbound/hooks/${world.plain}/rotate`);
      const token = kind === "other" ? tokenOf(world.ky, world.signed) : kind === "rotated" ? old : kind;

      expect(await send(world, world.plain, { token })).toBe(token === tokenOf(world.ky, world.plain) ? 202 : 404);
      expect(told(world)).toBe(token === tokenOf(world.ky, world.plain) ? 1 : 0);
    });
  });

  it("from a sender over its rate gets 429 before anything is read or told", async () => {
    await each(fc.boolean(), async (world, limited) => {
      await world.ky.apply({ limited });

      expect(await send(world, world.plain, { delivery: "d1" })).toBe(limited ? 429 : 202);
      expect(told(world)).toBe(limited ? 0 : 1);
    });
  });

  it(`is at most HOOK_CAP: one byte over is 413, and so is a Content-Length that says over`, async () => {
    const sizes = fc.oneof(fc.constantFrom(HOOK_CAP - 1, HOOK_CAP, HOOK_CAP + 1), fc.integer({ min: 0, max: HOOK_CAP + 4_096 }));

    await each(fc.record({ size: sizes, lies: fc.boolean() }), async (world, { size, lies }) => {
      const over = size > HOOK_CAP || lies;

      expect(await send(world, world.plain, { body: "z".repeat(size), length: lies ? HOOK_CAP + 1 : undefined })).toBe(over ? 413 : 202);
      expect(told(world)).toBe(over ? 0 : 1);
    });
  });

  it("taken sets the hook's lastAt to its time; a replay or a refusal leaves it", async () => {
    await each(fc.array(fc.record({ gap: fc.integer({ min: 0, max: 60_000 }), delivery: fc.constantFrom("a", "b", "c"), limited: fc.boolean() }), { maxLength: 8 }), async (world, posts) => {
      const seen = new Set<string>();
      let last: number | null = null;

      for (const post of posts) {
        world.time.at += post.gap;
        await world.ky.apply({ limited: post.limited });
        const taken = !post.limited && !seen.has(post.delivery);

        expect(await send(world, world.plain, { delivery: post.delivery })).toBe(post.limited ? 429 : taken ? 202 : 409);

        if (taken) {
          seen.add(post.delivery);
          last = world.time.at;
        }

        expect(world.ky.inbound.hook(world.plain)?.lastAt).toBe(last);
      }
    });
  });
});

describe("a hook", () => {
  it("reads back as added: its label trimmed to 80, or Webhook; signed as asked; created at the clock's time", async () => {
    await each(fc.record({ label: fc.string({ maxLength: 120 }), signed: fc.boolean(), gap: fc.integer({ min: 0, max: 60_000 }) }), async (world, { label, signed, gap }) => {
      world.time.at += gap;
      const added = await world.ky.route("POST", "/api/inbound/hooks", JSON.stringify({ session: "1", label, signed }));
      const id = added === null ? "" : addedOf(added.body).hook.id;

      expect(world.ky.inbound.hook(id)).toEqual({ id, session: "1", label: label.trim().slice(0, 80) || "Webhook", signed, createdAt: START + gap, lastAt: null });
    });
  });
});

describe("a credential ask", () => {
  it("reads back as asked, the latest per name, in the order asked", async () => {
    const infos = fc.oneof(
      fc.constant(BEARER),
      fc.constant({ origin: ORIGIN, scheme: "basic", header: null, purpose: "basic" } as const),
      fc.stringMatching(/^X-[A-Za-z]{1,8}$/).map((header) => ({ origin: ORIGIN, scheme: "header", header, purpose: `by ${header}` }) as const)
    );

    await each(fc.array(fc.record({ name: fc.constantFrom("A", "B", "C"), info: infos }), { maxLength: 8 }), async (world, asks) => {
      const model = new Map<string, unknown>();

      for (const ask of asks) {
        world.time.at += 1_000;
        world.ky.inbound.ask("1", ask.name, ask.info);
        model.delete(ask.name);
        model.set(ask.name, { session: "1", name: ask.name, ...ask.info, at: world.time.at, owner: "ky", asker: null });
      }

      expect(world.ky.inbound.asks("1")).toEqual([...model.values()]);
    });
  });
});

describe("a saved secret's body", () => {
  it("is { session, name, value } of strings: anything else is 400 and puts nothing in the Vault", async () => {
    const field = fc.oneof(fc.constant(undefined), fc.integer(), fc.boolean(), fc.constant(null), fc.constant([]));
    const bodies = fc.record({ session: fc.oneof(fc.constant("0"), field), name: fc.oneof(fc.constant("API_KEY"), field), value: fc.oneof(fc.constant(VALUE), field) });

    await each(bodies, async (world, body) => {
      world.ky.inbound.ask("0", "API_KEY", BEARER);
      const puts = world.ky.seen.vault.length;
      const strings = [body.session, body.name, body.value].every(Schema.is(Schema.String));
      const shown = await world.ky.route("POST", "/api/inbound/secrets", JSON.stringify(body));

      expect(shown?.status).toBe(strings ? 204 : 400);
      expect(world.ky.seen.vault.length - puts).toBe(strings ? 1 : 0);
    });
  });
});

const OWN = { conversation: "0", tool: 0, args: 0 } as const;

describe("an accepted webhook action", () => {
  it("lets exactly its call through once, in its own conversation, within PASS_MS; any other call, or later, waits again", async () => {
    const gaps = fc.oneof(fc.integer({ min: 0, max: PASS_MS }), fc.integer({ min: PASS_MS + 1, max: 4 * PASS_MS }), fc.constantFrom(PASS_MS, PASS_MS + 1));
    const calls = fc.array(fc.record({ conversation: fc.constantFrom("0", "1"), tool: fc.constantFrom(0, 1), args: fc.constantFrom(0, 1) }), { minLength: 1, maxLength: 4 });

    await each(fc.record({ gap: gaps, calls }), async (world, { gap, calls }) => {
      await world.ky.apply({ askApproval: "webhook-action", conversation: "0", tool: 0, args: 0, url: 0, good: true });
      await world.ky.apply({ decide: -1, action: "accept" });
      world.time.at += gap;
      let open = gap <= PASS_MS;

      for (const call of [...calls, OWN, OWN]) {
        const own = call.conversation === "0" && call.tool === 0 && call.args === 0;

        expect(await world.ky.apply({ passed: call.conversation, tool: call.tool, args: call.args, fresh: false })).toBe(open && own);

        if (own) open = false;
      }
    });
  });
});

describe("a run", () => {
  it("is guarded while any input placed in it came from a webhook: a delivery, a decision on one, or its card", async () => {
    const requests = fc.constantFrom<"hook" | "decided" | "card" | "user" | "approval">("hook", "decided", "card", "user", "approval");

    await each(fc.array(requests, { maxLength: 5 }), async (world, placed) => {
      await world.ky.apply({ newRun: "1" });

      for (const request of placed) await world.ky.apply({ place: "1", request });

      expect(world.ky.inbound.guarded("1")).toBe(placed.some((request) => request === "hook" || request === "decided" || request === "card"));
    });
  });
});

function fetcher(status: number) {
  const calls: RequestInit[] = [];

  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});

    const redirect = status >= 300 && status < 400;

    return new Response(redirect || status === 204 || status === 205 ? null : "fine", { status, headers: redirect ? { Location: ORIGIN } : {} });
  };

  return { calls, fetch };
}

function sameOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);

    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && `${parsed.protocol}//${parsed.host}` === ORIGIN;
  } catch {
    return false;
  }
}

describe("a call with a credential", () => {
  it("goes only to the credential's https origin: any other URL is refused unsent and nothing is fetched", async () => {
    const urls = fc.oneof(
      fc.constantFrom(`${ORIGIN}/v1/me`, "https://evil.example.com/", "http://api.example.com/", "https://user:pw@api.example.com/", "https://api.example.com:8443/", "not a url"),
      fc.webUrl({ withQueryParameters: true }),
      fc.webPath().map((path) => `${ORIGIN}${path}`)
    );

    await fc.assert(
      fc.asyncProperty(urls, async (url) => {
        const { calls, fetch } = fetcher(200);
        const answer = await credentialFetch(fetch, CREDENTIAL, { url, method: "GET", headers: {}, body: null });

        expect("refused" in answer && !answer.sent).toBe(!sameOrigin(url));
        expect(calls.length).toBe(sameOrigin(url) ? 1 : 0);
      }),
      runs()
    );
  });

  it("never follows a redirect: it asks for manual redirects, and a 3xx is refused as sent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 200, max: 599 }), async (status) => {
        const { calls, fetch } = fetcher(status);
        const answer = await credentialFetch(fetch, CREDENTIAL, { url: `${ORIGIN}/v1`, method: "GET", headers: {}, body: null });

        expect(calls.map((call) => call.redirect)).toEqual(["manual"]);
        expect("refused" in answer && answer.sent).toBe(status >= 300 && status < 400);
      }),
      runs()
    );
  });

  it("is cut off after TIMEOUT_MS", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("GET", "POST", "PUT"), async (method) => {
        const timeout = vi.spyOn(AbortSignal, "timeout");
        const { fetch } = fetcher(200);

        await credentialFetch(fetch, CREDENTIAL, { url: `${ORIGIN}/v1`, method, headers: {}, body: null });

        expect(timeout.mock.calls).toEqual([[TIMEOUT_MS]]);
        timeout.mockRestore();
      }),
      runs()
    );
  });
});
