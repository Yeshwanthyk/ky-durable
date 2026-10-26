import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Deliveries } from "../../src/automations/delivery";
import type { PushDevice } from "../../src/push/contract";
import { Pushes as LegacyPushes } from "../../src/push/legacy/push";
import { base64url, encrypt, fromBase64url, vapidToken } from "../../src/push/webpush";
import { Pushes } from "../../src/push/wiring";
import { assertParity, budget, type Clock, type Instance, type Json, type Parity } from "../parity/kit";
import { StoredRow, storageOf } from "../parity/skills/storage";

/**
 * Web Push (src/push/), over generated runs on a real SQLite: posts handed to Delivery (src/automations/delivery.ts)
 * one at a time or several at once, devices subscribing, subscribing again with new keys and unsubscribing, push
 * services that take a push, refuse it, say the device is gone (404, 410) or never answer, the right-away number
 * changing, ky not knowing its address yet, and the clock crossing local midnights in zones from UTC-11 to UTC+14,
 * daylight saving and half hours included. Whatever happens:
 *
 * - every post is in its chat, pushed or not;
 * - a post pushes exactly when a device is subscribed and fewer than the right-away number of posts were taken by a
 *   device that local day, counting the posts already on their way: never more than that number a day;
 * - the day's count is the posts a device took, so a push no device took gives its place back, and only the last
 *   day a post was counted on is kept;
 * - a device its push service said is gone is never tried again, until it subscribes again;
 * - a device is kept with the keys it last subscribed with, from the time it first subscribed;
 * - a subscription that isn't https, or whose keys aren't a P-256 key and a 16-byte secret, is refused in B's words;
 * - each push is one aes128gcm record the device opens with its own key, signed for its push service's origin.
 *
 * And for any payload a record holds (RFC 8291 §4: 3993 bytes), what the device opens is what ky sent.
 * While src/push/legacy exists, the port also answers, stores and pushes what B does, step for step.
 */

const encoder = new TextEncoder();

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

const ENDPOINTS = ["https://fcm.test/send/a", "https://fcm.test/send/b", "https://web.push.apple.test/c"] as const;

const ZONES = [null, "UTC", "America/Los_Angeles", "Pacific/Pago_Pago", "Pacific/Kiritimati", "Asia/Kathmandu", "America/St_Johns", "Australia/Lord_Howe", "Europe/London", "America/Santiago", "Asia/Beirut"] as const;

const HOUR = 3_600_000;

const ORIGIN = "https://ky.example.com";

const KEYS = 2;

type Answer = "ok" | "refused" | "gone" | "lost" | "rekeyed" | "unreachable";

const STATUS: Record<Exclude<Answer, "unreachable">, number> = { ok: 201, refused: 500, gone: 410, lost: 404, rekeyed: 403 };

const DROPS = new Set<Answer | undefined>(["gone", "lost", "rekeyed"]);

type Op =
  | { readonly op: "subscribe"; readonly device: number; readonly keys: number }
  | { readonly op: "unsubscribe"; readonly device: number }
  | { readonly op: "advance"; readonly ms: number }
  | { readonly op: "most"; readonly most: number }
  | { readonly op: "origin"; readonly known: boolean }
  | { readonly op: "post"; readonly answers: readonly (readonly Answer[])[] };

const anAnswer = fc.oneof({ weight: 8, arbitrary: fc.constant<Answer>("ok") }, { weight: 1, arbitrary: fc.constantFrom<Answer>("refused", "gone", "lost", "rekeyed", "unreachable") });

const aDevice = fc.integer({ min: 0, max: ENDPOINTS.length - 1 });

const aKeys = fc.integer({ min: 0, max: KEYS - 1 });

const anOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ op: fc.constant("post" as const), answers: fc.array(fc.array(anAnswer, { minLength: 3, maxLength: 3 }), { minLength: 1, maxLength: 4 }) }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("advance" as const), ms: fc.oneof(fc.integer({ min: 0, max: 2 * HOUR }), fc.integer({ min: 0, max: 30 * HOUR }), fc.constantFrom(HOUR, 24 * HOUR, 60_000)) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("subscribe" as const), device: aDevice, keys: aKeys }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("unsubscribe" as const), device: aDevice }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("most" as const), most: fc.oneof(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 24 })) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("origin" as const), known: fc.boolean() }) }
);

const aStart = fc.oneof(fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }), fc.constantFrom(Date.UTC(2026, 3, 5, 2, 30), Date.UTC(2026, 9, 24, 20, 30)));

const anEndpoint = fc
  .tuple(fc.domain(), fc.option(fc.nat({ max: 65_535 }), { nil: undefined }), fc.array(fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-._~".split("")) }), { maxLength: 4 }))
  .map(([host, port, path]) => `https://${host}${port === undefined ? "" : `:${port}`}/${path.join("/")}`);

type SqlFake = ConstructorParameters<typeof Deliveries>[0];

function sqlStorage(db: DatabaseSync): SqlFake {
  const exec = (query: string, ...bindings: SQLInputValue[]) => {
    const rows = db.prepare(query).all(...bindings);

    return { toArray: () => rows.map((row) => ({ ...row })) };
  };

  // SAFETY: B's Pushes and Deliveries call exec and read toArray, nothing else of SqlStorage or its cursor.
  return { exec, databaseSize: 0 } as SqlFake;
}

function dayIn(zone: string | null, now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: BufferSource, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);

  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

type Subscriber = { readonly device: (endpoint: string) => PushDevice; readonly keys: CryptoKeyPair; readonly auth: Uint8Array<ArrayBuffer> };

async function aSubscriber(): Promise<Subscriber> {
  const keys = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));

  return { device: (endpoint) => ({ endpoint, p256dh, auth: base64url(auth) }), keys, auth };
}

type Opened = { readonly rs: number; readonly idLength: number; readonly sealedLength: number; readonly delimiter: number | undefined; readonly payload: Uint8Array };

async function open(body: Uint8Array<ArrayBuffer>, subscriber: Subscriber): Promise<Opened> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idLength = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idLength);
  const sealed = body.slice(21 + idLength);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", subscriber.keys.publicKey));
  const sender = await crypto.subtle.importKey("raw", asPublic, ECDH, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, subscriber.keys.privateKey, 256);
  const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(subscriber.auth, shared, info, 32);
  const cek = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["decrypt"]);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cek, sealed));
  let end = plain.length - 1;

  while (end >= 0 && plain[end] === 0) end--;

  return { rs, idLength, sealedLength: sealed.length, delimiter: plain[end], payload: plain.slice(0, Math.max(end, 0)) };
}

const Head = Schema.Struct({ typ: Schema.String, alg: Schema.String });

const Claims = Schema.Struct({ aud: Schema.String, exp: Schema.Number, sub: Schema.String });

function jwt(token: string) {
  const [head = "", claims = "", signature = ""] = token.split(".");
  const text = (part: string) => new TextDecoder().decode(fromBase64url(part));

  return {
    head: Schema.decodeUnknownSync(Schema.fromJsonString(Head))(text(head)),
    claims: Schema.decodeUnknownSync(Schema.fromJsonString(Claims))(text(claims)),
    signed: `${head}.${claims}`,
    signature: fromBase64url(signature)
  };
}

const DeviceStored = Schema.Struct({ endpoint: Schema.String, p256dh: Schema.String, auth: Schema.String, created_at: Schema.Number });

const SentStored = Schema.Struct({ day: Schema.String, sent: Schema.Number });

const devicesOf = (db: DatabaseSync) => Schema.decodeUnknownSync(Schema.Array(DeviceStored))(db.prepare("SELECT * FROM ky_push_devices ORDER BY endpoint").all());

const sentOf = (db: DatabaseSync) => Schema.decodeUnknownSync(Schema.Array(SentStored))(db.prepare("SELECT * FROM ky_push_sent ORDER BY day").all());

