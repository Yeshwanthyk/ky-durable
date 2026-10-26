import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessVars } from "../../src/access/contract";
import { LegacyAccess } from "../../src/access/legacy/access";
import { Access } from "../../src/access/wiring";
import { clockAt } from "../parity/access/clock";
import { assertParity, budget, type Clock, type Instance, type Json, type Parity } from "../parity/kit";

fc.configureGlobal({ baseSize: "large" });

const START = Date.UTC(2026, 0, 1);

const HOUR_MS = 60 * 60_000;

const MINUTE_MS = 60_000;

const TEAM = "team.cloudflareaccess.com";

const OTHER = "other.cloudflareaccess.com";

const AUD = "ky-aud";

const ALLOWED = new Set(["owner@ky.test", "dev@ky.test"]);

const EMAILS = " Owner@ky.test, ,dev@ky.test ";

const SIGN_IN = { status: 401, body: "Sign in to ky through Cloudflare Access." };

const NOT_SET_UP = {
  status: 500,
  body: "ky's Access isn't set up: it needs ACCESS_TEAM_DOMAIN, ACCESS_AUD and ACCESS_EMAILS. `ky init` sets them up: https://github.com/Yeshwanthyk/ky-durable#quickstart"
};

const TRY_AGAIN = { status: 503, body: "ky couldn't check the sign-in with Cloudflare Access; try again." };

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

const POOL = 5;

const PUBLISHABLE = POOL - 1;

type Pair = { kid: string; n: string; e: string; privateKey: CryptoKey };

let keys: Pair[] = [];

