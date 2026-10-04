import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension
} from "@earendil-works/pi-durable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Executor (v2.executor.sh) over MCP. Executor holds the accounts and turns
 * apps into tools behind three MCP tools: `skills` reads what an app ships,
 * `execute` runs a JavaScript program over the apps (`tools.<app>.<tool>()`),
 * and `resume` continues a program that paused for an approval.
 *
 * The connection uses a personal access token on the organization's URL in
 * browser elicitation mode, so an approval arrives as a link the user opens,
 * and the agent calls `resume` after.
 */

export type ExecutorConfig = {
  readonly url: string | undefined;
  readonly token: string | undefined;
};

type CallResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const REQUEST_TIMEOUT_MS = 6 * 60_000;

class ExecutorClient {
  readonly #config: ExecutorConfig;
  #client: Promise<Client> | undefined;

  constructor(config: ExecutorConfig) {
    this.#config = config;
  }

  get configured(): boolean {
    return Boolean(this.#config.url && this.#config.token);
  }

  #connect(): Promise<Client> {
    this.#client ??= (async () => {
      const client = new Client({ name: "ky", version: "0.1.0" });

      const transport = new StreamableHTTPClientTransport(new URL(this.#config.url!), {
        requestInit: { headers: { Authorization: `Bearer ${this.#config.token}` } }
      });

      await client.connect(transport);

      return client;
    })().catch((error: unknown) => {
      this.#client = undefined;
      throw error;
    });

    return this.#client;
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    if (!this.configured) {
      return {
        content: [{ type: "text", text: "Executor is not configured: EXECUTOR_URL and EXECUTOR_TOKEN are unset." }],
        isError: true
      };
    }

    let lastError: unknown;

    // One retry on a fresh connection: the MCP session may have expired.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = await this.#connect();

        const result = await client.callTool({ name, arguments: args }, undefined, {
          timeout: REQUEST_TIMEOUT_MS
        });

        const content = (Array.isArray(result.content) ? result.content : []).map((part) =>
          part.type === "text"
            ? { type: "text" as const, text: part.text }
            : { type: "text" as const, text: JSON.stringify(part) }
        );

        if (result.structuredContent !== undefined && content.length === 0) {
          content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
        }

        return { content, isError: result.isError === true };
      } catch (error) {
        lastError = error;
        this.#client = undefined;
      }
    }

    return {
      content: [{ type: "text", text: `Executor call failed: ${lastError instanceof Error ? lastError.message : String(lastError)}` }],
      isError: true
    };
  }
}

const GUIDE = `Executor connects the user's accounts and apps (calendar, email, GitHub, Vercel and whatever else they added). Use it for anything that touches their services.

- executor_skills: read what apps are available and the instructions they ship. Start here when you do not know what is connected.
- executor_execute: run a short JavaScript program. Inside it, \`await tools.search({ query: "..." })\` returns callable paths and TypeScript signatures, and app tools are async functions like \`await tools.vercel.listProjects({})\`. Join and filter results in the program and return only what you need. There is no fetch, no filesystem and no imports. Limits: 100 tool calls, 5 minutes, 64 KB of output.
- If a result carries an approvalUrl, give the user that link, wait for them to say they decided, then call executor_resume with the requestId. Never re-run a program to get past a refusal: earlier calls may already have taken effect.`;

export function executorExtension(config: ExecutorConfig): Extension {
  const executor = new ExecutorClient(config);

  return defineExtension({
    name: "executor",
    sections: [{ key: "executor", render: () => GUIDE }],
    tools: [
      defineTool({
        name: "executor_skills",
        description:
          "List the user's Executor apps and their skills, or read one. No app: everything visible. app: one app's skills. app and name: one skill.",
        parameters: Type.Object({
          app: Type.Optional(Type.String()),
          name: Type.Optional(Type.String())
        }),
        replay: "safe",
        execute: async (args) => executor.call("skills", args)
      }),
      defineTool({
        name: "executor_execute",
        description:
          "Run a JavaScript program over the user's Executor apps. `tools.search({ query })` finds tools; app tools are `await tools.<app>.<tool>(input)`. Return the result.",
        parameters: Type.Object({
          code: Type.String({ description: "The program body. It may use await and must return its result." })
        }),
        // A program can have side effects in the user's accounts.
        replay: "unsafe",
        execute: async (args) => executor.call("execute", args)
      }),
      defineTool({
        name: "executor_resume",
        description:
          "Continue an Executor program that paused for an approval or for input, after the user decided.",
        parameters: Type.Object(
          { requestId: Type.String() },
          { additionalProperties: true }
        ),
        replay: "unsafe",
        execute: async (args) => executor.call("resume", args)
      })
    ]
  });
}
