import type { JsonValue } from "@earendil-works/pi-ai";
import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiClientMessage } from "../protocol";
import { connect, follow, inside, promptTool } from "./drive";
import { peerVaultName, type Vault as TestVault } from "./stack";

/**
 * Peers (src/peers.ts): two test kys pair as two deploys do. Each is its own agent, with its own
 * Vault, at `https://<name>.peer.test`, where the stack sends only its peer routes; the peer tool
 * reaches the other through them, so both sides run ky's real routes, tool and Vault.
 */

/** A fresh test ky that knows its own address, as one a browser opened. */
async function ky(prefix: string): Promise<string> {
  const name = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  await inside(name, (instance) => instance.setup.opened(`https://${name}.peer.test/`));

  return name;
}

const address = (name: string) => `https://${name}.peer.test`;

/** What the peer tool answers in `name`'s main chat. */
async function peer(name: string, args: Record<string, string>): Promise<string> {
  const { text } = await promptTool(name, `tool peer ${JSON.stringify(args)}`);

  return text?.replace(/^tool said: /, "") ?? "";
}

/** An invite from `name` for a peer it calls `what`: the code. */
async function invite(name: string, what: string): Promise<string> {
  const said = await peer(name, { action: "invite", name: what });
  expect(said).toContain(`Address: ${address(name)}`);

  return /^Code: (\S+)$/m.exec(said)![1]!;
}

/** Ana's ky invites Ben's as "benky"; Ben's pairs with it as "anaky". */
async function paired(): Promise<{ ana: string; ben: string }> {
  const ana = await ky("ana");
  const ben = await ky("ben");
  const code = await invite(ana, "benky");
  expect(await peer(ben, { action: "pair", name: "anaky", address: address(ana), code })).toBe(`Paired with anaky (${address(ana)}).`);

  return { ana, ben };
}

// SAFETY: src/tests/wrangler.jsonc binds Vault to the test stack's subclass.
const vaultOf = (name: string) => (env.Vault as DurableObjectNamespace<TestVault>).getByName(peerVaultName(name));

describe("pairing with another person's ky", () => {
  it("pairs two kys with an invite code, and each lists the other as on", async () => {
    const { ana, ben } = await paired();

    expect(await peer(ana, { action: "list" })).toContain(`- benky, ${address(ben)}: on`);
    expect(await peer(ben, { action: "list" })).toContain(`- anaky, ${address(ana)}: on`);
  });

  it("refuses a wrong, a used, or an expired code, and pairs nothing", async () => {
    const { ana } = await paired();
    const carl = await ky("carl");
    const wrong = await peer(carl, { action: "pair", name: "anaky", address: address(ana), code: "0".repeat(64) });
    expect(wrong).toBe("That code is wrong, used or expired. Ask for a new one.");

    const code = await invite(ana, "dee");
    await vaultOf(ana).ahead(11 * 60_000);
    expect(await peer(carl, { action: "pair", name: "anaky", address: address(ana), code })).toBe(wrong);
    await vaultOf(ana).ahead(0);

    const fresh = await invite(ana, "carlky");
    expect(await peer(carl, { action: "pair", name: "anaky", address: address(ana), code: fresh })).toContain("Paired with anaky");
    const dee = await ky("dee");
    expect(await peer(dee, { action: "pair", name: "anaky", address: address(ana), code: fresh })).toBe(wrong);

    expect(await peer(dee, { action: "list" })).toMatch(/^No peers yet/);
    expect(await peer(ana, { action: "list" })).not.toContain("- dee,");
  });

  it("unpairing on one side shows it revoked on the other at its next call, both ways", async () => {
    const { ana, ben } = await paired();

    expect(await peer(ben, { action: "remove", name: "anaky" })).toMatch(/^Removed anaky/);
    expect(await peer(ben, { action: "list" })).toMatch(/^No peers yet/);
    expect(await peer(ana, { action: "list" })).toContain(`- benky, ${address(ben)}: revoked`);

    // Ana's side let go of its token too: Ben's ky, had it kept its own, would be refused.
    expect(await vaultOf(ana).peerToken("benky")).toBeNull();
  });

  it("won't take a name it already has, or its own address", async () => {
    const { ana } = await paired();

    expect(await peer(ana, { action: "invite", name: "benky" })).toMatch(/^There is already a peer named benky/);
    expect(await peer(ana, { action: "pair", name: "self", address: address(ana), code: "x" })).toBe("That is this ky's own address.");
    expect(await peer(ana, { action: "pair", name: "Not A Name", address: address(ana), code: "x" })).toMatch(/needs a name/);
  });
});