let keyring: Subscriber[][] = [];

let vapid: CryptoKeyPair;

let vapidPublic: string;

let clockAt: () => number = () => 0;

beforeAll(async () => {
  keyring = await Promise.all(ENDPOINTS.map(() => Promise.all(Array.from({ length: KEYS }, () => aSubscriber()))));
  vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  vapidPublic = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey)));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(Date, "now").mockImplementation(() => clockAt());
});

afterAll(() => vi.restoreAllMocks());

const subscriberOf = (device: number, keys: number): Subscriber => {
  const subscriber = keyring[device]?.[keys];

  if (!subscriber) throw new Error(`No keys ${keys} for device ${device}`);

  return subscriber;
};

const signer = () => ({ vapidKey: async () => vapidPublic, vapidAuth: async (audience: string, subject: string) => `vapid t=${await vapidToken(vapid.privateKey, audience, subject, Date.now())}, k=${vapidPublic}` });

type Tried = { readonly endpoint: string; readonly post: string };

const byPost = (a: Tried, b: Tried) => `${a.post} ${a.endpoint}`.localeCompare(`${b.post} ${b.endpoint}`);

function pushProblems(endpoint: string, headers: Headers, origin: string | null, now: number): string[] {
  const [, token = "", key = ""] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.get("authorization") ?? "") ?? [];
  const { head, claims } = jwt(token);

  const checks: readonly (readonly [boolean, string])[] = [
    [headers.get("content-encoding") === "aes128gcm" && headers.has("ttl"), `headers ${[...headers].join(";")}`],
    [key === vapidPublic && head.alg === "ES256" && head.typ === "JWT", `token head ${token}`],
    [claims.aud === new URL(endpoint).origin && claims.sub === origin, `claims ${JSON.stringify(claims)}`],
    [claims.exp > now / 1000 && claims.exp <= now / 1000 + 86_400, `exp ${claims.exp} at ${now}`]
  ];

  return checks.flatMap(([ok, problem]) => (ok ? [] : [problem]));
}

class World {
  readonly db = new DatabaseSync(":memory:");
  readonly posted: string[] = [];
  readonly tried: Tried[] = [];
  readonly later: Promise<unknown>[] = [];
  readonly pushes: Pushes;
  readonly deliveries: Deliveries;
  now: number;
  most = 6;
  origin: string | null = ORIGIN;
  readonly held = ENDPOINTS.map(() => 0);
  readonly answers = new Map<string, readonly Answer[]>();
  readonly problems: string[] = [];
  readonly zone: string | null;

  constructor(zone: string | null, start: number) {
    this.zone = zone;
    this.now = start;
    clockAt = () => this.now;

    this.pushes = new Pushes(storageOf(this.db), { vault: signer, zone: () => this.zone, most: () => this.most, title: () => "ky", origin: () => this.origin });
    this.pushes.fetch = (input, init) => this.#service(String(input), init);

    this.deliveries = new Deliveries(sqlStorage(this.db), {
      surfaced: { shown: () => undefined },
      submit: async () => true,
      post: async (_session, text) => {
        this.posted.push(text);

        return true;
      },
      notify: (session, text) => this.pushes.notify(session, text),
      idle: async () => undefined,
      later: (promise) => void this.later.push(promise)
    });
  }

  async #service(endpoint: string, init: RequestInit): Promise<Response> {
    const index = ENDPOINTS.findIndex((each) => each === endpoint);
    const subscriber = subscriberOf(index, this.held[index] ?? 0);
    const headers = new Headers(init.headers);
    const opened = await open(new Uint8Array(await new Response(init.body).arrayBuffer()), subscriber);
    const [, , post = ""] = new TextDecoder().decode(opened.payload).split("\n");
    this.problems.push(...pushProblems(endpoint, headers, this.origin, this.now));
    this.tried.push({ endpoint, post });
    const answer = this.answers.get(post)?.[index] ?? "ok";

