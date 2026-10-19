import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fc from "fast-check";
import Type from "typebox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Deliveries } from "../../src/automations/delivery";
import { decodeOr, parseAs } from "../../src/core/decode";
import { base64url, encrypt, fromBase64url, type PushDevice, Pushes, vapidToken } from "../../src/push";

/**
 * Web Push (src/push.ts), over generated runs on a real SQLite: posts handed to Delivery (src/automations/delivery.ts)
 * one at a time or several at once, devices subscribing and unsubscribing, push services that take a push, refuse it,
 * say the device is gone (404, 410) or never answer, the right-away number changing, ky not knowing its address yet,
 * and the clock crossing local midnights in zones from UTC-11 to UTC+14, daylight saving and half hours included.
 * Whatever happens:
 *
 * - every post is in its chat, pushed or not;
 * - a post pushes exactly when a device is subscribed and fewer than the right-away number of posts were taken by a
 *   device that local day, counting the posts already on their way: never more than that number a day;
 * - the day's count is the posts a device took, so a push no device took gives its place back;
 * - a device its push service said is gone is never tried again, until it subscribes again;
 * - each push is one aes128gcm record the device opens with its own key, signed for its push service's origin.
 *
 * And for any payload a record holds (RFC 8291 §4: 3993 bytes), what the device opens is what ky sent.
 */

const encoder = new TextEncoder();

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

const ENDPOINTS = ["https://fcm.test/send/a", "https://fcm.test/send/b", "https://web.push.apple.test/c"] as const;

/** Zones whose local midnight falls at many UTC times, null (UTC), and two whose clocks go back an hour at midnight. */
const ZONES = [null, "UTC", "America/Los_Angeles", "Pacific/Pago_Pago", "Pacific/Kiritimati", "Asia/Kathmandu", "America/St_Johns", "Australia/Lord_Howe", "Europe/London", "America/Santiago", "Asia/Beirut"] as const;

const HOUR = 3_600_000;

const ORIGIN = "https://ky.example.com";

/** What a push service answers: takes it, refuses it, no longer knows the device, knows it by another VAPID key, or never answers. */
type Answer = "ok" | "refused" | "gone" | "lost" | "rekeyed" | "unreachable";

const STATUS: Record<Exclude<Answer, "unreachable">, number> = { ok: 201, refused: 500, gone: 410, lost: 404, rekeyed: 403 };

/** The answers after which ky drops the device. */
const DROPS = new Set<Answer | undefined>(["gone", "lost", "rekeyed"]);

type Op =
  | { readonly op: "subscribe"; readonly device: number }
  | { readonly op: "unsubscribe"; readonly device: number }
  | { readonly op: "advance"; readonly ms: number }
  | { readonly op: "most"; readonly most: number }
  | { readonly op: "origin"; readonly known: boolean }
  /** Posts handed over together, each with what each device's push service answers it. */
  | { readonly op: "post"; readonly answers: readonly (readonly Answer[])[] };

const anAnswer = fc.oneof({ weight: 8, arbitrary: fc.constant<Answer>("ok") }, { weight: 1, arbitrary: fc.constantFrom<Answer>("refused", "gone", "lost", "rekeyed", "unreachable") });

const aDevice = fc.integer({ min: 0, max: ENDPOINTS.length - 1 });

const anOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ op: fc.constant("post" as const), answers: fc.array(fc.array(anAnswer, { minLength: 3, maxLength: 3 }), { minLength: 1, maxLength: 4 }) }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("advance" as const), ms: fc.oneof(fc.integer({ min: 0, max: 2 * HOUR }), fc.integer({ min: 0, max: 30 * HOUR }), fc.constantFrom(HOUR, 24 * HOUR, 60_000)) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("subscribe" as const), device: aDevice }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("unsubscribe" as const), device: aDevice }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("most" as const), most: fc.oneof(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 24 })) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("origin" as const), known: fc.boolean() }) }
);

