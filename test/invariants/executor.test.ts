import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertParity, budget, type Json, type Parity } from "../parity/kit";
import { legacy } from "../parity/executor/legacy";
import { type Action, actions, AGENT, BASE, instanceOf, next, REFUSED_RESUME, THEIRS, TOKEN, TOKENS, URLS, World } from "../parity/executor/world";

const words = {
  noToken: "Paste an Executor personal access token.",
  notAUrl: "That isn't a URL. Paste Executor's MCP address, like https://mcp.executor.sh/mcp.",
  notHttps: "Executor's address must start with https://.",
  tokenRefused: "Executor refused that token.",
  notConnected: "Executor is not connected. Connect it in Settings › Tools › Executor.",
  otherOrigin: (origin: string) => `ky only changes the path and query here, on ${origin}. Change the host in Settings › Tools › Executor.`
};

const runs = () => ({ numRuns: Math.max(10, Math.round(budget().numRuns / 5)), seed: budget().seed });

const fresh = () => new World(next);

async function connected(): Promise<World> {
  const world = fresh();

  await world.link.connect(BASE, TOKEN);

  return world;
}

function expected(url: string, token: string): string | undefined {
  if (token.trim() === "") return words.noToken;
  const trimmed = url.trim();

  if (!URL.canParse(trimmed)) return words.notAUrl;
  const { protocol, hostname, origin } = new URL(trimmed);
  const local = hostname === "localhost" || hostname === "127.0.0.1";

  if (protocol !== "https:" && !(protocol === "http:" && local)) return words.notHttps;

  if (hostname !== "executor.test" && hostname !== "localhost") return `ky couldn't reach Executor at ${origin}: `;

  return token.trim() === TOKEN ? undefined : words.tokenRefused;
}

const anyUrl = fc.oneof(
  fc.constantFrom(...URLS, "http://127.0.0.1/mcp", "https://127.0.0.1:9/mcp", "mailto:sam@executor.test"),
  fc.webUrl({ validSchemes: ["http", "https", "ftp"] }),
  fc.string()
);

const readable = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ status: Schema.String, execution: Schema.Struct({ ok: Schema.Boolean }) })));

const anyToken = fc.oneof(fc.constantFrom(...TOKENS), fc.string());