    if (answer === "unreachable") throw new TypeError("fetch failed");

    return new Response(null, { status: STATUS[answer] });
  }

  sent(day: string): number {
    return sentOf(this.db).find((row) => row.day === day)?.sent ?? 0;
  }

  async settle(): Promise<void> {
    while (this.later.length > 0) await Promise.all(this.later.splice(0));
  }
}

class Model {
  readonly devices = new Map<number, { keys: number; since: number }>();
  readonly took = new Map<string, number>();
  readonly gone = new Set<number>();
  counted: string | undefined;
}

let posts = 0;

const reached = { pushed: 0, capped: 0, released: 0, gone: 0, days: 0, unknown: 0, rekeyed: 0 };

async function handOver(world: World, answers: readonly (readonly Answer[])[]): Promise<string[]> {
  const texts = answers.map((each) => {
    const text = `post ${++posts}`;
    world.answers.set(text, each);

    return text;
  });

  for (const text of texts) await world.deliveries.deliver({ id: text, session: "1", content: text, line: text, ref: "memory:1", kind: "look" }, world.now);
  await world.settle();

  return texts;
}

const subscribed = (model: Model) => [...model.devices.keys()].sort((a, b) => a - b);

function mayPush(world: World, model: Model, texts: readonly string[], before: number): string[] {
  const room = model.devices.size === 0 ? 0 : Math.max(0, Math.min(texts.length, world.most - before));

  if (model.devices.size > 0 && room < texts.length) reached.capped++;

  if (world.origin === null && room > 0) reached.unknown++;

  return world.origin === null ? [] : texts.slice(0, room);
}

function expectTried(world: World, model: Model, pushing: readonly string[], from: number): void {
  const expected = pushing.flatMap((post) => subscribed(model).map((device) => ({ endpoint: ENDPOINTS[device] ?? "", post })));
  const tried = world.tried.slice(from);

  expect([...tried].sort(byPost)).toEqual([...expected].sort(byPost));

  for (const each of tried) expect(model.gone.has(ENDPOINTS.findIndex((endpoint) => endpoint === each.endpoint))).toBe(false);
}

function settleModel(world: World, model: Model, pushing: readonly string[]): number {
  const devices = subscribed(model);
  const answer = (post: string, device: number) => world.answers.get(post)?.[device];
  const took = pushing.filter((post) => devices.some((device) => answer(post, device) === "ok")).length;

  for (const device of devices.filter((each) => pushing.some((post) => DROPS.has(answer(post, each))))) {
    model.devices.delete(device);
    model.gone.add(device);
    reached.gone++;
  }

  reached.pushed += took;
  reached.released += pushing.length - took;

  return took;
}

async function postAll(world: World, model: Model, answers: readonly (readonly Answer[])[], full: string | undefined): Promise<string | undefined> {
  const day = dayIn(world.zone, world.now);
  const before = model.took.get(day) ?? 0;
  const from = world.tried.length;
  const counts = model.devices.size > 0 && world.most >= 1;
  const texts = await handOver(world, answers);
  const pushing = mayPush(world, model, texts, before);

  if (full !== undefined && full !== day && model.devices.size > 0) reached.days++;

  expectTried(world, model, pushing, from);
  const count = before + settleModel(world, model, pushing);
  model.took.set(day, count);

  if (counts) model.counted = day;

  expect(world.sent(day)).toBe(count);
  expect(count).toBeLessThanOrEqual(Math.max(world.most, before));

  return count >= Math.max(world.most, 1) ? day : full;
}

function apply(world: World, model: Model, op: Exclude<Op, { op: "post" }>): void {
  if (op.op === "advance") world.now += op.ms;
  else if (op.op === "most") world.most = op.most;
  else if (op.op === "origin") world.origin = op.known ? ORIGIN : null;
  else if (op.op === "subscribe") {
    const was = model.devices.get(op.device);

    if (was !== undefined && was.keys !== op.keys) reached.rekeyed++;
    world.pushes.subscribe(subscriberOf(op.device, op.keys).device(ENDPOINTS[op.device] ?? ""));
    world.held[op.device] = op.keys;
    model.devices.set(op.device, { keys: op.keys, since: was?.since ?? world.now });
    model.gone.delete(op.device);
  } else {
    world.pushes.unsubscribe(ENDPOINTS[op.device] ?? "");
    model.devices.delete(op.device);
  }
}

