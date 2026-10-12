import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { login } from "../../cli/cloudflare.ts";

/**
 * The run's Cloudflare login: CLOUDFLARE_API_TOKEN, else wrangler's. A fake
 * `wrangler` on PATH says which token it would have used.
 */

let bin: string;

const saved = { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_API_BASE_URL: process.env.CLOUDFLARE_API_BASE_URL };

beforeEach(async () => {
  bin = await mkdtemp(path.join(tmpdir(), "ky-wrangler-"));
  // `wrangler auth token` prints the env's token when it isn't empty, as wrangler does (a blank one counts), else its own login's.
  await writeFile(path.join(bin, "wrangler"), '#!/bin/sh\nif [ -n "$CLOUDFLARE_API_TOKEN" ]; then echo "env:$CLOUDFLARE_API_TOKEN"; else echo wrangler-token; fi\n');
  await chmod(path.join(bin, "wrangler"), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  await rm(bin, { recursive: true, force: true });
});

/** The token `ky login` kept for the test; none unless it sets one. */
let keptToken: string | undefined;

const kept = async () => keptToken;

/** The Authorization header a call with the run's login sends. */
async function authorization(): Promise<string | undefined> {
  let seen: string | undefined;

  const server = createServer((request, response) => {
    seen = request.headers.authorization;
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, errors: [], messages: [], result: { subdomain: "me" } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a server listening on a TCP port has an AddressInfo address.
  process.env.CLOUDFLARE_API_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    await (await login(kept)).run(Workers.getSubdomain({ accountId: "acc" }));
  } finally {
    server.close();
  }

  return seen;
}

describe("the Cloudflare login", () => {
  it.each([
    ["empty", ""],
    ["blank", "  "],
    ["a newline, as $(cat missing) leaves", "\n"]
  ])("is wrangler's while CLOUDFLARE_API_TOKEN is %s, and wrangler doesn't see the blank one", async (_what, value) => {
    process.env.CLOUDFLARE_API_TOKEN = value;

    expect((await login(kept)).login).toBe("wrangler login");
    expect(await authorization()).toBe("Bearer wrangler-token");
  });

  it("is the token `ky login` kept, ahead of wrangler's, while CLOUDFLARE_API_TOKEN is unset", async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    keptToken = "token-from-ky-login";

    try {
      expect((await login(kept)).login).toBe("ky login");
      expect(await authorization()).toBe("Bearer token-from-ky-login");

      process.env.CLOUDFLARE_API_TOKEN = "token-from-env";
      expect((await login(kept)).login).toBe("CLOUDFLARE_API_TOKEN");
    } finally {
      keptToken = undefined;
    }
  });

  it("is CLOUDFLARE_API_TOKEN's when it is set, without the space around it", async () => {
    process.env.CLOUDFLARE_API_TOKEN = " token-from-env\n";

    expect((await login(kept)).login).toBe("CLOUDFLARE_API_TOKEN");
    expect(await authorization()).toBe("Bearer token-from-env");
  });
});
