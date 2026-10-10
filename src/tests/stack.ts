import { type JsonValue, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { TaskTokens } from "../machines";
import { Access } from "../access";
import { type Boundary, PiAgent as ProductionAgent, worker } from "../server";
import { type AiCall, chatCompletions, fakeAI, type Reply, type WireMessage, wireText } from "../../test/fakes/ai";
import { edge, FakeAccess } from "./fake-access";
import { vendors } from "../../test/fakes/vendors";
import { FakeExecutor } from "./fake-executor";
import { fakeVibeProxy, refusingVibeProxy, VIBEPROXY_KEY } from "./fake-vibeproxy";
import { Vault as ProductionVault, type TokenKind } from "../vault";

/**
 * The Vault, with a clock the harness can move ahead (`POST /test/vault-clock?ahead=<ms>`), to expire codes,
 * and machine mints it can slow (`slowMachineMints`), to make two pairings race.
 */
export class Vault extends ProductionVault {
  #slow = { count: 0, ms: 0 };

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
 * - VibeProxy on the Mac is away (refuses connections) until `mac(true)`,
 *   then fake-vibeproxy.ts answers as Claude; after `tunnelDrops()` the
 *   tunnel refuses each message while the probe still answers;
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
const EXECUTOR_TOKEN = "ky-stack-executor";

/** Objects whose name starts with this have no VibeProxy and no Executor, as a deploy without the owner overlay. */
export const BARE = "bare-";

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
      vibeProxy: bare
        ? undefined
        : {
            binding: {
              fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                const request = new Request(input, init);
                const drops = (await storage.get<boolean>(TUNNEL_DROPS_KEY)) === true && new URL(request.url).pathname === "/v1/messages";

                return (await storage.get<boolean>(MAC_UP_KEY)) === true && !drops ? fakeVibeProxy(request) : refusingVibeProxy();
              }
            },
            origin: "http://127.0.0.1:8317",
            key: VIBEPROXY_KEY
          },
      // Test-only: every turn asks VibeProxy afresh, so a test sees the Mac leave at once. Production reuses an answer for 30s.
      probeTtlMs: 0,
      browser: { fetch: async () => new Response("no Browser Rendering in the local stack", { status: 503 }) },
      executor: bare ? undefined : { url: "https://executor.test/mcp", token: EXECUTOR_TOKEN, fetch: executorFake.fetch },
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
  [
    "POST /test/vault-clock",
    async (_me, url, env) => {
      // SAFETY: src/tests/wrangler.jsonc binds Vault to this module's subclass.
      await (env.Vault as DurableObjectNamespace<Vault>).getByName("owner").ahead(Number(url.searchParams.get("ahead") ?? "0"));

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

    if (!url.pathname.startsWith("/test/")) return ky.fetch(signed, env);

    // The CLI harness and Playwright drive the fakes over HTTP, behind the same Access as everything else.
    const refused = await access.refuse(signed, env);

    if (refused) return refused;

    const route = ROUTES.get(`${signed.method} ${url.pathname}`);

    return route ? route(agents(env).getByName("me"), url, env) : new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
