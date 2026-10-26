/**
 * Cloudflare Access, faked at its boundary for the worker tests, the local stack, the harness and
 * the Playwright suite. Access's part in ky is two things, both faked here as Access does them:
 *
 * - the team's signing keys, at `https://<team>/cdn-cgi/access/certs` (`certs`), and
 * - the JWT it signs for the owner and puts in `Cf-Access-Jwt-Assertion` (`sign`). A browser holds it
 *   as the `CF_Authorization` cookie, which Access's edge turns into that header (`edge`).
 *
 * Every FakeAccess starts with the same test key, so a JWT signed in Node checks in the stack's
 * Worker. `rotate` brings in a new key ahead of it, as Access rotates its keys; a fresh `stranger`
 * has a key the team never published. It uses only WebCrypto, so it runs in Node and in workerd.
 */
import { ASSERTION, bypassed } from "../access/contract.ts";

/** The team, app and owner of src/tests/wrangler.jsonc's ACCESS_* vars. */
const TEAM = "ky-test.cloudflareaccess.com";

export const AUD = "ky-test-aud";

export const OWNER = "owner@ky.test";

/** The cookie Access signs a browser in with. */
const COOKIE = "CF_Authorization";

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

const DAY_S = 24 * 60 * 60;

/** A 2048-bit RSA key for tests only: it signs nothing outside them. */
const TEST_KEY: JsonWebKey = {
  kty: "RSA",
  n: "rpmdNRe6cVaWqZidagPvjwgrpdYHUb2lmvMf3ju6WW0n_DL6rK1u5c8YTvLnKUHF8IP7V053s1Trz56vweP_LApyzm3RcfW50_PBX2lr-pzEWLCifAr-3LMxFOaRgWyPxp2WSbgr77I5gQ02FBYBQvWuBPVdAVsYexxQ2fYwSYjuDfbGFkki5r3s0W0rapY3tPrAo_CMc0_dXuEVRVwk8MIsi3aqIgzt-3URQpmM-YEhZmXuRJsQIVEoCwbNBWF-R7irKV30TUf85o6q0IkIvgKJ4MY9WRk3d-A-g2_vcbYouz-kL2W9xd8RdLyXnzKMslicOEHTh2lEnuQNGVucww",
  e: "AQAB",
  d: "P0Si1s5WXSOHTMVkpTnv4OCREHLSDCiwjclzzs_N4wHO73B5rYDbIqM8p78VTLnsxA7PUP-6GF25ZW6XOaconAjdOThKIQVt5QP7GlvVKOcNryWye0hwugCk1HIIX-G657nK78OxCBaJB96FrhmbM2xbNqjCnu8nm9TS52hybvJ6OCLk1USiCUJOuMHonwbkrU5k18ajUHF3aP8WgXtzpKpnt3LdE4xpuyHPC2BNW-suspGpnS7PCyHwOrQ95AVyIbTXtJbQwIRBdQhUEfpdHndTmsthIN5KeZYWsHu2SoYQElVEIfTf5ZdZ_cuy1ZtbLlwxYhEb_AZypZiDnDHJwQ",
  p: "03EYuc_5W03-W0T4OXAfZ8gmDsNEJTH37ABDinJzVONqPVJ_55v1sBQMM0njWglyXW-IcBGGGsxPhCDhxsqNF70F9d0Qnjlpd2Ulv0LWpheczTt-aovylAuanX_tDS6U6evWVGyvDPFAHz941Do0lvwhBBudWQNPKpr47kTP5zs",
  q: "02T4_LTwtXdTuiJVR9y3iaNokj9pk_rgwymCKrRcGhY_RBrLrYqwQkOPkJo-fdVyePX0sHI0QrXimedsS1jvJ42vM0cOtl7X0RR4j4MFJCk3iJ7o6x44wW907ZDqxZBPT-GX5abvEirpM8fEKoWnJuR9tYnAObH_d9e65mEZmBk",
  dp: "K_igGLw8chV1KQvdxywfC9keuQE4obeThFvFr_v_Kg8lH92RRdw0KsrwgpYCFs5SH0Y7jHrIdbg5bRPdgBbNYrtniurPMuhjm3XIdM70jpPogvG1Z3j1GH6VR927sXsXctIdv27etIVTPWxYt2HnX-LNBuqrPUCn7QdPb1WWGtM",
  dq: "E6F-1cjfyZpJNjHWBZRjnu6D2YD2Bv33PWhvZBPXsbx7J5HtdDI66AxqGp2YTAs0VDNTA8e3PrKxVmV9UwnxO5UWvgZNQXZRSGNERt997Lu_InrPWnY2AxCcpSseAjbChsKGXpdAAEnn2h0lBGXg_eWeHuup5DG5baGlA5vkypE",
  qi: "MSLl-AdUK-GMrRQkzNjZEwe1BstbZk2biTDky32p7gtrW4rc7JYInpCFniWIBf_1LmFHSfIR-SWWZ-4_zidoqDDy-NfnNRs2GfjHxWAGkDiayKXm2y0FKf4sJQyPv7-l2hOvpty3oz0XWGlEPjvIptjXc8cMAxbHYzj2DYXtuLc",
};