function expectEnd(world: World, model: Model, ops: readonly Op[]): void {
  expect(world.problems).toEqual([]);
  expect(world.posted.length).toBe(ops.reduce((count, op) => count + (op.op === "post" ? op.answers.length : 0), 0));

  const kept = subscribed(model).map((device) => {
    const { keys, since } = model.devices.get(device) ?? { keys: 0, since: 0 };
    const endpoint = ENDPOINTS[device] ?? "";

    return { ...subscriberOf(device, keys).device(endpoint), created_at: since };
  });

  expect(devicesOf(world.db)).toEqual(kept);
  expect(sentOf(world.db)).toEqual(model.counted === undefined ? [] : [{ day: model.counted, sent: model.took.get(model.counted) ?? 0 }]);
}

async function play(zone: string | null, start: number, most: number, ops: readonly Op[]): Promise<void> {
  const world = new World(zone, start);
  const model = new Model();
  let full: string | undefined;
  world.most = most;

  for (const op of ops) {
    if (op.op === "post") full = await postAll(world, model, op.answers, full);
    else apply(world, model, op);
  }

  expectEnd(world, model, ops);
}

describe("pushes", () => {
  it("go out for every post a device can take, up to the right-away number a local day counting only what a device took, never to a device that's gone", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ZONES), aStart, fc.constantFrom(6, 1, 2, 3), fc.array(anOp, { maxLength: 40 }), (zone, start, most, ops) =>
        play(zone, start, most, [{ op: "subscribe", device: 0, keys: 0 }, ...ops])
      ),
      { numRuns: Math.max(200, budget().numRuns), seed: budget().seed }
    );

    expect(Object.values(reached).every((count) => count > 0), JSON.stringify(reached)).toBe(true);
  });
});

type Part<T> = { readonly value: T; readonly ok: boolean };

const anHttpsEndpoint: fc.Arbitrary<Part<string>> = fc.oneof(
  anEndpoint.map((value) => ({ value, ok: true })),
  fc.constantFrom("http://fcm.test/send/a", "wss://fcm.test/a", "fcm.test/send/a", "", "https//fcm.test").map((value) => ({ value, ok: false }))
);

const aPublicKey: fc.Arbitrary<Part<string>> = fc.oneof(
  fc.tuple(fc.constantFrom(4, 3), fc.uint8Array({ minLength: 63, maxLength: 65 })).map(([first, rest]) => ({ value: base64url(Uint8Array.of(first, ...rest)), ok: first === 4 && rest.length === 64 })),
  fc.constantFrom("", "not*base64", "%%%").map((value) => ({ value, ok: false }))
);

const aSecret: fc.Arbitrary<Part<string>> = fc.oneof(
  fc.uint8Array({ minLength: 14, maxLength: 18 }).map((bytes) => ({ value: base64url(bytes), ok: bytes.length === 16 })),
  fc.constantFrom("", "%%%").map((value) => ({ value, ok: false }))
);

