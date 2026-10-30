import { env } from "cloudflare:workers";
import { ROOT_SESSION } from "agents/harness/pi";
import Type, { type TSchema } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { parseAs } from "../core/decode";
import { localNow } from "../dreaming/contract";
import type { PushDevice } from "../push/contract";
import { base64url, encrypt, fromBase64url } from "../push/webpush";
import { browser, inside, type Tab, until } from "./drive";

/**
 * Web Push (src/push/) on ky's real Worker: the encryption against RFC 8291's own example, the Vault's VAPID key
 * and tokens, and what ky posts unasked pushed to a device the page subscribed, up to the user's right-away number
 * a local day, each push read back with the device's private key. The push service is a fake that answers each
 * push as a test says.
 */

const encoder = new TextEncoder();

/** RFC 8291 Appendix A's inputs and its result, the header and the ciphertext. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ"
};

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: BufferSource, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);

  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** A device as a browser makes one: its key pair and secret, and the subscription it hands ky. */
async function aDevice(endpoint: string): Promise<{ device: PushDevice; keys: CryptoKeyPair; auth: Uint8Array<ArrayBuffer> }> {
  const keys = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));

  return { device: { endpoint, p256dh: base64url(raw), auth: base64url(auth) }, keys, auth };
}

/** A push's body opened as the device does, by RFC 8291 from the receiving side: its plaintext. */
async function open(body: Uint8Array<ArrayBuffer>, keys: CryptoKeyPair, auth: Uint8Array<ArrayBuffer>): Promise<string> {
  const salt = body.slice(0, 16);
  const idLength = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idLength);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const sender = await crypto.subtle.importKey("raw", asPublic, ECDH, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, keys.privateKey, 256);
  const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(auth, shared, info, 32);
  const cek = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["decrypt"]);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cek, body.slice(21 + idLength)));

  expect(plain.at(-1)).toBe(2);

  return new TextDecoder().decode(plain.slice(0, -1));
}

/** A VAPID token's header and claims, as RFC 8292 has them. */
const Head = Type.Object({ typ: Type.String(), alg: Type.String() });

const Claims = Type.Object({ aud: Type.String(), sub: Type.String(), exp: Type.Number() });

/** The JSON a JWT part holds, as `schema` says. */
const claims = <Schema extends TSchema>(schema: Schema, part: string) => parseAs(schema, new TextDecoder().decode(fromBase64url(part)), "A JWT part");

type Sent = { endpoint: string; headers: Headers; body: Uint8Array<ArrayBuffer> };

/** Answer every push the agent `name` sends with `status`, keeping each. */
async function pushService(name: string, status: (endpoint: string) => number): Promise<Sent[]> {
  const sent: Sent[] = [];

  await inside(name, (instance) => {
    instance.pushes.fetch = async (endpoint, init) => {
      sent.push({ endpoint, headers: new Headers(init.headers), body: new Uint8Array(await new Response(init.body).arrayBuffer()) });

      return new Response(null, { status: status(endpoint) });
    };
  });

  return sent;
}

/** A look's message handed to the main chat, as a look posts one. */
const post = (name: string, text: string) =>
  inside(name, (instance) => instance.deliveries.deliver({ id: `look:test:${crypto.randomUUID()}`, session: ROOT_SESSION, content: text, line: text, ref: "memory:1", kind: "look" }));

/** `text` posted in the main chat at `now`, on ky's clock. */
const notifyAt = (name: string, text: string, now: number) =>
  inside(name, async (instance) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      await instance.pushes.notify(ROOT_SESSION, text);
    } finally {
      clock.mockRestore();
    }
  });

/** Each text ky said in the main chat, oldest first. */
const kySaid = (page: Tab) =>
  page
    .view()
    .messages.filter((message) => message.role === "assistant")
    .map((message) => message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""));

describe("a push's encryption", () => {
  it("makes RFC 8291's example from its keys and salt", async () => {
    const asPublic = fromBase64url(RFC.asPublic);
    const jwk = { kty: "EC", crv: "P-256", x: base64url(asPublic.slice(1, 33)), y: base64url(asPublic.slice(33)), d: RFC.asPrivate };

    const sender = {
      publicKey: await crypto.subtle.importKey("raw", asPublic, ECDH, true, []),
      privateKey: await crypto.subtle.importKey("jwk", jwk, ECDH, false, ["deriveBits"])
    };

    const device = { endpoint: "https://push.test/rfc", p256dh: RFC.uaPublic, auth: RFC.auth };

    const made = await encrypt(encoder.encode(RFC.plaintext), device, sender, fromBase64url(RFC.salt));

    expect(base64url(made.slice(0, 86))).toBe(RFC.header);
    expect(base64url(made.slice(86))).toBe(RFC.ciphertext);
  });
});