/** A start: any time in 2026-2027, or just before a midnight that a clock going back an hour makes come late. */
const aStart = fc.oneof(
  fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
  // Santiago's clocks go from Saturday 24:00 back to 23:00 on 2026-04-05 at 03:00Z, Beirut's on 2026-10-24 at 21:00Z.
  fc.constantFrom(Date.UTC(2026, 3, 5, 2, 30), Date.UTC(2026, 9, 24, 20, 30))
);

/** A push service's endpoint: any host, any port or none, any path. fc.webUrl would do, but its first run alone takes a fifth of a second building its path tables. */
const anEndpoint = fc
  .tuple(fc.domain(), fc.option(fc.nat({ max: 65_535 }), { nil: undefined }), fc.array(fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-._~".split("")) }), { maxLength: 4 }))
  .map(([host, port, path]) => `https://${host}${port === undefined ? "" : `:${port}`}/${path.join("/")}`);

type Storage = ConstructorParameters<typeof Pushes>[0];

/** A real SQLite behind the `exec(...).toArray()` that Pushes and Deliveries use, nothing else of SqlStorage. */
function storage(db: DatabaseSync): Storage {
  const exec = (query: string, ...bindings: SQLInputValue[]) => {
    const rows = db.prepare(query).all(...bindings);

    return { toArray: () => rows.map((row) => ({ ...row })) };
  };

  // SAFETY: Pushes and Deliveries call exec and read toArray, nothing else of SqlStorage or its cursor.
  return { exec, databaseSize: 0 } as Storage;
}

/** The user's local date in `zone` at `now`, by Intl alone: the oracle's day, made apart from localNow in src/dreaming/contract.ts. */
function dayIn(zone: string | null, now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: BufferSource, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);

  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

type Subscriber = { readonly device: (endpoint: string) => PushDevice; readonly keys: CryptoKeyPair; readonly auth: Uint8Array<ArrayBuffer> };

/** A device as a browser makes one: its ECDH key pair and 16-byte secret. */
async function aSubscriber(): Promise<Subscriber> {
  const keys = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));

  return { device: (endpoint) => ({ endpoint, p256dh, auth: base64url(auth) }), keys, auth };
}

type Opened = { readonly rs: number; readonly idLength: number; readonly sealedLength: number; readonly delimiter: number | undefined; readonly payload: Uint8Array };

/**
 * A push's body opened as the receiving device does by RFC 8291 §3.3-3.4 and RFC 8188 §2, written from the RFCs:
 * the header's fields, and the plaintext with its delimiter and any zero padding after it taken off.
 */
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

/** A VAPID token's header and claims, as RFC 8292 has them. */
const Head = Type.Object({ typ: Type.String(), alg: Type.String() });

const Claims = Type.Object({ aud: Type.String(), exp: Type.Number(), sub: Type.String() });

/** A JWT's parts: its header, its claims and its signature's bytes. */
function jwt(token: string) {
  const [head = "", claims = "", signature = ""] = token.split(".");
  const text = (part: string) => new TextDecoder().decode(fromBase64url(part));

  return { head: parseAs(Head, text(head), "A JWT's header"), claims: parseAs(Claims, text(claims), "A JWT's claims"), signed: `${head}.${claims}`, signature: fromBase64url(signature) };
}

const SentRow = Type.Object({ sent: Type.Integer() });

const EndpointRow = Type.Object({ endpoint: Type.String() });

let subscribers: Subscriber[] = [];

let vapid: CryptoKeyPair;

let vapidPublic: string;

let warn: { mockRestore: () => void };

beforeAll(async () => {
  subscribers = await Promise.all(ENDPOINTS.map(() => aSubscriber()));
  vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  vapidPublic = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey)));
  // A refused or failed push is logged; here that is noise.
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterAll(() => warn.mockRestore());

type Tried = { readonly endpoint: string; readonly post: string };

const byPost = (a: Tried, b: Tried) => `${a.post} ${a.endpoint}`.localeCompare(`${b.post} ${b.endpoint}`);

/** What is wrong with a push's headers, sent at `now`: its encoding, its TTL, and its VAPID token and key. */
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