function refusalOf(subscribe: () => void): string | null {
  try {
    subscribe();

    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("a subscription", () => {
  it("I-P1: is kept only when its endpoint is https and its keys are a P-256 key and a 16-byte secret; else it's refused in B's words and nothing is kept", () => {
    fc.assert(
      fc.property(anHttpsEndpoint, aPublicKey, aSecret, (endpoint, p256dh, auth) => {
        const db = new DatabaseSync(":memory:");
        const pushes = new Pushes(storageOf(db), { vault: signer, zone: () => null, most: () => 6, title: () => "ky", origin: () => ORIGIN });
        const expected = !endpoint.ok ? "A push endpoint is an https address." : !(p256dh.ok && auth.ok) ? "A push subscription's keys aren't a P-256 key and a 16-byte secret." : null;

        expect(refusalOf(() => pushes.subscribe({ endpoint: endpoint.value, p256dh: p256dh.value, auth: auth.value }))).toBe(expected);
        expect(devicesOf(db).map((row) => row.endpoint)).toEqual(expected === null ? [endpoint.value] : []);
        db.close();
      }),
      { numRuns: Math.max(200, budget().numRuns), seed: budget().seed }
    );
  });
});

describe("a push's record", () => {
  it("opens with the device's key to the payload ky sent, for any payload one record holds", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 3993 }), fc.uint8Array({ minLength: 16, maxLength: 16 }), async (payload, salt) => {
        const subscriber = await aSubscriber();
        const sender = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
        const body = await encrypt(payload, subscriber.device(ENDPOINTS[0]), sender, new Uint8Array(salt));
        const opened = await open(body, subscriber);

        expect(base64url(body.slice(0, 16))).toBe(base64url(salt));
        expect([opened.rs, opened.idLength, opened.delimiter]).toEqual([4096, 65, 2]);
        expect(opened.sealedLength).toBeLessThanOrEqual(opened.rs);
        expect(body.length).toBeLessThanOrEqual(4096);
        expect(base64url(opened.payload)).toBe(base64url(payload));
      }),
      { numRuns: 60, seed: budget().seed }
    );
  });

  it("is signed ES256 for its push service's origin, for at most a day, and verifies with ky's public key", async () => {
    await fc.assert(
      fc.asyncProperty(anEndpoint, fc.integer({ min: 0, max: Date.UTC(2100, 0, 1) }), async (endpoint, now) => {
        const audience = new URL(endpoint).origin;
        const { head, claims, signed, signature } = jwt(await vapidToken(vapid.privateKey, audience, ORIGIN, now));
        const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vapid.publicKey, signature, encoder.encode(signed));

        expect(head).toEqual({ typ: "JWT", alg: "ES256" });
        expect([claims.aud, claims.sub]).toEqual([audience, ORIGIN]);
        expect(claims.exp).toBeGreaterThan(now / 1000);
        expect(claims.exp).toBeLessThanOrEqual(now / 1000 + 86_400);
        expect(signature.length).toBe(64);
        expect(verified).toBe(true);
      }),
      { numRuns: 100, seed: budget().seed }
    );
  });
});

type Action =
  | { readonly subscribe: number; readonly keys: number }
  | { readonly subscribeBad: "http" | "short-secret" | "not-a-key" }
  | { readonly unsubscribe: number }
  | { readonly notify: string; readonly session: string; readonly answers: readonly Answer[] }
  | { readonly most: number }
  | { readonly origin: boolean }
  | { readonly zone: string | null };

const actions: fc.Arbitrary<Action> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ subscribe: aDevice, keys: aKeys }) },
  { weight: 1, arbitrary: fc.record({ subscribeBad: fc.constantFrom<"http" | "short-secret" | "not-a-key">("http", "short-secret", "not-a-key") }) },
  { weight: 1, arbitrary: fc.record({ unsubscribe: aDevice }) },
  {
    weight: 5,
    arbitrary: fc.record({
      notify: fc.constantFrom("Rent is due Friday.", "  Two\n\tlines  ", "🙂".repeat(130), "x".repeat(120), "x".repeat(121), ""),
      session: fc.constantFrom("1", "side chat"),
      answers: fc.array(anAnswer, { minLength: 3, maxLength: 3 })
    })
  },
  { weight: 1, arbitrary: fc.record({ most: fc.integer({ min: 0, max: 4 }) }) },
  { weight: 1, arbitrary: fc.record({ origin: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ zone: fc.constantFrom(...ZONES) }) }
);