/** Settings › Peers on `name`'s ky: a socket, as the page opens it, that sends one message and reads its result. */
async function settings(name: string): Promise<(message: PiClientMessage) => Promise<JsonValue | undefined>> {
  const socket = await connect(name);
  const client = follow(socket);
  await client.until(() => client.frames.some((frame) => frame.type === "events"));
  // The socket came in at ky.test; this test ky's address is its own.
  await inside(name, (instance) => instance.setup.opened(`${address(name)}/`));

  return async (message) => {
    const id = crypto.randomUUID();
    socket.send(JSON.stringify({ ...message, id }));
    await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === id));
    const frame = client.frames.find((each) => each.type === "result" && each.id === id);

    return frame?.type === "result" ? frame.result : undefined;
  };
}

describe("Settings › Peers", () => {
  it("invites, pairs, lists and removes, as the chat's peer tool does", async () => {
    const ana = await ky("ana");
    const ben = await ky("ben");
    const anaPage = await settings(ana);
    const benPage = await settings(ben);

    expect(await anaPage({ type: "peer-list" })).toEqual([]);
    expect(await anaPage({ type: "peer-invite", name: "Ben's" })).toMatchObject({ refused: expect.stringMatching(/needs a name/) });
    const invite = await anaPage({ type: "peer-invite", name: "benky" });
    expect(invite).toMatchObject({ address: address(ana), code: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // SAFETY: matched just above.
    const { code } = invite as { code: string };

    expect(await benPage({ type: "peer-pair", name: "anaky", address: address(ana), code })).toEqual({ address: address(ana) });
    expect(await benPage({ type: "peer-pair", name: "again", address: address(ana), code })).toMatchObject({ refused: expect.stringMatching(/wrong, used or expired/) });
    expect(await anaPage({ type: "peer-list" })).toEqual([{ name: "benky", address: address(ben), state: "on" }]);

    expect(await anaPage({ type: "peer-remove", name: "benky" })).toEqual({ removed: "benky" });
    expect(await anaPage({ type: "peer-remove", name: "benky" })).toMatchObject({ refused: "No peer named benky." });
    expect(await benPage({ type: "peer-list" })).toEqual([{ name: "anaky", address: address(ana), state: "revoked" }]);
  });
});

describe("the peer routes", () => {
  it("are open to other kys without a sign-in, and take only a peer's token", async () => {
    const { ana, ben } = await paired();
    const ping = (token: string) => SELF.fetch(`${address(ana)}/peer/v1/ping`, { headers: { Authorization: `Bearer ${token}` } });

    // Through ky's own Worker, signed out: the peer route answers, not Access.
    const signedOut = await SELF.fetch("https://ky.test/peer/v1/ping");
    expect([signedOut.status, await signedOut.text()]).toEqual([401, "Unauthorized"]);

    expect((await ping("0".repeat(64))).status).toBe(401);
    expect((await ping((await vaultOf(ben).peerToken("anaky"))!)).status).toBe(204);
    expect((await SELF.fetch(`${address(ana)}/peer/v1/nothing`)).status).toBe(404);
    expect((await SELF.fetch(`${address(ana)}/peer/v1/pair`)).status).toBe(405);
  });

  it("refuses a pairing that isn't one, and limits attempts from one address", async () => {
    const ana = await ky("ana");
    const from = crypto.randomUUID();

    const attempt = (body: { code: string; address: string; token: string }) =>
      SELF.fetch(`${address(ana)}/peer/v1/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": from },
        body: JSON.stringify(body)
      });

    expect((await attempt({ code: "x", address: "ftp://nope", token: "0".repeat(64) })).status).toBe(400);
    const statuses: number[] = [];

    for (let i = 0; i < 11; i++) statuses.push((await attempt({ code: "x", address: "https://other.test", token: "0".repeat(64) })).status);

    expect(statuses).toContain(401);
    expect(statuses.at(-1)).toBe(429);
  });
});
