import { type JsonValue, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import { type Edge, makeEdge } from "../core/edge";
import { isRefusal } from "../core/refusal";
import { toolReply } from "../core/reply";
import type { ExecutorView } from "../protocol";
import {
  type Attempt,
  type ExecutorCall,
  type ExecutorConfig,
  type ExecutorGate,
  type ExecutorRetarget,
  type ExecutorVault,
  resultText
} from "./contract";
import { connect, ExecutorClient, Link, retarget } from "./executor";

export async function callOnce(config: ExecutorConfig, name: string, args: Record<string, JsonValue | undefined>, signal?: AbortSignal): Promise<Attempt> {
  const executor = new ExecutorClient(config);

  try {
    return await executor.attempt(name, args, signal);
  } finally {
    executor.close();
  }
}

export async function executeOnce(config: ExecutorConfig, code: string, signal: AbortSignal): Promise<{ text: string; error: boolean }> {
  const { result } = await callOnce(config, "execute", { code }, signal);

  return { text: resultText(result), error: result.isError === true };
}

const GUIDE = `Executor connects the user's accounts and apps (calendar, email, GitHub, Vercel and whatever else they added). Use it for anything that touches their services.

- executor_skills: read what apps are available and the instructions they ship. Start here when you do not know what is connected.
- executor_execute: run a short JavaScript program. Inside it, \`await tools.search({ query: "..." })\` returns callable paths and TypeScript signatures, and app tools are async functions like \`await tools.vercel.listProjects({})\`. Join and filter results in the program and return only what you need. There is no fetch, no filesystem and no imports. Limits: 100 tool calls, 5 minutes, 64 KB of output.

Approvals are the user's, and you can't give one. A tool that needs approval pauses the program, and the result has \`status: "approval-required"\`, a requestId, and what the tool is about to do. ky shows the user a card for it, and only their tap on the card approves it; ky then resumes the program and tells you here what came of it.
1. Tell the user in plain words what will happen: what is sent, changed or deleted, where, and to whom. Decode what they can't read. For a Gmail send, decode the base64url \`raw\` and show the recipient, the subject and the body. Don't show the encoded text.
2. Stop. Don't ask them to say yes in the chat: a yes in words approves nothing. Point them to the card.
3. If they say no or want to stop, call executor_resume with \`action: "decline"\` or \`action: "cancel"\`.

A result with \`status: "input-required"\` asks for information: ask the user, then call executor_resume with \`{ requestId, response: { action: "answer", content: { ...their answers } } }\`.

- Never claim you approved anything, and never ask anyone but the user to approve.
- Never re-run a program after a refusal, after a decline, or after an approval that got lost. Earlier calls in it may already have taken effect.
- A request from before ky's approval cards has no card and can't be approved or cancelled any more: Executor lets it lapse. Do as for a request that is gone.
- If a resume answers not-found or expired, the request is gone. First check with a read-only program whether the action happened, for example by looking in Sent. Then tell the user, and ask again before you try anything new.
- executor_connection: show or change the URL ky reaches Executor at, keeping the token.`;

export function executorExtension(config: ExecutorConfig, gate: ExecutorGate, retargeted?: ExecutorRetarget): Extension {
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
        execute: async (args, _api, context) => executor.call("skills", args, context.abortSignal)
      }),
      defineTool({
        name: "executor_execute",
        description:
          "Run a JavaScript program over the user's Executor apps. `tools.search({ query })` finds tools; app tools are `await tools.<app>.<tool>(input)`. Return the result.",
        parameters: Type.Object({
          code: Type.String({ description: "The program body. It may use await and must return its result." })
        }),
        replay: "unsafe",
        execute: async (args, api, context) => {
          const call: ExecutorCall = (name, more) => executor.call(name, more, context.abortSignal);

          return gate.replied(await call("execute", args), String(api.conversationId), call);
        }
      }),
      defineTool({
        name: "executor_resume",
        description:
          "Answer an Executor program that paused for input, or decline or cancel one that paused for approval, on the user's word. You can't approve: only the user's tap on ky's card does.",
        parameters: Type.Object({
          requestId: Type.String(),
          response: Type.Object({
            action: Type.Union([Type.Literal("answer"), Type.Literal("decline"), Type.Literal("cancel")], {
              description: "answer a request for input with the user's answers, decline on their no, cancel to stop altogether."
            }),
            content: Type.Optional(
              Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())]), {
                description: "The user's answers, when Executor asked for input."
              })
            )
          })
        }),
        replay: "unsafe",
        execute: async ({ requestId, response }, api, context) => {
          const conversation = String(api.conversationId);
          const refused = gate.beforeResume(requestId, response.action, conversation);

          if (refused) return toolReply(`Not sent: ${refused}`, true);
          const call: ExecutorCall = (name, more) => executor.call(name, more, context.abortSignal);
          const action = response.action === "answer" ? "accept" : response.action;
          const result = await call("resume", { requestId, response: response.content ? { action, content: response.content } : { action } });

          gate.resumed(requestId);

          return gate.replied(result, conversation, call);
        }
      }),
      ...(retargeted ? [connectionTool(config.url, retargeted)] : [])
    ]
  });
}

