import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Fetch } from "../chatgpt";
import { Sql } from "../core/sql";
import { localNow } from "../dreaming/contract";
import { BadSubscription, PushDevice } from "./contract";
import { encrypt, fromBase64url } from "./webpush";

export type Signer = {
  readonly vapidKey: () => Promise<string>;
  readonly vapidAuth: (audience: string, subject: string) => Promise<string>;
};

export type PushParts = {
  readonly vault: () => Signer;
  readonly zone: () => string | null;
  readonly most: () => number;
  readonly title: (session: string) => string;
  readonly origin: () => string | null;
};

const BODY_CHARS = 120;

const TTL_SECONDS = 86_400;

const LOGGED_CHARS = 200;

const GONE = new Set([403, 404, 410]);

const encoder = new TextEncoder();

const DEVICES = "ky_push_devices";

const SENT = "ky_push_sent";

class Unsent extends Schema.TaggedError<Unsent>()("Unsent", { cause: Schema.Defect() }) {}

const warned = (...said: unknown[]) => Effect.sync(() => console.warn("push", ...said));

const keysOf = (device: PushDevice) =>
  Effect.try({
    try: () => ({ ua: fromBase64url(device.p256dh), auth: fromBase64url(device.auth) }),
    catch: () => new BadSubscription({ problem: "keys" })
  });

const checked = Effect.fnUntraced(function* (device: PushDevice) {
  if (!URL.canParse(device.endpoint) || new URL(device.endpoint).protocol !== "https:") return yield* new BadSubscription({ problem: "endpoint" });
  const { ua, auth } = yield* keysOf(device);

  if (ua.length !== 65 || ua[0] !== 4 || auth.length !== 16) return yield* new BadSubscription({ problem: "keys" });

  return device;
});

function payloadOf(title: string, session: string, text: string): Uint8Array {
  const chars = Array.from(text.replaceAll(/\s+/g, " ").trim());
  const body = chars.length > BODY_CHARS ? `${chars.slice(0, BODY_CHARS - 1).join("")}…` : chars.join("");

  return encoder.encode(`${title}\n/?session=${encodeURIComponent(session)}\n${body}`);
}

export class Push extends Context.Service<
  Push,
  {
    subscribe(device: PushDevice): Effect.Effect<void, BadSubscription>;
    unsubscribe(endpoint: string): Effect.Effect<void>;
    notify(session: string, text: string): Effect.Effect<void>;
  }
>()("ky/push/Push") {
  static readonly layer = (parts: PushParts, fetch: Fetch) =>
    Layer.effect(
      Push,
      Effect.gen(function* () {
        const sql = yield* Sql;
        const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));

        yield* exec(`CREATE TABLE IF NOT EXISTS ${DEVICES} (
          endpoint TEXT PRIMARY KEY,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at INTEGER NOT NULL)`);
        yield* exec(`CREATE TABLE IF NOT EXISTS ${SENT} (day TEXT PRIMARY KEY, sent INTEGER NOT NULL)`);

        const unsubscribe = (endpoint: string) => Effect.asVoid(exec(`DELETE FROM ${DEVICES} WHERE endpoint = ?`, endpoint));

        const take = Effect.fnUntraced(function* (day: string) {
          const most = parts.most();

          if (most < 1) return false;
          yield* exec(`DELETE FROM ${SENT} WHERE day <> ?`, day);
          const taken = yield* exec(`INSERT INTO ${SENT} (day, sent) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET sent = sent + 1 WHERE sent < ? RETURNING sent`, day, most);

          return taken.length > 0;
        });

        const post = (device: PushDevice, payload: Uint8Array) =>
          Effect.tryPromise({
            try: async () => {
              const origin = parts.origin();

              if (origin === null) throw new Error("ky doesn't know its own address yet.");
              const sender = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
              const body = await encrypt(payload, device, sender, crypto.getRandomValues(new Uint8Array(16)));
              const authorization = await parts.vault().vapidAuth(new URL(device.endpoint).origin, origin);

              return fetch(device.endpoint, {
                method: "POST",
                headers: { authorization, "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(TTL_SECONDS) },
                body
              });
            },
            catch: (cause) => new Unsent({ cause })
          });

        const send = (device: PushDevice, payload: Uint8Array) =>
          Effect.gen(function* () {
            const response = yield* post(device, payload);

            if (response.ok) return true;

            if (GONE.has(response.status)) yield* unsubscribe(device.endpoint);
            else {
              const said = yield* Effect.tryPromise({ try: () => response.text(), catch: (cause) => new Unsent({ cause }) });
              yield* warned(response.status, said.slice(0, LOGGED_CHARS));
            }

            return false;
          }).pipe(Effect.catchTag("Unsent", ({ cause }) => Effect.as(warned(cause), false)));

        return Push.of({
          subscribe: Effect.fnUntraced(function* (device) {
            const { endpoint, p256dh, auth } = yield* checked(device);
            const now = yield* Clock.currentTimeMillis;
            yield* exec(
              `INSERT INTO ${DEVICES} (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
               ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
              endpoint,
              p256dh,
              auth,
              now
            );
          }),
          unsubscribe,
          notify: Effect.fnUntraced(function* (session, text) {
            const devices = yield* Effect.orDie(sql.rows(PushDevice, `SELECT endpoint, p256dh, auth FROM ${DEVICES}`));

            if (devices.length === 0) return;
            const day = localNow(parts.zone(), yield* Clock.currentTimeMillis).date;

            if (!(yield* take(day))) return;
            const payload = payloadOf(parts.title(session), session, text);
            const took = yield* Effect.forEach(devices, (device) => send(device, payload), { concurrency: "unbounded" });

            if (!took.includes(true)) yield* exec(`UPDATE ${SENT} SET sent = sent - 1 WHERE day = ?`, day);
          })
        });
      })
    );
}
