import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ASSERTION, Certs, JwtClaims, JwtHeader, KeysUnavailable, NotSetUp, SignInRefused } from "./contract";

export type CertsFetch = (url: string) => Promise<Response>;

export type AccessVars = Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "ACCESS_EMAILS" | "KY_DEV" | "KY_DEV_EMAIL">;

const KEYS_TTL_MS = 60 * 60_000;

const REFETCH_MS = 60_000;

const LEEWAY_S = 60;

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

type TeamKeys = ReadonlyMap<string, CryptoKey>;

type Kept = { readonly team: string; readonly at: number; readonly keys: Deferred.Deferred<TeamKeys, KeysUnavailable> };

function bytes(base64url: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.from(atob(base64url.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

const headerOf = Schema.decodeUnknownOption(Schema.fromJsonString(JwtHeader));

const claimsOf = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaims));

const certsOf = Schema.decodeUnknownEffect(Schema.fromJsonString(Certs));

const part = <A>(decode: (text: string) => Option.Option<A>, text: string) => Option.getOrUndefined(decode(new TextDecoder().decode(bytes(text))));

const valid = (claims: JwtClaims, team: string, aud: string, now: number) =>
  claims.iss === `https://${team}` && [claims.aud].flat().includes(aud) && claims.exp > now && (claims.nbf ?? 0) <= now + LEEWAY_S;

const unavailable = (cause: unknown) => new KeysUnavailable({ cause });

export class Keys extends Context.Service<Keys, { key(team: string, kid: string): Effect.Effect<CryptoKey | undefined, KeysUnavailable> }>()("ky/access/Keys") {
  static readonly layer = (certs: CertsFetch) =>
    Layer.effect(
      Keys,
      Effect.gen(function* () {
        const kept = yield* Ref.make<Kept | undefined>(undefined);

        const fetchKeys = (team: string) =>
          Effect.gen(function* () {
            const response = yield* Effect.tryPromise({ try: () => certs(`https://${team}/cdn-cgi/access/certs`), catch: unavailable });

            if (!response.ok) return yield* unavailable(`Access's certs answered ${response.status}`);
            const text = yield* Effect.tryPromise({ try: () => response.text(), catch: unavailable });
            const { keys } = yield* certsOf(text).pipe(Effect.mapError(unavailable));

            const imported = yield* Effect.forEach(
              keys,
              ({ kid, kty, n, e }) =>
                Effect.tryPromise({ try: () => crypto.subtle.importKey("jwk", { kty, n, e }, RS256, false, ["verify"]), catch: unavailable }).pipe(
                  Effect.map((key) => [kid, key] as const)
                ),
              { concurrency: "unbounded" }
            );

            return new Map(imported);
          });

        const load = (team: string, maxAgeMs: number) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            const keys = yield* Deferred.make<TeamKeys, KeysUnavailable>();
            const entry: Kept = { team, at, keys };

            const shared = yield* Ref.modify(kept, (current): [Kept | undefined, Kept | undefined] =>
              current?.team === team && at - current.at < maxAgeMs ? [current, current] : [undefined, entry]
            );

            if (shared) return yield* Deferred.await(shared.keys);

            const fetched = yield* Effect.uninterruptible(
              Effect.exit(fetchKeys(team)).pipe(
                Effect.tap((exit) => (Exit.isFailure(exit) ? Ref.update(kept, (current) => (current === entry ? undefined : current)) : Effect.void)),
                Effect.tap((exit) => Deferred.done(keys, exit))
              )
            );

            return yield* fetched;
          });

        return Keys.of({
          key: (team, kid) =>
            Effect.gen(function* () {
              const fresh = (yield* load(team, KEYS_TTL_MS)).get(kid);

              return fresh ?? (yield* load(team, REFETCH_MS)).get(kid);
            })
        });
      })
    );
}

const emailOf = (jwt: string | null, team: string, aud: string) =>
  Effect.gen(function* () {
    const [head = "", body = "", signature = "", ...rest] = jwt?.split(".") ?? [];
    const header = part(headerOf, head);
    const claims = part(claimsOf, body);
    const now = (yield* Clock.currentTimeMillis) / 1000;

    if (rest.length > 0 || !header || !claims || !valid(claims, team, aud, now)) return undefined;
    const key = yield* Keys.use((keys) => keys.key(team, header.kid));
    const signed = bytes(signature);

    if (!key || !signed) return undefined;
    const verified = yield* Effect.tryPromise({ try: () => crypto.subtle.verify(RS256, key, signed, new TextEncoder().encode(`${head}.${body}`)), catch: unavailable });

    return verified ? claims.email : undefined;
  });

const allowed = (emails: string) => new Set(emails.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));

const admit = (email: string | undefined, emails: string) =>
  email !== undefined && allowed(emails).has(email.toLowerCase()) ? Effect.succeed({ email }) : Effect.fail(new SignInRefused());

export const signedIn = (request: Request, env: AccessVars) =>
  Effect.gen(function* () {
    const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ACCESS_EMAILS: emails } = env;

    if (!emails) return yield* new NotSetUp();

    if (env.KY_DEV === "1") return yield* admit(env.KY_DEV_EMAIL, emails);

    if (!team || !aud) return yield* new NotSetUp();

    const email = yield* emailOf(request.headers.get(ASSERTION), team, aud).pipe(
      Effect.tapError(({ cause }) => Effect.logError("ky couldn't fetch Access's keys", cause))
    );

    return yield* admit(email, emails);
  });
