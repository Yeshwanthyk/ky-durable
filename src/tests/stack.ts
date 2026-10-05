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
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import server, { type Cloud, PiAgent as ProductionAgent } from "../server";

/**
 * ky's real composition on pi-ai's faux provider, for the worker e2e tests
 * and the local stack. Only the outside boundary is faked: the model. Claude
 * (VibeProxy) and Browser Rendering are absent, as when the Mac is away, so
 * every turn runs on the fallback slot the way production degrades.
 *
 * The faux model answers from the transcript alone, so it gives the same
 * answer after an eviction as before it:
 *
 * - `multiply N` calls `multiply`; `gate` and `gate-unsafe` call the gate
 *   tools, which wait until the test releases them.
 * - `spawn NAME MESSAGE` spawns a subagent; `machine PROMPT` runs a task on
 *   the machine "mac"; `machine@NAME PROMPT` on another machine.
 * - `tool NAME JSON` calls any tool with those arguments.
 * - `fail` answers with a model error.
 * - After a tool result it answers `tool said: <result>`; anything else is
 *   echoed as `echo: <prompt>`.
 * - The titles model answers `Title: "<the text>"` with a second line, so
 *   the cleaning is exercised; text containing `no-title` makes it fail.
 */

/** Gate runs up to this one are released. */
const RELEASED_KEY = "test:gate:released";

const GATE_RUNS_KEY = "test:gate:runs";

const FAUX = "faux";

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

  return fauxAssistantMessage([fauxText(`Title: "${text.split("\n")[0]}"\nA second line the cleaning drops.`)]);
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
  const tool = /^tool (\S+) (\{.*\})$/s.exec(prompt);

  if (tool) {
    // SAFETY: the tests write a JSON object after the tool name; a bad one fails the turn loudly.
    return call(tool[1]!, JSON.parse(tool[2]!) as Record<string, JsonValue>);
  }

  if (prompt === "gate" || prompt === "gate-unsafe") return call(prompt === "gate" ? "gate" : "gate_unsafe", {});

  if (prompt === "fail") {
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: "The faux model failed on purpose." });
  }

  return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
}

/** pi-ai's faux provider, given the script again before every call so its queue never runs dry. */
function fauxCloud(extensions: readonly Extension[]): Cloud {
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
    auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
    models: core.models,
    api: {
      stream: core.stream,
      streamSimple: (model, context, options) => {
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
    apiKey: "faux",
    modelIds: ["faux", "faux-text"],
    extensions
  };
}

const NoParameters = Type.Object({});

/** The real agent, on the faux model, with a multiply tool and gate tools the test opens. */
export class PiAgent extends ProductionAgent {
  override cloudFor(): Cloud {
    const storage = this.ctx.storage;

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

    const tools = defineExtension({
      name: "test-tools",
      tools: [multiply, gate("gate", "safe"), gate("gate_unsafe", "unsafe")]
    });

    return fauxCloud([tools]);
  }

  /** How many times a gate tool has started. */
  async gateRuns(): Promise<number> {
    return (await this.ctx.storage.get<number>(GATE_RUNS_KEY)) ?? 0;
  }

  /** Open every gate started so far; later gates wait for the next release. */
  async release(): Promise<void> {
    await this.ctx.storage.put(RELEASED_KEY, await this.gateRuns());
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

    // The CLI harness and Playwright open gates over HTTP, behind the same sign-in as everything else.
    if (url.pathname === "/test/release" && request.method === "POST") {
      const bearer = request.headers.get("Authorization");

      if (bearer !== `Bearer ${env.KY_TOKEN}`) return new Response("Unauthorized", { status: 401 });
      await agents(env).getByName("me").release();

      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/test/gate-runs" && request.method === "GET") {
      const bearer = request.headers.get("Authorization");

      if (bearer !== `Bearer ${env.KY_TOKEN}`) return new Response("Unauthorized", { status: 401 });

      return Response.json({ runs: await agents(env).getByName("me").gateRuns() });
    }

    return server.fetch(request, env);
  }
} satisfies ExportedHandler<Env>;
