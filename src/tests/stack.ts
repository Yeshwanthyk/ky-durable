import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type JsonValue,
  type Message,
  type TranscriptContext,
  Type
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Endpoint } from "../models";
import server, { type Boundary, PiAgent as ProductionAgent } from "../server";
import { FakeExecutor } from "./fake-executor";
import { fakeVibeProxy, refusingVibeProxy, VIBEPROXY_KEY } from "./fake-vibeproxy";

export { Vault } from "../vault";

/**
 * ky's real composition with fakes at its outside boundary, for the worker
 * e2e tests and the local stack. Only `boundaryFor` is replaced:
 *
 * - the cloud models are pi-ai's faux provider, "faux" (thinks, reads images)
 *   and "faux-text" (text only);
 * - VibeProxy on the Mac is away (refuses connections) until `mac(true)`,
 *   then fake-vibeproxy.ts answers as Claude;
 * - Executor is FakeExecutor, a real MCP server reached through `fetch`;
 * - Browser Rendering is left out: a launch is refused;
 * - an object named `bare-…` is a deploy with no overlay: no VibeProxy and no
 *   Executor, so Settings shows them as not set up.
 *
 * The faux model answers from the transcript alone, so it gives the same
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
 * - The titles model answers `Title: "Named: <first line>"` and a second line,
 *   so its cleaning is exercised; text containing `no-title` makes it fail.
 */

/** Gate runs up to this one are released. */
const RELEASED_KEY = "test:gate:released";

const GATE_RUNS_KEY = "test:gate:runs";

/** Whether the fake VibeProxy answers (the Mac is online). */
const MAC_UP_KEY = "test:mac-up";

const FAUX = "faux";

/** The token the fake Executor wants. */
const EXECUTOR_TOKEN = "ky-stack-executor";

/** Objects whose name starts with this have no VibeProxy and no Executor, as a deploy without the owner overlay. */
export const BARE = "bare-";

/** The key the faux cloud provider is given, so a test sees which provider's key a request carried. */
const FAUX_KEY = "faux-key";

/** What the faux cloud model was asked, and with which key. */
export type FauxCall = { model: string; reasoning: string | null; apiKey: string | null; system: string };

/** The test boundary, with its fakes in reach. */
export type TestBoundary = Boundary & {
  readonly executorFake: FakeExecutor;
  readonly calls: FauxCall[];
};

function textOf(content: Message["content"] | undefined): string {
  if (content === undefined) return "";

  if (!Array.isArray(content)) return content;

  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

const call = (name: string, args: Record<string, JsonValue>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

function title(context: TranscriptContext): AssistantMessage {
  const text = textOf(context.messages.at(-1)?.content);

  if (text.includes("no-title")) {
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: "The faux titles model is down." });
  }

  return fauxAssistantMessage([fauxText(`Title: "Named: ${text.split("\n")[0]}"\nA second line the cleaning drops.`)]);
}

/** Whether this is the titles model's call: its system prompt asks for a name or a summary. */
function naming(context: TranscriptContext): boolean {
  const [first] = context.messages;
  const system = first?.role === "system" ? textOf(first.content) : "";

  return system.startsWith("You name things") || system.startsWith("You summarize");
}

/**
 * Memory's summary writer, which runs on the main slot: "first to last" of the
 * notes it compresses, or of the two lines it merges, so "memory 0 to memory 7"
 * covers the notes 0 to 7.
 */
function compressing(context: TranscriptContext): AssistantMessage | undefined {
  const [first, asked] = context.messages.filter((message) => message.role !== "assistant");

  if (!textOf(first?.content).startsWith("You write the memory of ky")) return undefined;

  const text = textOf(asked?.content);

  // The step's lines follow its "Compress these" or "Merge these" line.
  const items = text.split(/\n(?:Compress|Merge) these[^\n]*\n/).at(-1)?.split("\n") ?? [];
  const line = `${items[0]?.split(" to ")[0]} to ${items.at(-1)?.split(" to ").at(-1)}`;

  return fauxAssistantMessage([fauxText(line)]);
}