describe("the Vault's VAPID key", () => {
  it("is made once, and signs a token for a push service's origin, naming ky's address, for 12 hours", async () => {
    const vault = env.Vault.getByName(crypto.randomUUID());
    const key = await vault.vapidKey();

    expect(fromBase64url(key)).toHaveLength(65);
    expect(await vault.vapidKey()).toBe(key);

    const header = await vault.vapidAuth("https://push.test", "https://ky.test");
    const [, token = "", k] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
    const [head = "", body = "", signature = ""] = token.split(".");
    const verifier = await crypto.subtle.importKey("raw", fromBase64url(key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);

    expect(k).toBe(key);
    const { exp, ...named } = claims(Claims, body);

    expect(claims(Head, head)).toEqual({ typ: "JWT", alg: "ES256" });
    expect(named).toEqual({ aud: "https://push.test", sub: "https://ky.test" });
    expect(exp * 1000 - Date.now()).toBeGreaterThan(11.9 * 3_600_000);
    expect(exp * 1000 - Date.now()).toBeLessThanOrEqual(12 * 3_600_000);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, fromBase64url(signature), encoder.encode(`${head}.${body}`))).toBe(true);
  });
});

describe("pushes", () => {
  it("send each post to the subscribed device, up to the right-away number a local day; past it a post still lands, quietly", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    const { device, keys, auth } = await aDevice("https://push.test/phone");
    const sent = await pushService(name, () => 201);

    expect(JSON.stringify(await page.send({ type: "push-key" }))).toMatch(/"result":"[\w-]{87}"/);
    expect(await page.send({ type: "push-subscribe", ...device })).toMatchObject({ type: "result" });
    expect(await page.send({ type: "set-right-away", most: 2 })).toMatchObject({ type: "result", result: { rightAway: 2 } });
    // The user is in Auckland, so the day the posts below count on is Auckland's today.
    await inside(name, (instance) => instance.automations.setZone("Pacific/Auckland"));

    for (const text of ["Kai's school is closed tomorrow.", "Rent is due Friday.", "Your parcel came."]) await post(name, text);
    await page.until(() => kySaid(page).includes("Your parcel came."));

    // Three posts in the chat, two pushes: the third went past the day's two. A post's push goes out after it lands, so wait for it.
    await until(async () => sent.length >= 2, "two pushes");
    expect(sent).toHaveLength(2);
    expect(await open(sent[0]!.body, keys, auth)).toBe(`ky\n/?session=${ROOT_SESSION}\nKai's school is closed tomorrow.`);
    expect(sent[0]!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(sent[0]!.headers.get("authorization")).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);

    // The user's day turns at their midnight, not UTC's: half an hour either side of Auckland's next midnight,
    // which falls on one UTC date, only the second is a new day. From now, so the test holds on any date.
    const now = Date.now();
    const midnight = now - (now % 60_000) + (1440 - localNow("Pacific/Auckland", now).minutes) * 60_000;
    await notifyAt(name, "Still today there.", midnight - 30 * 60_000);
    await notifyAt(name, "A new day there.", midnight + 30 * 60_000);
    expect(await Promise.all(sent.slice(2).map((each) => open(each.body, keys, auth)))).toEqual([`ky\n/?session=${ROOT_SESSION}\nA new day there.`]);

    // A long post is cut to 120 characters, never through the middle of one.
    await notifyAt(name, "🙂".repeat(200), Date.parse("2026-10-18T12:00:00Z"));
    const cut = (await open(sent[3]!.body, keys, auth)).split("\n")[2] ?? "";
    expect(Array.from(cut)).toEqual([...Array.from({ length: 119 }, () => "🙂"), "…"]);
    page.close();
  });

  it("drop a device its push service no longer knows or that has another VAPID key, and a push no device took doesn't count", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    const gone = await aDevice("https://push.test/gone");
    const stale = await aDevice("https://push.test/stale");
    const kept = await aDevice("https://push.test/kept");
    const answers = new Map([["https://push.test/gone", 410], ["https://push.test/stale", 403]]);
    const sent = await pushService(name, (endpoint) => answers.get(endpoint) ?? 503);

    for (const { device } of [gone, stale, kept]) expect(await page.send({ type: "push-subscribe", ...device })).toMatchObject({ type: "result" });
    expect(await page.send({ type: "set-right-away", most: 1 })).toMatchObject({ type: "result" });

    await inside(name, (instance) => instance.pushes.notify(ROOT_SESSION, "First."));
    expect(sent.map((each) => each.endpoint).toSorted()).toEqual(["https://push.test/gone", "https://push.test/kept", "https://push.test/stale"]);

    const devices = () => inside(name, (_instance, state) => state.storage.sql.exec("SELECT endpoint FROM ky_push_devices").toArray().map((row) => row.endpoint));
    expect(await devices()).toEqual(["https://push.test/kept"]);

    // Neither took "First.", so the day's one push is still there for the next.
    const took = await pushService(name, () => 201);
    await inside(name, async (instance) => {
      await instance.pushes.notify(ROOT_SESSION, "Second.");
      await instance.pushes.notify(ROOT_SESSION, "Third.");
    });
    expect(took).toHaveLength(1);
    expect(await open(took[0]!.body, kept.keys, kept.auth)).toBe(`ky\n/?session=${ROOT_SESSION}\nSecond.`);

    // Unsubscribed, the device gets nothing.
    expect(await page.send({ type: "push-unsubscribe", endpoint: kept.device.endpoint })).toMatchObject({ type: "result" });
    expect(await devices()).toEqual([]);
    page.close();
  });

  it("send ky's answer to the user's own message once its turn ends, unless a page of ky is in front of them, past the right-away number", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    const other = await browser(name);
    const { device, keys, auth } = await aDevice("https://push.test/phone");
    const sent = await pushService(name, () => 201);
    const pushed = () => Promise.all(sent.map((each) => open(each.body, keys, auth)));
    // Its push goes out as the answer lands; time enough for one that would.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

    expect(await page.send({ type: "push-subscribe", ...device })).toMatchObject({ type: "result" });
    // None a day for posts ky starts: a reply to the user still comes.
    expect(await page.send({ type: "set-right-away", most: 0 })).toMatchObject({ type: "result" });

    // The user sent it and left (no page said it is looking): one push, of the final answer, at high urgency.
    await page.say("Is the parcel here yet?");
    await until(async () => sent.length >= 1, "a reply's push");
    await settle();
    const answer = kySaid(page).at(-1) ?? "";
    expect(answer).not.toBe("");
    expect(await pushed()).toEqual([`ky\n/?session=${ROOT_SESSION}\n${answer.replaceAll(/\s+/g, " ").trim().slice(0, 120)}`]);
    expect(sent[0]!.headers.get("urgency")).toBe("high");
    expect(sent[0]!.headers.get("ttl")).toBe("86400");

    // Another page of ky in front of them, even on another chat or device: they see it there, so no push.
    expect(await other.send({ type: "watching", watching: true })).toMatchObject({ type: "result", result: null });
    await page.say("And the rent?");
    await settle();
    expect(sent).toHaveLength(1);

    // That page went to the background (iOS says so before it freezes the socket): the next reply pushes again.
    expect(await other.send({ type: "watching", watching: false })).toMatchObject({ type: "result" });
    await page.say("Thanks.");
    await until(async () => sent.length >= 2, "a second reply's push");
    await settle();
    expect(sent).toHaveLength(2);

    // A page that said it is looking and then closed counts no more.
    expect(await other.send({ type: "watching", watching: true })).toMatchObject({ type: "result" });
    other.close();
    await until(async () => !(await inside(name, (instance) => instance.watched())), "the closed page to stop counting");
    await page.say("One more.");
    await until(async () => sent.length >= 3, "a third reply's push");
    page.close();
  });

  it("send none for a turn a report started, nor its post past the right-away number: only the user's own turns are replies", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    const { device } = await aDevice("https://push.test/phone");
    const sent = await pushService(name, () => 201);

    expect(await page.send({ type: "push-subscribe", ...device })).toMatchObject({ type: "result" });
    expect(await page.send({ type: "set-right-away", most: 0 })).toMatchObject({ type: "result" });
    await inside(name, (instance) =>
      instance.deliveries.deliver({ id: `report-${name}`, session: ROOT_SESSION, content: "Weather report: rain all morning", line: "Weather report", ref: "task:weather" })
    );
    await page.until(() => kySaid(page).length > 0 && !page.view().running);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent).toHaveLength(0);
    page.close();
  });

  it("refuse a subscription that isn't https or whose keys aren't a device's", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    const { device } = await aDevice("https://push.test/phone");

    expect(await page.send({ type: "push-subscribe", ...device, endpoint: "http://push.test/phone" })).toMatchObject({ type: "error", message: "A push endpoint is an https address." });
    expect(await page.send({ type: "push-subscribe", ...device, auth: base64url(new Uint8Array(8)) })).toMatchObject({ type: "error" });
    page.close();
  });
});
