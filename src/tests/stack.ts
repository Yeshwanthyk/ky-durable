import { type JsonValue, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { TaskTokens } from "../machines";
import { Access } from "../access";
import { type Boundary, PiAgent as ProductionAgent, worker } from "../server";
import { type AiCall, chatCompletions, fakeAI, type Reply, type WireMessage, wireText } from "../../test/fakes/ai";
import { edge, FakeAccess } from "./fake-access";
import { vendors } from "../../test/fakes/vendors";
import { fakeOpenAi } from "../../test/fakes/openai";
import { FakeExecutor } from "./fake-executor";
import { fakeVibeProxy, refusingVibeProxy, VIBEPROXY_KEY, VIBEPROXY_TEST_PORT } from "../../test/fakes/vibeproxy";
import { Vault as ProductionVault, type TokenKind } from "../vault";
import { type CloudBox, CloudMachine as ProductionCloudMachine, SAVE_KEY } from "../cloud";
import { CLOUD } from "../cloud-facts";
import { proxyGit } from "../github";
import { fakeGithubApi } from "../../test/fakes/github";

export { GithubProxy } from "../github";

/** The cloud machine's settings in the stack: its fake container host, the fake GitHub, and how soon it sleeps. */
const HOST_KEY = "test:host";

const UPSTREAM_KEY = "test:github";

const IDLE_KEY = "test:idle-ms";

/** The test alarm's tick: a start that failed is tried again soon. */
const TEST_TICK_MS = 2_000;

/**
 * A container on the fake host (test/fakes/container.ts) at `host`, which the harness starts; with no
 * host set, none runs and a start fails, as a container that never comes up.
 */
function hostBox(host: () => Promise<string | undefined>): CloudBox {
  const at = async (path: string) => {
    const url = await host();

    if (!url) throw new Error("No fake container host: POST /test/cloud-host first.");

    return `${url}${path}`;
  };

  return {
    running: async () => ((await host()) ? (await (await fetch(await at("/running"))).text()) === "true" : false),
    start: async (env) => {
      const started = await fetch(await at("/start"), { method: "POST", body: JSON.stringify(env) });

      if (started.status !== 204) throw new Error(`The fake container didn't start: ${started.status}`);
    },
    fetch: async (path, init) => fetch(await at(`/port${path}`), init),
    destroy: async () => {
      await (await fetch(await at("/destroy"), { method: "POST" })).body?.cancel();
    }
  };
}

/**
 * The CloudMachine, with its container on the harness's fake host (`POST /test/cloud-host`), a tick
 * of TEST_TICK_MS, and an idle time the harness may shorten.
 */
export class CloudMachine extends ProductionCloudMachine {
  override box(): CloudBox {
    return hostBox(() => this.ctx.storage.get<string>(HOST_KEY));
  }

  override async timing(): Promise<{ tickMs: number; idleMs: number }> {
    return { tickMs: TEST_TICK_MS, idleMs: (await this.ctx.storage.get<number>(IDLE_KEY)) ?? (await super.timing()).idleMs };
  }

  /** Use the fake container host at `host`, the fake github.com at `github`, and sleep after `idleMs` idle. */
  async configure(host: string, github: string | null, idleMs: number | null): Promise<void> {
    await this.ctx.storage.put(HOST_KEY, host);

    if (github) await this.ctx.storage.put(UPSTREAM_KEY, github);

    if (idleMs === null) await this.ctx.storage.delete(IDLE_KEY);
    else await this.ctx.storage.put(IDLE_KEY, idleMs);
  }

  /** Where the stack's github.internal route sends git: the fake github.com. */
  async upstream(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(UPSTREAM_KEY);
  }

  /** Stop the container, forget its save, its alarm and its host, for the next scenario. */
  async reset(): Promise<void> {
    if (await this.box().running()) await this.box().destroy();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.env.FILES.delete(SAVE_KEY);
  }
}

/** The CloudMachine binding, which the test wrangler config points at this subclass. */
function cloud(env: Env): DurableObjectStub<CloudMachine> {
  // SAFETY: src/tests/wrangler.jsonc binds CloudMachine to this module's subclass.
  return (env.CloudMachine as DurableObjectNamespace<CloudMachine>).getByName(CLOUD);
}

/**
 * The Vault, with a clock the harness can move ahead (`POST /test/vault-clock?ahead=<ms>`), to expire codes
 * and tokens, machine mints it can slow (`slowMachineMints`), to make two pairings race, and the fake OpenAI
 * for ChatGPT's sign-in.
 */
export class Vault extends ProductionVault {
  #slow = { count: 0, ms: 0 };

  override openai = fakeOpenAi(() => this.now()).fetch;

  override github = fakeGithubApi();

  ahead(ms: number): void {
    this.now = () => Date.now() + ms;
  }

  /** Make each of the next `count` machine mints wait `ms` first. */
  slowMachineMints(count: number, ms: number): void {
    this.#slow = { count, ms };
  }

  override async mint(kind: TokenKind, subject: string, ttlMs?: number): Promise<string> {
    if (kind === "machine" && this.#slow.count > 0) {
      this.#slow.count -= 1;
      await scheduler.wait(this.#slow.ms);
    }

    return super.mint(kind, subject, ttlMs);
  }

}

/**
 * ky's real composition with fakes at its outside boundary, for the worker
 * e2e tests and the local stack. Only `boundaryFor` is replaced:
 *
 * - Workers AI is test/fakes/ai.ts behind a fake AI binding, so every object chats
 *   with no secrets, as a fresh deploy does;
 * - the api-key vendors are behind `fetch`: OpenCode Go is the same fake,
 *   and Anthropic and OpenAI are test/fakes/vendors.ts, answering from the
 *   same script, each taking only its own key; a key is added through
 *   Settings as the user adds one, and kept in the real Vault;
 * - each refuses every request while `provider(id, false)` holds: Workers AI
 *   with 429, as out of its free allocation, and OpenCode Go with 402, as
 *   out of credit;
 * - VibeProxy on the Mac, through the overlay's tunnel, is away (refuses
 *   connections) until `mac(true)`, then test/fakes/vibeproxy.ts answers as
 *   Claude; after `tunnelDrops()` the tunnel refuses each message while the
 *   probe still answers;
 * - a machine whose runner shares VIBEPROXY_TEST_PORT has VibeProxy over the
 *   pipe instead, the test's own fake behind it; `pipe()` sends a request
 *   over it as a provider's would (`overPipe()`);
 * - Executor is FakeExecutor, a real MCP server reached through `fetch`;
 * - Browser Rendering is left out: a launch is refused;
 * - an object named `bare-…` is a deploy with no overlay: no VibeProxy and no
 *   Executor, so Settings shows them as not set up.
 *
 * The fake models answer from the transcript alone, so they give the same
 * answer after an eviction as before it:
 *
 * - `multiply N` calls `multiply`; `gate` and `gate-unsafe` call the gate
 *   tools, which wait until the test releases them.
 * - `spawn NAME MESSAGE` spawns a subagent; `machine PROMPT` runs a task on
 *   the machine "mac"; `machine@NAME PROMPT` on another machine.
 * - `executor CODE` runs CODE on Executor.
 * - `tool NAME JSON` calls any tool with those arguments.
 * - After a tool result it answers `tool said: <result>`; anything else is
 *   echoed as `echo: <prompt>`.
 * - Titles are answered `Title: "Named: <first line>"` and a second line,
 *   so their cleaning is exercised; text containing `no-title` gets a 400.
 */

/** Gate runs up to this one are released. */
const RELEASED_KEY = "test:gate:released";

const GATE_RUNS_KEY = "test:gate:runs";

/** Whether the fake VibeProxy answers (the Mac is online). */
const MAC_UP_KEY = "test:mac-up";

/** Whether the tunnel drops each message while VibeProxy's probe still answers. */
const TUNNEL_DROPS_KEY = "test:tunnel-drops";

/** The status each fake provider refuses every request with while it is down. */
const REFUSALS = { "workers-ai": 429, "opencode-go": 402 } as const;

type FakeProvider = keyof typeof REFUSALS;

const downKey = (provider: FakeProvider) => `test:down:${provider}`;

/** The token the fake Executor wants. */
export const EXECUTOR_TOKEN = "ky-stack-executor";

export const EXECUTOR_URL = "https://executor.test/mcp";

/** Objects whose name starts with this have no VibeProxy and no Executor, as a deploy without the owner overlay. */
export const BARE = "bare-";

/** Objects whose name starts with this are seeded on first start, as a new deploy is; the rest start empty. */
export const FRESH = "fresh-";

/** A key OpenCode Go's fake takes; it takes any. */
export const OPENCODE_KEY = "opencode-test-key";

/** Workers AI's models: the default, which reads images, the next, and the text-only one. */
export const GLM = "workers-ai/@cf/zai-org/glm-5.3-flash";

export const KIMI = "workers-ai/@cf/moonshotai/kimi-k2.6";

export const GPT_OSS = "workers-ai/@cf/openai/gpt-oss-120b";

/** The test boundary, with its fakes in reach. */
export type TestBoundary = Boundary & {
  readonly executorFake: FakeExecutor;
  /** Every request to Workers AI and the api-key vendors, as the wire carried it. */
  readonly calls: AiCall[];
};

const call = (tool: string, args: Record<string, JsonValue>): Reply => ({ tool, args });

/** What the background model is asked: a name, or a summary of notes or of a task. */
function title(text: string): Reply {
  if (text.includes("no-title")) return { status: 400, error: "The fake titles model refuses this text." };

  return { text: `Title: "Named: ${text.split("\n")[0]}"\nA second line the cleaning drops.` };
}

/**
 * Memory's summary writer: "first to last" of the notes it compresses, or of
 * the two lines it merges, so "memory 0 to memory 7" covers the notes 0 to 7.
 */
function compress(text: string): Reply {
  // The step's lines follow its "Compress these" or "Merge these" line.
  const items = text.split(/\n(?:Compress|Merge) these[^\n]*\n/).at(-1)?.split("\n") ?? [];

  return { text: `${items[0]?.split(" to ")[0]} to ${items.at(-1)?.split(" to ").at(-1)}` };
}

/** The background's requests, by how their system prompt starts, and how each is answered from its user text. */
const BACKGROUND: Array<[string, (asked: string) => Reply]> = [
  ["You name things", title],
  ["You summarize", title],
  ["You write the memory of ky", compress]
];

function script(messages: readonly WireMessage[]): Reply {
  const system = wireText(messages.find((message) => message.role === "system")?.content);
  const background = BACKGROUND.find(([start]) => system.startsWith(start));

  if (background) return background[1](wireText(messages.find((message) => message.role === "user")?.content));

  // pi places system-prompt changes positionally, so a system message can follow the user's input.
  return reply(messages.filter((message) => message.role !== "system").at(-1));
}

/** The answer to a turn's last message: the user's input, or a tool's result. */
function reply(last: WireMessage | undefined): Reply {
  // The wire does not say whether a tool failed; its result is its text either way.
  if (last?.role === "tool") return { text: `tool said: ${wireText(last.content)}` };

  return answer(last?.role === "user" ? wireText(last.content) : "");
}

/** The prompts that call a tool: each pattern, and the call its match makes. */
const CALLS: Array<[RegExp, (match: RegExpExecArray) => Reply]> = [
  [/^multiply (\d+)$/, (match) => call("multiply", { value: Number(match[1]) })],
  [/^spawn (\S+) (.+)$/s, (match) => call("subagent", { action: "spawn", name: match[1]!, message: match[2]! })],
  [/^machine(?:@(\S+))? (.+)$/s, (match) => call("machine", { action: "run", machine: match[1] ?? "mac", prompt: match[2]! })],
  [/^executor (.+)$/s, (match) => call("executor_execute", { code: match[1]! })],
  // SAFETY: the tests write a JSON object after the tool name; a bad one fails the turn loudly.
  [/^tool (\S+) (\{.*\})$/s, (match) => call(match[1]!, JSON.parse(match[2]!) as Record<string, JsonValue>)],
  [/^gate$/, () => call("gate", {})],
  [/^gate-unsafe$/, () => call("gate_unsafe", {})]
];

/** The answer to a user's prompt: the tool call it asks for, or an echo. */
function answer(prompt: string): Reply {
  for (const [pattern, make] of CALLS) {
    const match = pattern.exec(prompt);

    if (match) return make(match);
  }

  return { text: `echo: ${prompt}` };
}

const NoParameters = Type.Object({});

/** The real agent with the fakes above, a multiply tool, and gate tools the test opens. */
export class PiAgent extends ProductionAgent {
  declare readonly boundary: TestBoundary;
  /** Task token issues still to fail; read only once the hub calls, after this field is set. */
  #failingIssues = 0;

  /** Fail the next `count` task token issues, as a Vault call that failed: the agent's own catch sees the error. */
  failIssues(count: number): void {
    this.#failingIssues = count;
  }

  /** The task token issues still to fail. */
  failingIssues(): number {
    return this.#failingIssues;
  }

  override taskTokens(): TaskTokens {
    const tokens = super.taskTokens();

    return {
      ...tokens,
      issue: async (task) => {
        if (this.#failingIssues === 0) return tokens.issue(task);
        this.#failingIssues -= 1;

        throw new Error("The test agent failed this issue.");
      }
    };
  }

  override boundaryFor(): TestBoundary {
    // Runs as the first field initializer: only ctx and env are set.
    const storage = this.ctx.storage;
    const executorFake = new FakeExecutor(EXECUTOR_TOKEN);
    const calls: AiCall[] = [];

    const gate = (name: string, replay: "safe" | "unsafe") =>
      defineTool({
        name,
        description: "Wait until the test releases it.",
        parameters: NoParameters,
        replay,
        async execute(_args, api, context) {
          const runs = ((await storage.get<number>(GATE_RUNS_KEY)) ?? 0) + 1;
          await storage.put(GATE_RUNS_KEY, runs);
          api.output(`run ${runs}\n`);

          while (((await storage.get<number>(RELEASED_KEY)) ?? 0) < runs) {
            context.abortSignal?.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }

          return { content: [{ type: "text", text: `released after ${runs} runs` }] };
        }
      });

    const multiply = defineTool({
      name: "multiply",
      description: "Multiply by three.",
      parameters: Type.Object({ value: Type.Number() }),
      replay: "safe",
      execute: async ({ value }) => ({
        content: [{ type: "text", text: String(value * 3) }],
        details: { result: value * 3 }
      })
    });

    const bare = this.ctx.id.name?.startsWith(BARE) === true;

    const refusing = (provider: FakeProvider) => async () =>
      (await storage.get<boolean>(downKey(provider))) === true ? REFUSALS[provider] : undefined;

    return {
      ai: fakeAI(chatCompletions(script, calls, refusing("workers-ai"))),
      fetch: vendors(script, calls, chatCompletions(script, calls, refusing("opencode-go"))),
      vibeProxy: {
        port: VIBEPROXY_TEST_PORT,
        key: VIBEPROXY_KEY,
        tunnel: bare
          ? undefined
          : {
              binding: {
                fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                  const request = new Request(input, init);
                  const drops = (await storage.get<boolean>(TUNNEL_DROPS_KEY)) === true && new URL(request.url).pathname === "/v1/messages";

                  return (await storage.get<boolean>(MAC_UP_KEY)) === true && !drops ? fakeVibeProxy(request) : refusingVibeProxy();
                }
              },
              origin: "http://127.0.0.1:8317"
            }
      },
      // Test-only: every turn asks VibeProxy afresh, so a test sees the Mac leave at once. Production reuses an answer for 30s.
      probeTtlMs: 0,
      browser: { fetch: async () => new Response("no Browser Rendering in the local stack", { status: 503 }) },
      executorFetch: executorFake.fetch,
      seeds: this.ctx.id.name?.startsWith(FRESH) === true,
      extensions: [defineExtension({ name: "test-tools", tools: [multiply, gate("gate", "safe"), gate("gate_unsafe", "unsafe")] })],
      executorFake,
      calls
    };
  }

  /** How many times a gate tool has started. */
  async gateRuns(): Promise<number> {
    return (await this.ctx.storage.get<number>(GATE_RUNS_KEY)) ?? 0;
  }

  /** Open every gate started so far; later gates wait for the next release. */
  async release(): Promise<void> {
    await this.ctx.storage.put(RELEASED_KEY, await this.gateRuns());
  }

  /** Bring the Mac's VibeProxy up or take it away, probe it as PiAgent does on start, and move the chats to the main purpose. */
  async mac(up: boolean): Promise<void> {
    await this.ctx.storage.put(MAC_UP_KEY, up);
    await this.models.probe();
    await this.applyMain();
  }

  /** Let a fake provider answer, or refuse every request from now on. */
  async provider(id: FakeProvider, up: boolean): Promise<void> {
    await this.ctx.storage.put(downKey(id), !up);
  }

  /** Dream now, as the nightly fire does, and wait for it to finish. */
  async dream(): Promise<void> {
    await this.dreaming.run();
  }

  /** Review turns with at least this many tool calls; in memory, so a restart puts back the default. */
  reviewAfterTools(count: number): void {
    this.skills.reviewAfter = count;
  }

  /** The Mac goes away and nothing has asked it since: the catalog still shows Claude connected. */
  async macLeaves(): Promise<void> {
    await this.ctx.storage.put(MAC_UP_KEY, false);
  }

  /**
   * Send `path` to `port` on `machine` over the pipe, as a provider does, and say how it went: its status and
   * body, or why it failed. `abortAfterMs` aborts it that long after its head; `timeoutMs` shortens the pipe's wait.
   */
  async overPipe(machine: string, port: number, path: string, { abortAfterMs, timeoutMs }: { abortAfterMs?: number; timeoutMs?: number } = {}): Promise<{ status?: number; body?: string; failed?: string }> {
    const before = this.pipe.timeoutMs;
    const abort = new AbortController();

    if (timeoutMs !== undefined) this.pipe.timeoutMs = timeoutMs;

    try {
      const response = await this.pipe.fetcher(machine, port)(`http://127.0.0.1:${port}${path}`, { signal: abort.signal });

      if (abortAfterMs !== undefined) setTimeout(() => abort.abort(), abortAfterMs);

      return { status: response.status, body: await response.text() };
    } catch (error) {
      return { failed: error instanceof Error ? error.message : String(error) };
    } finally {
      this.pipe.timeoutMs = before;
    }
  }

  /** Drop every message on the tunnel while VibeProxy's probe still answers, as a tunnel that fails mid-call does. */
  async tunnelDrops(): Promise<void> {
    await this.ctx.storage.put(TUNNEL_DROPS_KEY, true);
  }
}

/** The PiAgent binding, which the test wrangler config points at this subclass. */
export function agents(env: Env): DurableObjectNamespace<PiAgent> {
  // SAFETY: src/tests/wrangler.jsonc binds PiAgent to this module's subclass.
  return env.PiAgent as DurableObjectNamespace<PiAgent>;
}

type Me = DurableObjectStub<PiAgent>;

/** The test routes: method and path, and what they do to the agent `me` or the Vault. */
const ROUTES = new Map<string, (me: Me, url: URL, env: Env) => Promise<Response>>([
  [
    "POST /test/release",
    async (me) => {
      await me.release();

      return new Response(null, { status: 204 });
    }
  ],
  ["GET /test/gate-runs", async (me) => Response.json({ runs: await me.gateRuns() })],
  [
    "POST /test/dream",
    async (me) => {
      await me.dream();

      return new Response(null, { status: 204 });
    }
  ],
  // n is the tool calls a turn needs to be reviewed for skills; 5 is ky's default.
  [
    "POST /test/review-after",
    async (me, url) => {
      await me.reviewAfterTools(Number(url.searchParams.get("n") ?? "5"));

      return new Response(null, { status: 204 });
    }
  ],
  // up=1 brings the Mac online; up=0 takes it away; up=leaves takes it away unnoticed until ky next asks.
  [
    "POST /test/mac",
    async (me, url) => {
      const up = url.searchParams.get("up");
      await (up === "leaves" ? me.macLeaves() : me.mac(up === "1"));

      return new Response(null, { status: 204 });
    }
  ],
  // A request over the pipe: machine, port and path; abort-after (ms after its head) and timeout (ms) are optional.
  [
    "POST /test/pipe",
    async (me, url) => {
      const number = (name: string) => (url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined);
      const { searchParams } = url;

      return Response.json(
        await me.overPipe(searchParams.get("machine") ?? "", number("port") ?? 0, searchParams.get("path") ?? "/", {
          abortAfterMs: number("abort-after"),
          timeoutMs: number("timeout")
        })
      );
    }
  ],
  [
    "POST /test/vault-clock",
    async (_me, url, env) => {
      // SAFETY: src/tests/wrangler.jsonc binds Vault to this module's subclass.
      await (env.Vault as DurableObjectNamespace<Vault>).getByName("owner").ahead(Number(url.searchParams.get("ahead") ?? "0"));

      return new Response(null, { status: 204 });
    }
  ],
  // The cloud machine's fake container host (url), fake github.com (github) and idle time in ms (idle).
  [
    "POST /test/cloud-host",
    async (_me, url, env) => {
      const { searchParams } = url;

      await cloud(env).configure(searchParams.get("url") ?? "", searchParams.get("github"), searchParams.has("idle") ? Number(searchParams.get("idle")) : null);

      return new Response(null, { status: 204 });
    }
  ],
  // Put the cloud machine to sleep now, as its idle time running out does: 409 while it has work, or nothing runs.
  ["POST /test/cloud-sleep", async (_me, _url, env) => new Response(null, { status: (await cloud(env).sleep()) ? 204 : 409 })],
  [
    "POST /test/cloud-reset",
    async (_me, _url, env) => {
      await cloud(env).reset();

      return new Response(null, { status: 204 });
    }
  ],
]);

/** Access with the team's keys from the fake: every FakeAccess signs with them. */
const access = new Access(new FakeAccess().certs);

const ky = worker(access);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const signed = edge(request);
    const url = new URL(signed.url);

    // The container's github.internal, which production intercepts in the container's network: the
    // fake container host's git reaches it here, with no sign-in, as git in the container has none.
    if (url.pathname.startsWith("/github.internal/")) {
      const upstream = await cloud(env).upstream();
      const vault = env.Vault.getByName("owner");
      url.pathname = url.pathname.slice("/github.internal".length);

      return proxyGit(new Request(url, request), await vault.githubToken(), upstream);
    }

    if (!url.pathname.startsWith("/test/")) return ky.fetch(signed, env);

    // The CLI harness and Playwright drive the fakes over HTTP, behind the same Access as everything else.
    const refused = await access.refuse(signed, env);

    if (refused) return refused;

    const route = ROUTES.get(`${signed.method} ${url.pathname}`);

    return route ? route(agents(env).getByName("me"), url, env) : new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
