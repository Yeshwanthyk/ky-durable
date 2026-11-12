import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { tokenRoutes } from "../runners/routes";

/**
 * The Worker's route to a runner's socket (src/runners/routes.ts), alone: what it hands the agent.
 * runners.test.ts drives it end to end, but there the agent reads the new header name first, so it
 * can't tell whether the old one was set too.
 */

// PR5b drops the X-Ky- names: until then the Worker names the pairing under both.
describe("a runner's socket, as the Worker hands it on", () => {
  it("names the pairing under both header names, over whatever the runner sent as either, and drops the token", async () => {
    const handed: Request[] = [];

    // SAFETY: the route reaches the Vault's `check` and the agent's `fetch` only.
    const fake = {
      Vault: { getByName: () => ({ check: async () => "mac:the-pairing" }) },
      PiAgent: { getByName: () => ({ fetch: async (request: Request) => (handed.push(request), new Response("handed")) }) }
    } as never;

    const request = new Request("https://ky.test/runner/mac", {
      headers: { Upgrade: "websocket", Authorization: "Bearer t", "X-Self-Hosted-Agent-Pairing": "forged", "X-Ky-Pairing": "forged" }
    });

    const response = await Effect.runPromise(tokenRoutes(request, fake, new URL(request.url))!);

    expect(await response.text()).toBe("handed");
    expect(handed.map((sent) => [sent.headers.get("X-Self-Hosted-Agent-Pairing"), sent.headers.get("X-Ky-Pairing"), sent.headers.get("Authorization")])).toEqual([
      ["the-pairing", "the-pairing", null]
    ]);
  });
});