function script(context: TranscriptContext): AssistantMessage {
  if (naming(context)) return title(context);

  const summary = compressing(context);

  if (summary) return summary;

  // pi places system-prompt changes positionally, so a system message can follow the user's input.
  const last = context.messages.filter((message) => message.role !== "system").at(-1);

  if (last?.role === "toolResult") {
    return fauxAssistantMessage([
      fauxText(`${last.isError ? "tool failed" : "tool said"}: ${textOf(last.content)}`)
    ]);
  }

  return answer(last?.role === "user" ? textOf(last.content) : "");
}

/** The prompts that call a tool: each pattern, and the call its match makes. */
const CALLS: Array<[RegExp, (match: RegExpExecArray) => AssistantMessage]> = [
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
function answer(prompt: string): AssistantMessage {
  for (const [pattern, make] of CALLS) {
    const match = pattern.exec(prompt);

    if (match) return make(match);
  }

  return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
}

/** pi-ai's faux provider, given the script again before every call so its queue never runs dry. */
function fauxCloud(calls: FauxCall[]): Endpoint {
  const core = createFauxCore({
    provider: FAUX,
    models: [
      // A 1M window, as the real main models have, so the cap in models.ts shows.
      { id: "faux", name: "Faux", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000 },
      { id: "faux-text", name: "Faux Text", reasoning: false, input: ["text"] }
    ],
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });

  const provider = createProvider({
    id: FAUX,
    // Resolved by name from the registry's env, as OpenCode Go resolves OPENCODE_API_KEY.
    auth: {
      apiKey: {
        name: "Faux key",
        resolve: async ({ ctx }) => {
          const key = await ctx.env("FAUX_KEY");

          return key ? { auth: { apiKey: key }, source: "FAUX_KEY" } : undefined;
        }
      }
    },
    models: core.models,
    api: {
      stream: core.stream,
      streamSimple: (model, context, options) => {
        calls.push({
          model: model.id,
          reasoning: options?.reasoning ?? null,
          apiKey: options?.apiKey ?? null,
          // As sent: pi's system messages, some of which are sections rather than text parts.
          system: JSON.stringify(context.messages.filter((message) => message.role === "system"))
        });
        core.setResponses([script]);

        return core.streamSimple(model, context, options);
      },
      fetchDeferred: core.fetchDeferred,
      cancelDeferred: core.cancelDeferred
    }
  });

  return {
    provider,
    name: "Faux",
    needs: "nothing",
    setUp: true,
    models: provider.getModels(),
    connected: () => true,
    apiKey: { name: "FAUX_KEY", value: FAUX_KEY }
  };
}

const NoParameters = Type.Object({});

/** The real agent with the fakes above, a multiply tool, and gate tools the test opens. */
export class PiAgent extends ProductionAgent {
  declare readonly boundary: TestBoundary;

  override boundaryFor(): TestBoundary {
    // Runs as the first field initializer: only ctx and env are set.
    const storage = this.ctx.storage;
    const executorFake = new FakeExecutor(EXECUTOR_TOKEN);
    const calls: FauxCall[] = [];

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

    return {
      cloud: fauxCloud(calls),
      vibeProxy: bare
        ? undefined
        : {
            binding: {
              fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
                (await storage.get<boolean>(MAC_UP_KEY)) === true
                  ? fakeVibeProxy(new Request(input, init))
                  : refusingVibeProxy()
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

  /** Bring the Mac's VibeProxy up or take it away, probe it as PiAgent does on start, and move the chats to the main slot. */
  async mac(up: boolean): Promise<void> {
    await this.ctx.storage.put(MAC_UP_KEY, up);
    await this.claude?.reachable();
    await this.applyMain();
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
}

/** The PiAgent binding, which the test wrangler config points at this subclass. */
export function agents(env: Env): DurableObjectNamespace<PiAgent> {
  // SAFETY: src/tests/wrangler.jsonc binds PiAgent to this module's subclass.
  return env.PiAgent as DurableObjectNamespace<PiAgent>;
}

type Me = DurableObjectStub<PiAgent>;

/** The test routes: method and path, and what they do to the agent `me`. */
const ROUTES = new Map<string, (me: Me, url: URL) => Promise<Response>>([
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
  ]
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/test/")) return server.fetch(request, env);

    // The CLI harness and Playwright drive the fakes over HTTP, behind the same sign-in as everything else.
    if (request.headers.get("Authorization") !== `Bearer ${env.KY_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const route = ROUTES.get(`${request.method} ${url.pathname}`);

    return route ? route(agents(env).getByName("me"), url) : new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