beforeAll(async () => {
  keys = await Promise.all(
    Array.from({ length: POOL }, async (_, at) => {
      const pair = await crypto.subtle.generateKey({ ...RS256, modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
      const { n = "", e = "" } = await crypto.subtle.exportKey("jwk", pair.publicKey);

      return { kid: `key-${at}`, n, e, privateKey: pair.privateKey };
    })
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

type Mode = "ok" | "down" | "failing" | "garbage" | "ec" | "empty";

const FAILING: Mode[] = ["down", "failing", "garbage", "ec"];

type World = { published: number; mode: Mode; fetched: string[] };

function world(published = 1) {
  const state: World = { published, mode: "ok", fetched: [] };
  let held = Promise.resolve();

  const hold = () => {
    let release = () => {};

    held = new Promise((resolve) => (release = resolve));

    return () => {
      held = Promise.resolve();
      release();
    };
  };

  const certs = async (url: string): Promise<Response> => {
    state.fetched.push(url);
    await held;

    if (state.mode === "down") throw new TypeError("fetch failed");

    if (url !== `https://${TEAM}/cdn-cgi/access/certs`) return new Response("Not found", { status: 404 });

    if (state.mode === "failing") return new Response("Bad gateway", { status: 502 });

    if (state.mode === "garbage") return new Response("<html>signing in</html>");
    const shown = state.mode === "empty" ? [] : keys.slice(0, state.published);

    return Response.json({ keys: shown.map(({ kid, n, e }) => ({ kid, kty: state.mode === "ec" ? "EC" : "RSA", alg: "RS256", use: "sig", n, e })) });
  };

  return { state, certs, hold, rotate: () => void (state.published = Math.min(state.published + 1, PUBLISHABLE)) };
}

type Flaw = "plain" | "expString" | "expHuge" | "nbfNull" | "noEmail" | "audNumber";

type Tamper = "none" | "signedOther" | "garbled" | "extra" | "alg";

type Claims = { aud: "app" | "apps" | "other"; iss: string; email: string; exp: number; nbf: number | null; flaw: Flaw };

type Token = { kind: "none" } | { kind: "raw"; text: string } | { kind: "jwt"; key: number; kid: number; claims: Claims; tamper: Tamper; std: boolean };

const anEmail = fc.constantFrom("owner@ky.test", "OWNER@ky.test", " owner@ky.test", "dev@ky.test", "stranger@ky.test", "");

const anOffset = fc.oneof(fc.constantFrom(-61, -60, -1, 0, 1, 59, 60, 61, 86_400), fc.integer({ min: -200, max: 200 }));

const aClaims = (good: boolean, email = good ? fc.constantFrom("owner@ky.test", "OWNER@ky.test", "dev@ky.test") : anEmail): fc.Arbitrary<Claims> =>
  fc.record({
    aud: good ? fc.constantFrom("app" as const, "apps" as const) : fc.constantFrom("app" as const, "apps" as const, "other" as const),
    iss: good ? fc.constant(`https://${TEAM}`) : fc.constantFrom(`https://${TEAM}`, `https://${OTHER}`, TEAM),
    email,
    exp: good ? fc.integer({ min: 61, max: 86_400 }) : anOffset,
    nbf: good ? fc.constantFrom(null, -10, 0) : fc.oneof(fc.constant(null), anOffset),
    flaw: good ? fc.constant("plain" as const) : fc.constantFrom<Flaw>("plain", "plain", "plain", "expString", "expHuge", "nbfNull", "noEmail", "audNumber")
  });

const aJwt = (good: boolean, keyAt: fc.Arbitrary<number>, claims = aClaims(good)): fc.Arbitrary<Token> =>
  fc.record({
    kind: fc.constant("jwt" as const),
    key: keyAt,
    kid: good ? fc.constant(null) : fc.option(fc.integer({ min: 0, max: POOL - 1 }), { freq: 4 }),
    claims,
    tamper: good ? fc.constant<Tamper>("none") : fc.constantFrom<Tamper>("none", "none", "none", "signedOther", "garbled", "extra", "alg"),
    std: fc.boolean()
  }).map(({ kid, ...token }) => ({ ...token, kid: kid ?? token.key }));

const aRaw: fc.Arbitrary<Token> = fc.constantFrom("", "nope", "a.b.c", "..", "e30.e30.", "e30.e30.e30.e30").map((text) => ({ kind: "raw" as const, text }));

const aToken = (keyAt = fc.integer({ min: 0, max: POOL - 1 })): fc.Arbitrary<Token> =>
  fc.oneof({ arbitrary: aJwt(false, keyAt), weight: 4 }, { arbitrary: aJwt(false, keyAt, aClaims(true, anEmail)), weight: 4 }, { arbitrary: aRaw, weight: 1 }, { arbitrary: fc.constant<Token>({ kind: "none" }), weight: 1 });

const encode = (text: string, std: boolean) => (std ? Buffer.from(text).toString("base64") : Buffer.from(text).toString("base64url"));

const AUDS = { app: JSON.stringify(AUD), apps: JSON.stringify(["someone-else", AUD]), other: JSON.stringify("someone-else") };

function bodyText(claims: Claims, nowS: number, email = claims.email): string {
  const at = Math.floor(nowS);
  const aud = claims.flaw === "audNumber" ? "7" : AUDS[claims.aud];
  const exp = claims.flaw === "expString" ? `"${at + claims.exp}"` : claims.flaw === "expHuge" ? "1e999" : `${at + claims.exp}`;
  const nbf = claims.flaw === "nbfNull" ? `,"nbf":null` : claims.nbf === null ? "" : `,"nbf":${at + claims.nbf}`;
  const mail = claims.flaw === "noEmail" ? "" : `"email":${JSON.stringify(email)},`;

  return `{"aud":${aud},"iss":${JSON.stringify(claims.iss)},${mail}"exp":${exp}${nbf},"sub":"owner","type":"app"}`;
}

const signatures = new Map<string, Promise<string>>();

function signature(key: number, input: string): Promise<string> {
  const id = `${key}|${input}`;
  const known = signatures.get(id);

  if (known) return known;

  const made = crypto.subtle
    .sign(RS256, keys[key]!.privateKey, new TextEncoder().encode(input))
    .then((bytes) => Buffer.from(bytes).toString("base64url"));

  signatures.set(id, made);

  return made;
}

async function jwt(token: Token, nowS: number): Promise<string | undefined> {
  if (token.kind === "none") return undefined;

  if (token.kind === "raw") return token.text;
  const alg = token.tamper === "alg" ? "HS256" : "RS256";
  const head = encode(`{"alg":"${alg}","kid":"${keys[token.kid]!.kid}","typ":"JWT"}`, token.std);
  const body = encode(bodyText(token.claims, nowS), token.std);
  const signed = token.tamper === "signedOther" ? `${head}.${encode(bodyText(token.claims, nowS, "intruder@ky.test"), token.std)}` : `${head}.${body}`;
  const sig = token.tamper === "garbled" ? "!!" : await signature(token.key, signed);

  return `${head}.${body}.${sig}${token.tamper === "extra" ? ".e30" : ""}`;
}

type Answer = { status: number; body: string } | null;

type Refuser = { refuse(request: Request, env: AccessVars): Promise<Response | undefined> };

async function answer(access: Refuser, assertion: string | undefined, env: AccessVars): Promise<Answer> {
  const request = new Request("https://ky.test/api/chats", { headers: assertion === undefined ? {} : { "Cf-Access-Jwt-Assertion": assertion } });
  const response = await access.refuse(request, env);

  return response ? { status: response.status, body: await response.text() } : null;
}

const ask = async (access: Refuser, token: Token, env: AccessVars, now: number) => answer(access, await jwt(token, now / 1000), env);

const nextTask = () => new Promise((resolve) => setImmediate(resolve));

const VARS: AccessVars = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_EMAILS: EMAILS };

const decodes = (token: Token) => token.kind === "jwt" && token.tamper !== "extra" && token.tamper !== "alg" && token.claims.flaw === "plain";

function holds(claims: Claims, team: string, nowS: number): boolean {
  const at = Math.floor(nowS);

  return claims.iss === `https://${team}` && claims.aud !== "other" && at + claims.exp > nowS && (claims.nbf === null || at + claims.nbf <= nowS + 60);
}

const checksKey = (token: Token, team: string, nowS: number) => token.kind === "jwt" && decodes(token) && holds(token.claims, team, nowS);

function admitted(token: Token, published: number, nowS: number): boolean {
  if (token.kind !== "jwt" || !checksKey(token, TEAM, nowS)) return false;

  return token.tamper === "none" && token.kid === token.key && token.key < published && ALLOWED.has(token.claims.email.toLowerCase());
}

function fresh(published = 1, now = START) {
  const team = world(published);
  let at = now;
  const access = new Access(team.certs, clockAt(() => at));

  return { team, access, ask: (token: Token, env = VARS) => ask(access, token, env, at), advance: (ms: number) => void (at += ms), now: () => at };
}

const runs = () => ({ numRuns: budget().numRuns, seed: budget().seed });

describe("a sign-in", () => {
  it("I-A1: passes only for a JWT a published key signed under its own kid, naming the app and the team, inside its times, for an email ACCESS_EMAILS holds without case; anything else is B's 401", async () => {
    await fc.assert(
      fc.asyncProperty(aToken(), fc.integer({ min: 1, max: PUBLISHABLE }), async (token, published) => {
        const ky = fresh(published);

        expect(await ky.ask(token)).toEqual(admitted(token, published, START / 1000) ? null : SIGN_IN);
      }),
      runs()
    );
  });

  it("I-A4: holds while exp is after the Clock's now and nbf is at most a minute past it, in seconds", async () => {
    await fc.assert(
      fc.asyncProperty(
        aJwt(true, fc.constant(0)),
        fc.oneof(fc.constantFrom(-1, 0, 1), fc.integer({ min: -90, max: 90 })),
        fc.option(fc.oneof(fc.constantFrom(59, 60, 61), fc.integer({ min: -90, max: 90 })), { nil: null }),
        fc.constantFrom(0, 1, 500, 999),
        fc.integer({ min: 0, max: 10 * 86_400 }),
        async (token, exp, nbf, ms, seconds) => {
          const now = START + seconds * 1000 + ms;
          const timed: Token = token.kind === "jwt" ? { ...token, claims: { ...token.claims, exp, nbf } } : token;
          const ky = fresh(1, now);

          expect(await ky.ask(timed)).toEqual(admitted(timed, 1, now / 1000) ? null : SIGN_IN);
        }
      ),
      runs()
    );
  });
});

type Env = { emails: string | undefined; dev: string | undefined; devEmail: string | undefined; team: string | undefined; aud: string | undefined };

const anEnv: fc.Arbitrary<Env> = fc.record({
  emails: fc.constantFrom(EMAILS, "owner@ky.test", "", " , ", undefined),
  dev: fc.constantFrom(undefined, "1", "0", "true"),
  devEmail: fc.constantFrom(undefined, "", "dev@ky.test", "DEV@ky.test", "stranger@ky.test"),
  team: fc.constantFrom(TEAM, "", undefined),
  aud: fc.constantFrom(AUD, "", undefined)
});

const varsOf = ({ emails, dev, devEmail, team, aud }: Env): AccessVars => ({
  ACCESS_EMAILS: emails,
  KY_DEV: dev,
  KY_DEV_EMAIL: devEmail,
  ACCESS_TEAM_DOMAIN: team,
  ACCESS_AUD: aud
});

const allowedBy = (emails: string) => new Set(emails.split(",").map((email) => email.trim().toLowerCase()).filter((email) => email !== ""));

describe("Access's vars", () => {
  it("I-A2: decide before any JWT: no ACCESS_EMAILS is not set up, KY_DEV=1 signs in KY_DEV_EMAIL against them, no team or app is not set up; none of it fetches the keys", async () => {
    await fc.assert(
      fc.asyncProperty(anEnv, aToken(fc.constant(0)), async (env, token) => {
        const ky = fresh();
        const answer = await ky.ask(token, varsOf(env));
        const devPass = env.devEmail !== undefined && allowedBy(env.emails ?? "").has(env.devEmail.toLowerCase());
        const decided = !env.emails ? NOT_SET_UP : env.dev === "1" ? (devPass ? null : SIGN_IN) : !env.team || !env.aud ? NOT_SET_UP : undefined;

        if (decided === undefined) expect(answer).not.toEqual(NOT_SET_UP);
        else expect([answer, ky.team.state.fetched]).toEqual([decided, []]);
      }),
      runs()
    );
  });
});

describe("the team's keys", () => {
  it("I-A3: a fetch that fails, answers non-2xx, or holds no RSA keys is B's 503 and isn't kept; a JWT that can't pass without them never fetches", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...FAILING), aJwt(true, fc.constant(0)), aToken(fc.constant(0)), async (mode, good, any) => {
        const ky = fresh();
        ky.team.state.mode = mode;

        expect(await ky.ask(good)).toEqual(TRY_AGAIN);
        ky.team.state.mode = "ok";

        expect(await ky.ask(good)).toEqual(null);
        expect(ky.team.state.fetched).toHaveLength(2);

        const other = fresh();
        other.team.state.mode = mode;
        const answer = await other.ask(any);

        expect(other.team.state.fetched.length > 0).toBe(checksKey(any, TEAM, START / 1000));

        if (other.team.state.fetched.length === 0) expect(answer).toEqual(SIGN_IN);
      }),
      runs()
    );
  });

  it("I-A7: requests in flight together share one fetch, and its failure", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<Mode>("ok", ...FAILING), aJwt(true, fc.constant(0)), aJwt(true, fc.constant(0)), async (mode, early, late) => {
        const ky = fresh();
        ky.team.state.mode = mode;
        const [a, b] = await Promise.all([jwt(early, START / 1000), jwt(late, START / 1000)]);
        const release = ky.team.hold();
        const first = answer(ky.access, a, VARS);
        await nextTask();
        const second = answer(ky.access, b, VARS);
        await nextTask();
        release();
        const expected = mode === "ok" ? null : TRY_AGAIN;

        expect([await first, await second, ky.team.state.fetched.length]).toEqual([expected, expected, 1]);
      }),
      runs()
    );
  });

  type Step = { advance: number } | { ask: number } | "rotate";

  const aStep = (unknown: boolean): fc.Arbitrary<Step> =>
    fc.oneof(
      fc.record({ advance: fc.constantFrom(1, MINUTE_MS - 1, MINUTE_MS, HOUR_MS - 1, HOUR_MS, 7 * MINUTE_MS) }),
      fc.record({ ask: unknown ? fc.integer({ min: 0, max: POOL - 1 }) : fc.constant(0) }),
      ...(unknown ? [fc.constant<Step>("rotate")] : [])
    );

  async function keptKeys(steps: Step[]) {
    const ky = fresh();
    const model = { last: Number.NEGATIVE_INFINITY, known: 0, fetches: 0 };

    const fetch = () => {
      model.last = ky.now();
      model.known = ky.team.state.published;
      model.fetches += 1;
    };

    for (const step of steps) {
      if (step === "rotate") ky.team.rotate();
      else if ("advance" in step) ky.advance(step.advance);
      else {
        if (ky.now() - model.last >= HOUR_MS) fetch();

        if (step.ask >= model.known && ky.now() - model.last >= MINUTE_MS) fetch();
        const token: Token = { kind: "jwt", key: step.ask, kid: step.ask, claims: { aud: "app", iss: `https://${TEAM}`, email: "owner@ky.test", exp: 3600, nbf: 0, flaw: "plain" }, tamper: "none", std: false };

        expect(await ky.ask(token)).toEqual(step.ask < model.known ? null : SIGN_IN);
        expect(ky.team.state.fetched).toHaveLength(model.fetches);
      }
    }
  }

  it("I-A5: are kept for an hour by the Clock, then fetched again", async () => {
    await fc.assert(fc.asyncProperty(fc.array(aStep(false), { maxLength: budget().maxCommands }), keptKeys), runs());
  });

  it("I-A6: a key id they lack fetches them again at most once a minute, so a key Access rotates in works within a minute", async () => {
    await fc.assert(fc.asyncProperty(fc.array(aStep(true), { maxLength: budget().maxCommands }), keptKeys), runs());
  });
});

