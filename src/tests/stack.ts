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
import { FakeBrowser } from "./fake-browser";
import { FakeExecutor } from "./fake-executor";
import { fakeVibeProxy, refusingVibeProxy } from "./fake-vibeproxy";

/**
 * ky's real composition with fakes at its outside boundary, for the worker
 * e2e tests and the local stack. Only `boundaryFor` is replaced:
 *
 * - the cloud models are pi-ai's faux provider, "faux" (thinks, reads images)
 *   and "faux-text" (text only);
 * - VibeProxy on the Mac is away (refuses connections) until `mac(true)`,
 *   then fake-vibeproxy.ts answers as Claude;
 * - Executor is FakeExecutor, a real MCP server reached through `fetch`;
 * - Browser Rendering is FakeBrowser, a CDP fake.
 *
 * The faux model answers from the transcript alone, so it gives the same
 * answer after an eviction as before it:
 *
 * - `multiply N` calls `multiply`; `gate` and `gate-unsafe` call the gate
 *   tools, which wait until the test releases them.
 * - `spawn NAME MESSAGE` spawns a subagent; `machine PROMPT` runs a task on
 *   the machine "mac"; `machine@NAME PROMPT` on another machine.
 * - `executor CODE` runs CODE on Executor; `browse URL` browses it, and
 *   `browse-wait URL N` browses it with N ten-second waits.
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

/** The key the faux cloud provider is given, so a test sees which provider's key a request carried. */
const FAUX_KEY = "faux-key";

/** What the faux cloud model was asked, and with which key. */
export type FauxCall = { model: string; reasoning: string | null; apiKey: string | null; system: string };

/** The test boundary, with its fakes in reach. */
export type TestBoundary = Boundary & {
  readonly executorFake: FakeExecutor;
  readonly browserFake: FakeBrowser;
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

function script(context: TranscriptContext): AssistantMessage {
  const system = context.messages[0]?.role === "system" ? textOf(context.messages[0].content) : "";

  if (system.startsWith("You name things") || system.startsWith("You summarize")) return title(context);

  // pi places system-prompt changes positionally, so a system message can follow the user's input.
  const last = context.messages.filter((message) => message.role !== "system").at(-1);

  if (last?.role === "toolResult") {
    return fauxAssistantMessage([
      fauxText(`${last.isError ? "tool failed" : "tool said"}: ${textOf(last.content)}`)
    ]);
  }

  const prompt = last?.role === "user" ? textOf(last.content) : "";
  const multiply = /^multiply (\d+)$/.exec(prompt);

  if (multiply) return call("multiply", { value: Number(multiply[1]) });

  const spawn = /^spawn (\S+) (.+)$/s.exec(prompt);

  if (spawn) return call("subagent", { action: "spawn", name: spawn[1]!, message: spawn[2]! });

  const machine = /^machine(?:@(\S+))? (.+)$/s.exec(prompt);

  if (machine) return call("machine", { action: "run", machine: machine[1] ?? "mac", prompt: machine[2]! });

  const executor = /^executor (.+)$/s.exec(prompt);

  if (executor) return call("executor_execute", { code: executor[1]! });

  const browseWait = /^browse-wait (\S+) (\d+)$/.exec(prompt);

  if (browseWait) {
    const steps = Array.from({ length: Number(browseWait[2]) }, () => ({ do: "wait", value: "10000" }));

    return call("browse", { url: browseWait[1]!, steps });
  }

  const browse = /^browse (\S+)$/.exec(prompt);

  if (browse) return call("browse", { url: browse[1]! });

  const tool = /^tool (\S+) (\{.*\})$/s.exec(prompt);

  if (tool) {
    // SAFETY: the tests write a JSON object after the tool name; a bad one fails the turn loudly.
    return call(tool[1]!, JSON.parse(tool[2]!) as Record<string, JsonValue>);
  }

  if (prompt === "gate" || prompt === "gate-unsafe") return call(prompt === "gate" ? "gate" : "gate_unsafe", {});

  return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
}

/** pi-ai's faux provider, given the script again before every call so its queue never runs dry. */
function fauxCloud(calls: FauxCall[]): Endpoint {
  const core = createFauxCore({
    provider: FAUX,
    models: [
      { id: "faux", name: "Faux", reasoning: true, input: ["text", "image"] },
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
    const browserFake = new FakeBrowser();
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

    return {
      cloud: fauxCloud(calls),
      vibeProxy: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
          (await storage.get<boolean>(MAC_UP_KEY)) === true
            ? fakeVibeProxy(new Request(input, init))
            : refusingVibeProxy()
      },
      // Test-only: every turn asks VibeProxy afresh, so a test sees the Mac leave at once. Production reuses an answer for 30s.
      probeTtlMs: 0,
      browser: browserFake.binding,
      executor: { url: "https://executor.test/mcp", token: EXECUTOR_TOKEN, fetch: executorFake.fetch },
      extensions: [defineExtension({ name: "test-tools", tools: [multiply, gate("gate", "safe"), gate("gate_unsafe", "unsafe")] })],
      executorFake,
      browserFake,
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
    await this.claude.reachable();
    await this.applyMain();
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The CLI harness and Playwright drive the fakes over HTTP, behind the same sign-in as everything else.
    if (url.pathname.startsWith("/test/")) {
      if (request.headers.get("Authorization") !== `Bearer ${env.KY_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const me = agents(env).getByName("me");

      if (url.pathname === "/test/release" && request.method === "POST") {
        await me.release();

        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/test/gate-runs" && request.method === "GET") {
        return Response.json({ runs: await me.gateRuns() });
      }

      // POST /test/mac?up=1 brings the Mac online; up=0 takes it away.
      if (url.pathname === "/test/mac" && request.method === "POST") {
        await me.mac(url.searchParams.get("up") === "1");

        return new Response(null, { status: 204 });
      }

      return new Response("Not found", { status: 404 });
    }

    return server.fetch(request, env);
  }
} satisfies ExportedHandler<Env>;