describe("connecting Executor", () => {
  it("keeps a connection only when it has a token, a https URL (or http on this machine) and Executor takes the token, else refuses in B's words", () =>
    fc.assert(
      fc.asyncProperty(anyUrl, anyToken, async (url, token) => {
        const world = fresh();
        const answer = await world.link.connect(url, token);
        const refusal = expected(url, token);

        if (refusal === undefined) {
          expect(answer).toEqual({});
          expect(world.vault.writes).toEqual([{ put: "executor", id: AGENT, value: { url: url.trim(), token: TOKEN }, meta: { url: url.trim() } }]);
        } else {
          expect(answer.refused?.startsWith(refusal)).toBe(true);
          expect(world.vault.writes).toEqual([]);
          expect(world.changes).toBe(0);
        }
      }),
      runs()
    ));

  it("refuses a blank token with nothing saved before", async () => {
    const world = fresh();

    expect(await world.link.connect(BASE, "  ")).toEqual({ refused: words.noToken });
    expect(world.fetched).toEqual([]);
  });

  it("refuses what isn't a URL as not a URL, not as not https", async () => {
    expect(await fresh().link.connect("executor.test/mcp", TOKEN)).toEqual({ refused: words.notAUrl });
  });

  it("refuses plain http off this machine before it reaches anything", async () => {
    const world = fresh();

    expect(await world.link.connect("http://executor.test/mcp", TOKEN)).toEqual({ refused: words.notHttps });
    expect(world.fetched).toEqual([]);
    expect(await world.link.connect("http://localhost/mcp", TOKEN)).toEqual({});
  });

  it("refuses a token Executor won't take as refused, not as unreachable, and saves nothing", async () => {
    const world = fresh();

    expect(await world.link.connect(BASE, "wrong")).toEqual({ refused: words.tokenRefused });
    expect(world.executor.unauthorized).toBeGreaterThan(0);
    expect(world.vault.writes).toEqual([]);
  });

  it("refuses a host it can't reach with that host's origin and why", async () => {
    const world = fresh();
    const { refused } = await world.link.connect("https://elsewhere.test:8443/a/mcp?x=1", TOKEN);

    expect(refused).toMatch(/^ky couldn't reach Executor at https:\/\/elsewhere\.test:8443: \S/);
    expect(world.fetched).toContain("elsewhere.test:8443");
  });

  it("lists Executor's tools before it keeps a connection", async () => {
    const world = fresh();

    await world.link.connect(BASE, TOKEN);
    expect(world.executor.sessions).toBe(1);
  });

  it("keeps the connected token when the token is left blank, and saves URL and token trimmed", async () => {
    const world = fresh();

    await world.link.connect(`  ${BASE}  `, `  ${TOKEN}  `);
    expect(await world.link.connect(" https://executor.test/v2/mcp ", " ")).toEqual({});
    expect(world.vault.writes.at(-1)).toEqual({ put: "executor", id: AGENT, value: { url: "https://executor.test/v2/mcp", token: TOKEN }, meta: { url: "https://executor.test/v2/mcp" } });
  });

  it("tells its listeners after each connection it keeps and each disconnect, never after a refusal", async () => {
    const world = fresh();

    await world.link.connect(BASE, "wrong");
    await world.link.retarget(BASE);
    expect(world.changes).toBe(0);
    await world.link.connect(BASE, TOKEN);
    await world.link.retarget("https://executor.test/v2/mcp");
    await world.link.disconnect();
    await world.link.disconnect();
    expect(world.changes).toBe(4);
  });

  it("forgets the connection on disconnect", async () => {
    const world = await connected();

    await world.link.disconnect();
    expect(await world.link.config()).toBeNull();
    expect(await world.link.view()).toEqual({ url: null });
    expect(world.vault.writes.at(-1)).toEqual({ remove: "executor", id: AGENT });
  });
});

describe("retargeting Executor", () => {
  it("refuses while nothing is connected", async () => {
    const world = fresh();

    expect(await world.link.retarget(BASE)).toEqual({ refused: words.notConnected });
    expect(world.fetched).toEqual([]);
  });

  it("refuses another origin, naming the connected one, and reaches nothing", () =>
    fc.assert(
      fc.asyncProperty(fc.webUrl({ validSchemes: ["https"] }), async (url) => {
        fc.pre(new URL(url).origin !== "https://executor.test");
        const world = await connected();
        const fetched = world.fetched.length;

        expect(await world.link.retarget(url)).toEqual({ refused: words.otherOrigin("https://executor.test") });
        expect(world.fetched.length).toBe(fetched);
      }),
      runs()
    ));

  it("changes the path and query on the same origin, keeping the token", async () => {
    const world = await connected();

    expect(await world.link.retarget(" https://executor.test/v2/mcp?team=1 ")).toEqual({});
    expect(await world.link.config()).toEqual({ url: "https://executor.test/v2/mcp?team=1", token: TOKEN, fetch: world.reach });
  });

  it("passes what isn't a URL on to connect, which refuses it", async () => {
    expect(await (await connected()).link.retarget("not a url")).toEqual({ refused: words.notAUrl });
  });
});

describe("the connection ky reads", () => {
  it("shows this agent's saved URL and nobody else's", async () => {
    const world = fresh();

    expect(await world.link.view()).toEqual({ url: null });
    await world.link.connect(BASE, TOKEN);
    expect(await world.link.view()).toEqual({ url: BASE });
  });

  it("reads a damaged vault row as no connection", async () => {
    const world = fresh();

    world.vault.store(AGENT, { url: 5, token: TOKEN }, { url: 7 });
    expect(await world.link.config()).toBeNull();
    expect(await world.link.view()).toEqual({ url: null });
    world.vault.store(AGENT, "nonsense", null);
    expect(await world.link.config()).toBeNull();
    expect(await world.link.retarget(BASE)).toEqual({ refused: words.notConnected });
  });

  it("reads an empty saved URL as none", async () => {
    const world = fresh();

    world.vault.store(AGENT, { url: BASE, token: TOKEN }, { url: "" });
    expect(await world.link.view()).toEqual({ url: null });
  });
});

const outputOf = Schema.decodeUnknownSync(Schema.Struct({ output: Schema.Array(Schema.Struct({ text: Schema.String })) }));

const text = (said: Json) => outputOf(said).output.map((part) => part.text).join("\n");

describe("Executor's tools", () => {
  it("always connect in model mode, whatever elicitation_mode the saved URL holds", async () => {
    const world = fresh();

    await world.link.connect(`${BASE}?elicitation_mode=browser&team=1`, TOKEN);
    await world.apply({ kind: "execute", code: "hello" });
    expect(world.executor.connectedUrls).toEqual([`${BASE}?team=1`, `${BASE}?team=1`]);
    expect(await world.link.view()).toEqual({ url: `${BASE}?elicitation_mode=browser&team=1` });
  });

  it("never retry a call whose response was lost, since the program may have run", async () => {
    const world = await connected();
    const said = await world.apply({ kind: "execute", code: "lose-response" });

    expect(text(said)).toBe("Executor call failed: Network connection lost.");
    expect(world.executor.runs.get("lose-response")).toBe(1);
  });

  it("try a connection that never opened once more, and only once", () =>
    fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 3 }), async (refused) => {
        const world = await connected();

        world.executor.refuseConnects = refused;
        const said = await world.apply({ kind: "once", code: "hello", aborted: false });

        expect(world.executor.runs.get("hello") ?? 0).toBe(refused < 2 ? 1 : 0);
        expect(world.executor.refuseConnects).toBe(Math.max(0, refused - 2));
        expect(said).toMatchObject({ neverRan: refused >= 2 });
      }),
      runs()
    ));

  it("don't try again after the caller gave up", async () => {
    const world = await connected();

    world.executor.refuseConnects = 1;
    await world.apply({ kind: "once", code: "hello", aborted: true });
    expect(world.executor.refuseConnects).toBe(0);
    expect(world.executor.sessions).toBe(1);
  });

  it("don't try a refused token again", async () => {
    const world = await connected();
    const before = world.executor.unauthorized;

    world.executor.token = "rotated";
    const said = await world.apply({ kind: "once", code: "hello", aborted: false });

    expect(world.executor.unauthorized - before).toBe(1);
    expect(said).toMatchObject({ neverRan: false, result: { isError: true } });
  });

  it("run again on a new session when Executor forgot the old one, which ran nothing", async () => {
    const world = await connected();

    await world.apply({ kind: "execute", code: "hello" });
    world.executor.open.clear();
    const said = await world.apply({ kind: "execute", code: "hello" });

    expect(text(said)).toBe("ran 2");
    expect(world.executor.sessions).toBe(3);
  });

  it("pass Executor's answer through the gate, text as it is and anything else as JSON", async () => {
    const world = await connected();

    expect(await world.apply({ kind: "execute", code: "fail nope" })).toEqual({ output: [{ type: "text", text: "nope" }], isError: true });
    expect(await world.apply({ kind: "skills" })).toEqual({ output: [{ type: "text", text: "fake executor apps: calendar (2 skills), github (3 skills)" }], isError: false });
    expect(world.gate).toEqual([{ replied: "7", result: { output: [{ type: "text", text: "nope" }], isError: true } }]);
  });

  it("resume an answer as accept, with the answers only when there are some", async () => {
    const world = await connected();

    await world.apply({ kind: "execute", code: "ask which label" });
    await world.apply({ kind: "resume", requestId: "request-1", action: "answer", content: { label: "work" } });
    await world.apply({ kind: "resume", requestId: "request-1", action: "decline" });
    expect(world.executor.resumes).toEqual([
      { requestId: "request-1", response: { action: "accept", content: { label: "work" } } },
      { requestId: "request-1", response: { action: "decline" } }
    ]);
  });

  it("send no resume the gate refuses, and say so", async () => {
    const world = await connected();
    const said = await world.apply({ kind: "resume", requestId: THEIRS, action: "cancel" });

    expect(said).toEqual({ output: [{ type: "text", text: `Not sent: ${REFUSED_RESUME}` }], isError: true });
    expect(world.executor.resumes).toEqual([]);
    expect(world.gate).toEqual([{ beforeResume: THEIRS, action: "cancel", conversation: "7" }]);
  });

  it("show the connection, or change it and say where, or say why not", async () => {
    const world = await connected();

    expect(await world.apply({ kind: "connection" })).toEqual({ output: [{ type: "text", text: `Executor is connected at ${BASE}.` }] });
    expect(await world.apply({ kind: "connection", url: " https://executor.test/v2 " })).toEqual({
      output: [{ type: "text", text: "Executor is now connected at https://executor.test/v2. Its tools reconnect there on their next call." }]
    });
    expect(await world.apply({ kind: "connection", url: "https://elsewhere.test/mcp" })).toEqual({
      output: [{ type: "text", text: `Not changed: ${words.otherOrigin("https://executor.test")}` }],
      isError: true
    });
  });
});