type Action = { ask: Token; env: "vars" | "other" | Env } | { race: [Token, Token] } | "rotate" | { mode: Mode };

const anAction: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: fc.record({ ask: aToken(), env: fc.oneof({ arbitrary: fc.constant<"vars">("vars"), weight: 6 }, fc.constant<"other">("other"), anEnv) }), weight: 8 },
  { arbitrary: fc.record({ race: fc.tuple(aToken(), aToken()) }), weight: 2 },
  { arbitrary: fc.constant<Action>("rotate"), weight: 1 },
  { arbitrary: fc.record({ mode: fc.constantFrom<Mode>("ok", "ok", "ok", ...FAILING, "empty") }), weight: 1 }
);

const envOf = (env: "vars" | "other" | Env): AccessVars => (env === "vars" ? VARS : env === "other" ? { ...VARS, ACCESS_TEAM_DOMAIN: OTHER } : varsOf(env));

function side(clock: Clock, make: (certs: (url: string) => Promise<Response>) => Refuser): Instance<Action> {
  const team = world();
  const access = make(team.certs);

  return {
    apply: async (action): Promise<Json> => {
      if (action === "rotate") team.rotate();
      else if ("mode" in action) team.state.mode = action.mode;

      if (action === "rotate" || "mode" in action) return null;

      if ("race" in action) {
        const [early, late] = await Promise.all(action.race.map((token) => jwt(token, clock.now() / 1000)));
        const release = team.hold();
        const first = answer(access, early, VARS);
        await nextTask();
        const second = answer(access, late, VARS);
        await nextTask();
        release();

        return Promise.all([first, second]);
      }

      return ask(access, action.ask, envOf(action.env), clock.now());
    },
    tables: async () => null,
    effects: async () => [...team.state.fetched],
    dispose: async () => {}
  };
}

const accessParity: Parity<Action> = {
  domain: "access",
  actions: anAction,
  start: START,
  advances: fc.constantFrom(1, 999, 1000, MINUTE_MS - 1, MINUTE_MS, HOUR_MS - 1, HOUR_MS, 30 * MINUTE_MS),
  legacy: async (clock) =>
    side(clock, (certs) => {
      const access = new LegacyAccess(certs);
      access.now = () => clock.now();

      return { refuse: (request, env) => access.refuse(request, env) };
    }),
  next: async (clock) => side(clock, (certs) => new Access(certs, clockAt(() => clock.now())))
};

describe("access parity", () => {
  it("answers and fetches what B does, step for step", async () => {
    await assertParity(accessParity);
  }, 600_000);
});