function connectionTool(current: string, retargeted: ExecutorRetarget) {
  return defineTool({
    name: "executor_connection",
    description: `Show or change the URL ky reaches Executor at (now ${current}), keeping the connected token. Only the path and query can change, on the same origin. Approvals are always the user's tap on a card in the chat, and ky ignores any elicitation_mode in the URL. ky tests the new URL before keeping it. Change it only when the user asks.`,
    parameters: Type.Object({ url: Type.Optional(Type.String({ description: "The new URL. Leave out to only show the current one." })) }),
    replay: "safe",
    execute: async (args) => {
      if (args.url === undefined) return { output: [{ type: "text", text: `Executor is connected at ${current}.` }] };
      const { refused } = await retargeted(args.url);

      return refused
        ? toolReply(`Not changed: ${refused}`, true)
        : { output: [{ type: "text", text: `Executor is now connected at ${args.url.trim()}. Its tools reconnect there on their next call.` }] };
    }
  });
}

export class ExecutorLink {
  readonly #edge: Edge<Link>;
  readonly #fetch: typeof fetch | undefined;
  readonly #listeners = new Set<() => Promise<void> | void>();

  constructor(vault: () => ExecutorVault, id: string, reach?: typeof fetch) {
    this.#edge = makeEdge(Link.layer(vault, id));
    this.#fetch = reach;
  }

  onChange(listener: () => Promise<void> | void): void {
    this.#listeners.add(listener);
  }

  async config(): Promise<ExecutorConfig | null> {
    const saved = await this.#edge.runPromise(Link.use((link) => link.saved));

    return Option.match(saved, { onNone: () => null, onSome: (connection) => (this.#fetch ? { ...connection, fetch: this.#fetch } : connection) });
  }

  async view(): Promise<Pick<ExecutorView, "url">> {
    return { url: await this.#edge.runPromise(Link.use((link) => link.url)) };
  }

  async connect(url: string, token: string): Promise<{ refused?: string }> {
    return this.#settled(await this.#edge.runPromise(connect(url, token, this.#fetch)));
  }

  async retarget(url: string): Promise<{ refused?: string }> {
    return this.#settled(await this.#edge.runPromise(retarget(url, this.#fetch)));
  }

  async disconnect(): Promise<void> {
    await this.#edge.runPromise(Link.use((link) => link.forget));
    await this.#changed();
  }

  async #settled(result: { refused?: string }): Promise<{ refused?: string }> {
    if (!isRefusal(result)) await this.#changed();

    return result;
  }

  async #changed(): Promise<void> {
    await Promise.all([...this.#listeners].map(async (listener) => listener()));
  }
}