const TEST_KID = "ky-test-key";

/** What a JWT from Access says; a test sets any of it. */
export type Claims = { aud: string | string[]; iss: string; email: string; exp: number; nbf: number; iat: number; sub: string; type: string };

type Key = { kid: string; jwk: JsonWebKey };

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A JWT's header, as Access writes it. */
type Header = { alg: "RS256"; kid: string; typ: "JWT" };

const encode = (part: Header | Claims) => base64url(new TextEncoder().encode(JSON.stringify(part)));

async function newKey(): Promise<Key> {
  const pair = await crypto.subtle.generateKey({ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);

  return { kid: crypto.randomUUID(), jwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

export class FakeAccess {
  /** The team's keys, newest first: it signs with the first. */
  #keys: Key[];
  /** How many times the certs were fetched. */
  certFetches = 0;

  constructor(keys: Key[] = [{ kid: TEST_KID, jwk: TEST_KEY }]) {
    this.#keys = keys;
  }

  /** An Access whose key the team never published. */
  static async stranger(): Promise<FakeAccess> {
    return new FakeAccess([await newKey()]);
  }

  /** The team's certs; any other URL is a 404. */
  readonly certs = async (url: string): Promise<Response> => {
    if (url !== `https://${TEAM}/cdn-cgi/access/certs`) return new Response("Not found", { status: 404 });
    this.certFetches += 1;

    return Response.json({
      keys: this.#keys.map(({ kid, jwk: { kty, n, e } }) => ({ kid, kty, alg: "RS256", use: "sig", n, e })),
      public_cert: { kid: this.#keys[0]!.kid, cert: "" },
      public_certs: []
    });
  };

  /** A new signing key; the old one is still published, as Access keeps it for a while. */
  async rotate(): Promise<void> {
    this.#keys = [await newKey(), ...this.#keys];
  }

  /** A JWT for the owner, valid for a day, as Access signs it; `claims` overrides any of it, `kid` names another key. */
  async sign(claims: Partial<Claims> = {}, kid?: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const [key] = this.#keys;
    const body: Claims = { aud: [AUD], iss: `https://${TEAM}`, email: OWNER, exp: now + DAY_S, nbf: now, iat: now, sub: "owner", type: "app", ...claims };
    const signing = `${encode({ alg: "RS256", kid: kid ?? key!.kid, typ: "JWT" })}.${encode(body)}`;
    const privateKey = await crypto.subtle.importKey("jwk", key!.jwk, RS256, false, ["sign"]);
    const signature = await crypto.subtle.sign(RS256, privateKey, new TextEncoder().encode(signing));

    return `${signing}.${base64url(new Uint8Array(signature))}`;
  }
}

/** The headers of a request Access let the owner through with. */
export async function signedIn(access = new FakeAccess()): Promise<Record<string, string>> {
  return { [ASSERTION]: await access.sign() };
}

/** A cookie a browser signed in to Access holds. */
export async function accessCookie(url: string, access = new FakeAccess()): Promise<{ name: string; value: string; url: string }> {
  return { name: COOKIE, value: await access.sign(), url };
}

/**
 * Access's edge as far as the stack needs it: a browser's CF_Authorization cookie becomes the
 * assertion header on every path outside BYPASS. A request without it reaches the Worker as it
 * came, so the Worker's own check is what refuses it.
 */
export function edge(request: Request): Request {
  const cookie = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === COOKIE)?.[1];

  if (!cookie || bypassed(new URL(request.url).pathname)) return request;
  const headers = new Headers(request.headers);
  headers.set(ASSERTION, cookie);

  return new Request(request, { headers });
}