/** One ky: its rows, its pushes wired to Delivery as src/server.ts wires them, and a fake push service. */
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
  /** What each device's push service answers each post, by the post's text. */
  readonly answers = new Map<string, readonly Answer[]>();
  readonly problems: string[] = [];
  readonly zone: string | null;

  constructor(zone: string | null, start: number) {
    this.zone = zone;
    this.now = start;

    this.pushes = new Pushes(storage(this.db), {
      vault: () => ({ vapidKey: async () => vapidPublic, vapidAuth: async (audience, subject) => `vapid t=${await vapidToken(vapid.privateKey, audience, subject, this.now)}, k=${vapidPublic}` }),
      zone: () => this.zone,
      most: () => this.most,
      title: () => "ky",
      origin: () => this.origin
    });
    this.pushes.fetch = (input, init) => this.#service(String(input), init ?? {});

    this.deliveries = new Deliveries(storage(this.db), {
      surfaced: { shown: () => undefined },
      submit: async () => true,
      post: async (_session, text) => {
        this.posted.push(text);

        return true;
      },
      notify: (session, text) => this.pushes.notify(session, text, this.now),
      idle: async () => undefined,
      later: (promise) => void this.later.push(promise)
    });
  }

  /** The push service at `endpoint`: opens the push with the device's key, checks its headers and token, and answers. */
  async #service(endpoint: string, init: RequestInit): Promise<Response> {
    const index = ENDPOINTS.findIndex((each) => each === endpoint);
    const subscriber = subscribers[index];

    if (!subscriber) throw new Error(`A push to an endpoint no device has: ${endpoint}`);
    const headers = new Headers(init.headers);
    const opened = await open(new Uint8Array(await new Response(init.body).arrayBuffer()), subscriber);
    const [, , post = ""] = new TextDecoder().decode(opened.payload).split("\n");
    this.#check(endpoint, headers);
    this.tried.push({ endpoint, post });
    const answer = this.answers.get(post)?.[index] ?? "ok";

    if (answer === "unreachable") throw new TypeError("fetch failed");

    return new Response(null, { status: STATUS[answer] });
  }

  #check(endpoint: string, headers: Headers): void {
    this.problems.push(...pushProblems(endpoint, headers, this.origin, this.now));
  }

  /** The day's count as ky keeps it: the row for `day`, or 0 without one. */
  sent(day: string): number {
    return decodeOr(SentRow, this.db.prepare("SELECT sent FROM ky_push_sent WHERE day = ?").get(day), undefined)?.sent ?? 0;
  }

  async settle(): Promise<void> {
    while (this.later.length > 0) await Promise.all(this.later.splice(0));
  }
}

/** The oracle: what ky must do, from the contract alone. */
class Model {
  readonly devices = new Set<number>();
  /** Posts a device took, by local day. */
  readonly took = new Map<string, number>();
  /** Devices their push service said are gone, until they subscribe again. */
  readonly gone = new Set<number>();
}

let posts = 0;

/** What the runs reached, so a pass means the cap, a day's turn, a gone device and an unknown address were all met. */
const reached = { pushed: 0, capped: 0, released: 0, gone: 0, days: 0, unknown: 0 };

/** Hand `answers`' posts over one after another without waiting for their pushes, so they are on their way at once: their texts. */
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

/** The devices subscribed, in order. */
const subscribed = (model: Model) => [...model.devices].sort((a, b) => a - b);

/** The posts among `texts` that may push: as many as the day has room for after `before`, in the order they were handed over. */
function mayPush(world: World, model: Model, texts: readonly string[], before: number): string[] {
  const room = model.devices.size === 0 ? 0 : Math.max(0, Math.min(texts.length, world.most - before));

  if (model.devices.size > 0 && room < texts.length) reached.capped++;

  if (world.origin === null && room > 0) reached.unknown++;

  return world.origin === null ? [] : texts.slice(0, room);
}