describe("a program's outcome", () => {
  const outcomeOf = (said: string) => fresh().apply({ kind: "outcome", text: said });
  const envelope = (status: string, execution: { ok: boolean; value?: Json; error?: Json }) => JSON.stringify({ status, execution });

  it("is paused whenever Executor waits for the user", () =>
    fc.assert(
      fc.asyncProperty(fc.constantFrom("approval", "input"), fc.constantFrom(":", " : "), fc.string(), async (kind, colon, rest) => {
        expect(await outcomeOf(`{"status"${colon}"${kind}-required"${rest}`)).toEqual({ kind: "paused" });
      }),
      runs()
    ));

  it("is the value a completed program returned", () =>
    fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (value) => {
        expect(await outcomeOf(envelope("completed", { ok: true, value }))).toEqual(JSON.parse(JSON.stringify({ kind: "returned", value })));
      }),
      runs()
    ));

  it("is the value even when it is null or absent", async () => {
    expect(await outcomeOf(envelope("completed", { ok: true, value: null }))).toEqual({ kind: "returned", value: null });
    expect(await outcomeOf(envelope("completed", { ok: true }))).toEqual({ kind: "returned" });
  });

  it("fails with what Executor said when it didn't complete", async () => {
    expect(await outcomeOf(envelope("failed", { ok: true, value: 1 }))).toEqual({ kind: "failed", text: "Executor said failed" });
  });

  it("fails with the program's error: its text, its message, else its JSON, else that it failed", async () => {
    expect(await outcomeOf(envelope("completed", { ok: false, error: "  boom  " }))).toEqual({ kind: "failed", text: "boom" });
    expect(await outcomeOf(envelope("completed", { ok: false, error: { message: " nope " } }))).toEqual({ kind: "failed", text: "nope" });
    expect(await outcomeOf(envelope("completed", { ok: false, error: { message: "  " } }))).toEqual({ kind: "failed", text: '{"message":"  "}' });
    expect(await outcomeOf(envelope("completed", { ok: false, error: "" }))).toEqual({ kind: "failed", text: '""' });
    expect(await outcomeOf(envelope("completed", { ok: false }))).toEqual({ kind: "failed", text: "the program failed" });
  });

  it("fails on anything it can't read, quoting at most 200 characters of it", () =>
    fc.assert(
      fc.asyncProperty(fc.oneof(fc.string(), fc.constantFrom("null", '{"value":[1]}', '{"status":"completed"}', `  ${"x".repeat(300)}  `)), async (said) => {
        fc.pre(!/"status"\s*:\s*"(approval|input)-required"/.test(said));
        fc.pre(Option.isNone(readable(said)));
        expect(await outcomeOf(said)).toEqual({ kind: "failed", text: `Executor answered something ky can't read: ${said.trim().slice(0, 200)}` });
      }),
      runs()
    ));
});

const executorParity: Parity<Action> = {
  domain: "executor",
  actions,
  legacy: async () => instanceOf(legacy),
  next: async () => instanceOf(next),
  divergences: [
    {
      name: "a damaged vault row reads as no connection",
      covers: (action) => action.kind === "damage",
      heldBy: "test/invariants/executor.test.ts > reads a damaged vault row as no connection"
    }
  ]
};

describe("executor parity", () => {
  it("answers as B did over generated runs", async () => {
    await assertParity(executorParity);
  }, 600_000);
});
