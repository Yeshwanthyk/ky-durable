import Type, { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * Cloudflare Access signs the owner in (C3). It stands in front of the Worker
 * and puts a JWT it signed in `Cf-Access-Jwt-Assertion` on each request it
 * lets through. The Worker checks that JWT again on every request outside
 * BYPASS, socket upgrades included, so a request that reaches it some other
 * way, or carries only a `Cf-Access-Authenticated-User-Email` header, opens
 * nothing.
 *
 * The JWT must be signed (RS256) by one of the team's keys, name ky's Access
 * app in `aud`, come from the team (`iss`), be inside its `nbf` and `exp`, and
 * carry an email in ACCESS_EMAILS. The keys are fetched from the team's
 * certs and kept for an hour; a key id they don't have fetches them again, at
 * most once a minute, so a key Access rotates in works within a minute.
 *
 * Locally, KY_DEV=1 makes KY_DEV_EMAIL the signed-in email, with no JWT; only
 * `pnpm start`'s .dev.vars sets it.
 */

/**
 * C2: the paths Access lets through without a login, written as an Access
 * app's paths; `/peer/*` is other kys' (src/peers/peers.ts), `/p/*` the public sites (src/site-routes.ts), `/hooks/*`
 * webhooks, each with a token in its URL (src/inbound/routes.ts). The deployer's bypass
 * app covers exactly these, and the Worker sends them only to routes that
 * check their own tokens, or are public.
 */
export const BYPASS = ["/runner/*", "/api/runners/pair", "/api/files", "/peer/*", "/manifest.webmanifest", "/icons/*", "/p/*", "/hooks/*"];

/** The header Access puts its JWT in. */
export const ASSERTION = "Cf-Access-Jwt-Assertion";

/** Whether Access lets `pathname` through by BYPASS: `/a` covers `/a` and every path under it, `/a/*` every path under it. */
export function bypassed(pathname: string): boolean {
  return BYPASS.some((path) =>
    path.endsWith("/*") ? pathname.startsWith(path.slice(0, -1)) : pathname === path || pathname.startsWith(`${path}/`)
  );
}

/** How long the team's keys are used before they are fetched again. */
const KEYS_TTL_MS = 60 * 60_000;

/** A key id the keys lack fetches them again only this long after the last fetch. */
const REFETCH_MS = 60_000;

/** How far ahead of the Worker's clock a JWT's `nbf` may be. */
const LEEWAY_S = 60;

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

const Header = Type.Object({ alg: Type.Literal("RS256"), kid: Type.String() });

const Claims = Type.Object({
  aud: Type.Union([Type.String(), Type.Array(Type.String())]),
  iss: Type.String(),
  email: Type.String(),
  exp: Type.Number(),
  nbf: Type.Optional(Type.Number())
});

/** What `https://<team>/cdn-cgi/access/certs` answers, the part read here. */
const Certs = Type.Object({
  keys: Type.Array(Type.Object({ kid: Type.String(), kty: Type.Literal("RSA"), n: Type.String(), e: Type.String() }))
});

type Keys = { team: string; at: number; keys: Promise<Map<string, CryptoKey>> };

/** The bytes of a JWT part; undefined when it isn't base64url. */
function bytes(base64url: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.from(atob(base64url.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** The JSON a JWT part holds, when it matches `schema`. */
function decoded<Schema extends TSchema>(schema: Schema, part: string): Static<Schema> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes(part)));

    return Value.Check(schema, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** ACCESS_EMAILS, comma separated, matched without case. */
function allowed(emails: string): Set<string> {
  return new Set(emails.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

/** Undefined when `email` is one ACCESS_EMAILS lets in; else a 401. */
function admit(email: string | undefined, emails: string): Response | undefined {
  return email !== undefined && allowed(emails).has(email.toLowerCase())
    ? undefined
    : new Response("Sign in to ky through Cloudflare Access.", { status: 401 });
}

/** Whether claims name the team and this app and hold at `now`, in seconds. */
function valid(claims: Static<typeof Claims>, team: string, aud: string, now: number): boolean {
  return claims.iss === `https://${team}` && [claims.aud].flat().includes(aud) && claims.exp > now && (claims.nbf ?? 0) <= now + LEEWAY_S;
}

// A deploy from the Deploy to Cloudflare button starts here, so this says how to finish it.
const notSetUp = () =>
  new Response(
    "ky's Access isn't set up: it needs ACCESS_TEAM_DOMAIN, ACCESS_AUD and ACCESS_EMAILS. `ky init` sets them up: https://github.com/Yeshwanthyk/ky-durable#quickstart",
    { status: 500 }
  );

/** Checks Access's JWT, with the team's keys fetched through `certs`: the network's fetch, or a fake Access's in tests. */
export class Access {
  readonly #certs: (url: string) => Promise<Response>;
  #keys: Keys | undefined;
  /** The clock for keys' age and JWTs' times; the tests move it ahead. */
  now = (): number => Date.now();

  constructor(certs: (url: string) => Promise<Response> = (url) => fetch(url)) {
    this.#certs = certs;
  }

  /** The answer for a request Access didn't sign an allowed email in on; undefined when it did. */
  async refuse(request: Request, env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "ACCESS_EMAILS" | "KY_DEV" | "KY_DEV_EMAIL">): Promise<Response | undefined> {
    const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ACCESS_EMAILS: emails } = env;

    if (!emails) return notSetUp();

    if (env.KY_DEV === "1") return admit(env.KY_DEV_EMAIL, emails);

    if (!team || !aud) return notSetUp();

    try {
      return admit(await this.#email(request.headers.get(ASSERTION), team, aud), emails);
    } catch (error) {
      console.error("ky couldn't fetch Access's keys", error);

      return new Response("ky couldn't check the sign-in with Cloudflare Access; try again.", { status: 503 });
    }
  }

  /** The email of a JWT the team signed for this app, valid now; undefined for any other. */
  async #email(jwt: string | null, team: string, aud: string): Promise<string | undefined> {
    const [head = "", body = "", signature = "", ...rest] = jwt?.split(".") ?? [];
    const header = decoded(Header, head);
    const claims = decoded(Claims, body);

    if (rest.length > 0 || !header || !claims || !valid(claims, team, aud, this.now() / 1000)) return undefined;
    const key = await this.#key(team, header.kid);
    const signed = bytes(signature);

    if (!key || !signed || !(await crypto.subtle.verify(RS256, key, signed, new TextEncoder().encode(`${head}.${body}`)))) return undefined;

    return claims.email;
  }

  /** The team's key with this id: from the kept keys, or fetched again when they lack it. */
  async #key(team: string, kid: string): Promise<CryptoKey | undefined> {
    const kept = await this.#load(team, KEYS_TTL_MS);

    return kept.get(kid) ?? (await this.#load(team, REFETCH_MS)).get(kid);
  }

  /** The team's keys, fetched again when the kept ones are older than `maxAgeMs`; racing callers share one fetch. */
  #load(team: string, maxAgeMs: number): Promise<Map<string, CryptoKey>> {
    const kept = this.#keys;

    if (kept?.team === team && this.now() - kept.at < maxAgeMs) return kept.keys;
    const keys = this.#fetchKeys(team);
    const entry = { team, at: this.now(), keys };
    this.#keys = entry;
    // A failed fetch isn't kept, so the next request tries again.
    keys.catch(() => {
      if (this.#keys === entry) this.#keys = undefined;
    });

    return keys;
  }

  async #fetchKeys(team: string): Promise<Map<string, CryptoKey>> {
    const response = await this.#certs(`https://${team}/cdn-cgi/access/certs`);

    if (!response.ok) throw new Error(`Access's certs answered ${response.status}`);
    const certs: unknown = await response.json();

    if (!Value.Check(Certs, certs)) throw new Error("Access's certs hold no RSA keys");

    return new Map(
      await Promise.all(
        certs.keys.map(async ({ kid, kty, n, e }) => [kid, await crypto.subtle.importKey("jwk", { kty, n, e }, RS256, false, ["verify"])] as const)
      )
    );
  }
}