function badDevice(kind: "http" | "short-secret" | "not-a-key"): PushDevice {
  const good = subscriberOf(0, 0).device(ENDPOINTS[0]);

  if (kind === "http") return { ...good, endpoint: "http://fcm.test/send/a" };

  if (kind === "short-secret") return { ...good, auth: base64url(new Uint8Array(8)) };

  return { ...good, p256dh: "not*a*key" };
}

type Side = Pick<Pushes, "subscribe" | "unsubscribe" | "notify"> & { fetch: Pushes["fetch"] };

type Parts = ConstructorParameters<typeof Pushes>[1];

type SideState = { most: number; origin: boolean; zone: string | null; answers: readonly Answer[] };

const rowsDecoded = Schema.decodeUnknownSync(Schema.Array(StoredRow));

function side(make: (db: DatabaseSync, parts: Parts) => Side): Instance<Action> {
  const db = new DatabaseSync(":memory:");
  const state: SideState = { most: 6, origin: true, zone: null, answers: [] };
  const held = ENDPOINTS.map(() => 0);
  const effects: { readonly endpoint: string; readonly [key: string]: Json }[] = [];

  const pushes = make(db, {
    vault: signer,
    zone: () => state.zone,
    most: () => state.most,
    title: (session) => (session === "1" ? "ky" : session),
    origin: () => (state.origin ? ORIGIN : null)
  });

  pushes.fetch = async (endpoint, init) => {
    const index = ENDPOINTS.findIndex((each) => each === endpoint);
    const headers = new Headers(init.headers);
    const opened = await open(new Uint8Array(await new Response(init.body).arrayBuffer()), subscriberOf(index, held[index] ?? 0));
    const [, token = ""] = /^vapid t=([^,]+), k=/.exec(headers.get("authorization") ?? "") ?? [];
    const answer = state.answers[index] ?? "ok";
    effects.push({ endpoint, payload: new TextDecoder().decode(opened.payload), ttl: headers.get("ttl"), encoding: headers.get("content-encoding"), claims: jwt(token).claims, answer });

    if (answer === "unreachable") throw new TypeError("fetch failed");

    return new Response("busy", { status: STATUS[answer] });
  };

  const rows = (table: string) => rowsDecoded(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

  return {
    apply: async (action) => {
      if ("subscribe" in action) {
        const refused = refusalOf(() => pushes.subscribe(subscriberOf(action.subscribe, action.keys).device(ENDPOINTS[action.subscribe] ?? "")));

        if (refused === null) held[action.subscribe] = action.keys;

        return refused === null ? null : { refused };
      }

      if ("subscribeBad" in action) {
        const refused = refusalOf(() => pushes.subscribe(badDevice(action.subscribeBad)));

        return refused === null ? null : { refused };
      }

      if ("unsubscribe" in action) pushes.unsubscribe(ENDPOINTS[action.unsubscribe] ?? "");
      else if ("notify" in action) {
        state.answers = action.answers;
        await pushes.notify(action.session, action.notify);
      } else if ("most" in action) state.most = action.most;
      else if ("origin" in action) state.origin = action.origin;
      else state.zone = action.zone;

      return null;
    },
    tables: async () => ({ devices: [...rows("ky_push_devices")], sent: [...rows("ky_push_sent")] }),
    effects: async () => effects.splice(0).sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    dispose: async () => db.close()
  };
}

const pushParity: Parity<Action> = {
  domain: "push",
  actions,
  start: Date.UTC(2026, 9, 24, 20, 30),
  advances: fc.oneof(fc.integer({ min: 0, max: 2 * HOUR }), fc.constantFrom(HOUR, 24 * HOUR, 60_000)),
  legacy: async (clock: Clock) => {
    clockAt = () => clock.now();

    return side((db, parts) => new LegacyPushes(sqlStorage(db), parts));
  },
  next: async () => side((db, parts) => new Pushes(storageOf(db), parts))
};

describe("push parity", () => {
  it("answers, stores and pushes what B does, step for step", async () => {
    await assertParity(pushParity);
  });
});
