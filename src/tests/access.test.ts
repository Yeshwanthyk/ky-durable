import { describe, expect, it } from "vitest";
import { ASSERTION, BYPASS, bypassed } from "../access/contract";
import { call } from "./drive";
import { AUD, FakeAccess, OWNER } from "./fake-access";

/**
 * Cloudflare Access in front of ky (C3): the stack's Worker checks the JWTs
 * fake-access.ts signs, as production's checks the team's.
 */

const FILE = "/files/0123456789abcdef0123456789abcdef";

const REFUSED = "Sign in to ky through Cloudflare Access.";

/** A request to ky's Worker with Access's JWT `jwt`; null sends none. */
function asked(path: string, jwt: string | null, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(ASSERTION, jwt ?? "");

  return call(path, { ...init, headers, redirect: "manual" });
}

describe("Access", () => {
  it("refuses pages, the API, sockets and the test routes without Access's JWT, even with Access's email header", async () => {
    const forged = { "Cf-Access-Authenticated-User-Email": OWNER };

    for (const headers of [{}, forged]) {
      for (const [path, init] of [
        ["/", {}],
        [FILE, {}],
        ["/api/runners/codes", { method: "POST" }],
        ["/api/inbound/hooks", { method: "POST", body: "{}" }],
        ["/api/inbound/secrets", {}],
        ["/api/inbound/asks?session=1", {}],
        ["/agents/pi-agent/me", { headers: { ...headers, Upgrade: "websocket" } }],
        ["/test/gate-runs", {}]
      ] as const) {
        const response = await asked(path, null, { headers, ...init });
        expect(response.status, `${path} with ${JSON.stringify(headers)}`).toBe(401);
        expect(await response.text()).toBe(REFUSED);
      }
    }

    expect((await asked(FILE, await new FakeAccess().sign())).status).toBe(404);
  });

  it("refuses a JWT for another app or team, signed by another key, out of its time, tampered with, or for another email", async () => {
    const access = new FakeAccess();
    const now = Math.floor(Date.now() / 1000);
    const [head, body] = (await access.sign({ exp: now + 60 * 60 })).split(".");
    const signature = (await access.sign()).split(".")[2];

    const refused = {
      "another app": await access.sign({ aud: ["not-ky"] }),
      "another team": await access.sign({ iss: "https://elsewhere.cloudflareaccess.com" }),
      "a key the team never published": await (await FakeAccess.stranger()).sign(),
      "a published key's id on a stranger's signature": await (await FakeAccess.stranger()).sign({}, "ky-test-key"),
      expired: await access.sign({ exp: now - 1 }),
      "not yet valid": await access.sign({ nbf: now + 10 * 60 }),
      "another JWT's signature": `${head}.${body}.${signature}`,
      unsigned: `${head}.${body}.`,
      "another email": await access.sign({ email: "intruder@ky.test" }),
      "not a JWT": "nope"
    };

    for (const [what, jwt] of Object.entries(refused)) {
      expect((await asked(FILE, jwt)).status, what).toBe(401);
    }

    // aud as Access sends it for one app, a string, and an email in another case.
    expect((await asked(FILE, await access.sign({ aud: AUD, email: "Owner@KY.test" }))).status).toBe(404);
  });

  // The manifest and icons, the rest of BYPASS, are the web app's files, which only the stack and Playwright have.
  it("lets runners, pairing and uploads through signed out, to their own checks, and not downloads", async () => {
    for (const [path, init] of [
      ["/runner/mac", { headers: { Upgrade: "websocket" } }],
      ["/api/runners/pair", { method: "POST", body: "{}" }],
      ["/api/files?task=nope", { method: "PUT" }]
    ] as const) {
      const response = await asked(path, null, init);
      expect(response.status, path).toBeGreaterThanOrEqual(400);
      expect(await response.text(), path).not.toBe(REFUSED);
    }

    // Downloads are outside BYPASS: under /api/files, Access would let them through signed out.
    expect((await asked(FILE, null)).status).toBe(401);
  });

  it("lets public sites through signed out, and not private ones", () => {
    expect(bypassed("/p/abc/")).toBe(true);
    expect(bypassed("/s/abc/")).toBe(false);
  });

  it("lets webhooks through signed out, to their own token check, and nothing else of inbound", async () => {
    // The whole list: a path added here is a path anyone reaches without signing in, the deploy's Access app too.
    expect(BYPASS).toEqual(["/runner/*", "/api/runners/pair", "/api/files", "/peer/*", "/manifest.webmanifest", "/icons/*", "/p/*", "/hooks/*"]);
    expect(bypassed("/hooks/0123456789abcdef0123456789abcdef/token")).toBe(true);

    for (const path of ["/hooks", "/hooksx/a", "/api/hooks/a", "/api/inbound/hooks", "/api/inbound/asks", "/x/hooks/a"]) expect(bypassed(path), path).toBe(false);
    const response = await asked(`/hooks/${"0".repeat(32)}/${"0".repeat(64)}`, null, { method: "POST", body: "{}", headers: { "CF-Connecting-IP": crypto.randomUUID() } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toBe(REFUSED);
  });
});