/** The pushes tried since `from` are exactly each pushing post to each subscribed device, and none to a device gone. */
function expectTried(world: World, model: Model, pushing: readonly string[], from: number): void {
  const expected = pushing.flatMap((post) => subscribed(model).map((device) => ({ endpoint: ENDPOINTS[device] ?? "", post })));
  const tried = world.tried.slice(from);

  expect([...tried].sort(byPost)).toEqual([...expected].sort(byPost));

  for (const each of tried) expect(model.gone.has(ENDPOINTS.findIndex((endpoint) => endpoint === each.endpoint))).toBe(false);
}

/** How many of `pushing` a device took; each device whose push service dropped it is gone from the model. */
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

/** Posts handed over together, checked against the model; the last day the cap filled. */
async function postAll(world: World, model: Model, answers: readonly (readonly Answer[])[], full: string | undefined): Promise<string | undefined> {
  const day = dayIn(world.zone, world.now);
  const before = model.took.get(day) ?? 0;
  const from = world.tried.length;
  const texts = await handOver(world, answers);
  const pushing = mayPush(world, model, texts, before);

  // A new local day after a day the cap filled.
  if (full !== undefined && full !== day && model.devices.size > 0) reached.days++;

  expectTried(world, model, pushing, from);
  const count = before + settleModel(world, model, pushing);
  model.took.set(day, count);

  expect(world.sent(day)).toBe(count);
  expect(count).toBeLessThanOrEqual(Math.max(world.most, before));

  return count >= Math.max(world.most, 1) ? day : full;
}

/** `op`, other than a post, done to ky and to the model alike. */
function apply(world: World, model: Model, op: Exclude<Op, { op: "post" }>): void {
  if (op.op === "advance") world.now += op.ms;
  else if (op.op === "most") world.most = op.most;
  else if (op.op === "origin") world.origin = op.known ? ORIGIN : null;
  else if (op.op === "subscribe") {
    world.pushes.subscribe(subscribers[op.device]?.device(ENDPOINTS[op.device] ?? "") ?? { endpoint: "", p256dh: "", auth: "" }, world.now);
    model.devices.add(op.device);
    model.gone.delete(op.device);
  } else {
    world.pushes.unsubscribe(ENDPOINTS[op.device] ?? "");
    model.devices.delete(op.device);
  }
}

/** After a run: no push was malformed, every post is in its chat, and ky keeps the devices the model does. */
function expectEnd(world: World, model: Model, ops: readonly Op[]): void {
  expect(world.problems).toEqual([]);
  expect(world.posted.length).toBe(ops.reduce((count, op) => count + (op.op === "post" ? op.answers.length : 0), 0));

  const kept = world.db
    .prepare("SELECT endpoint FROM ky_push_devices ORDER BY endpoint")
    .all()
    .map((row) => decodeOr(EndpointRow, row, undefined)?.endpoint);

  expect(kept).toEqual(subscribed(model).map((device) => ENDPOINTS[device]));
}

async function play(zone: string | null, start: number, most: number, ops: readonly Op[]): Promise<void> {
  const world = new World(zone, start);
  const model = new Model();
  /** The last day the cap filled. */
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
      // The default 6, or a small number the posts fill.
      fc.asyncProperty(fc.constantFrom(...ZONES), aStart, fc.constantFrom(6, 1, 2, 3), fc.array(anOp, { maxLength: 40 }), (zone, start, most, ops) =>
        play(zone, start, most, [{ op: "subscribe", device: 0 }, ...ops])
      ),
      { numRuns: 200 }
    );

    expect(Object.values(reached).every((count) => count > 0), JSON.stringify(reached)).toBe(true);
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

        // RFC 8291 §4: salt, rs 4096, a 65-byte key, then one record no longer than rs; a push service takes 4096 bytes.
        expect(base64url(body.slice(0, 16))).toBe(base64url(salt));
        expect([opened.rs, opened.idLength, opened.delimiter]).toEqual([4096, 65, 2]);
        expect(opened.sealedLength).toBeLessThanOrEqual(opened.rs);
        expect(body.length).toBeLessThanOrEqual(4096);
        expect(base64url(opened.payload)).toBe(base64url(payload));
      }),
      { numRuns: 60 }
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
      { numRuns: 100 }
    );
  });
});
