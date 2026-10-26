import type { JsonObject } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, hook, ToolTask } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Type from "typebox";
import { toolReply as reply } from "../core/reply";
import { badInfo, type CredentialInfo, HTTP_KIND, replyFailed, replyText, SECRET_NAME } from "./credentials";
import { SchemeSchema } from "./shapes";
import { HOOK_TURN_TOOLS, type Inbound, type SecretCall } from "./inbound";

const RequestSecret = Type.Object({
  name: Type.String({ pattern: SECRET_NAME.source, description: "What to call it, like GITHUB_TOKEN: a letter, then letters, digits, _ and -." }),
  origin: Type.String({ description: "The only https origin it may be sent to, like https://api.github.com." }),
  scheme: Type.Union(SchemeSchema.anyOf, {
    description: "bearer: Authorization: Bearer <value>. basic: Authorization: Basic of user:password. header: the value in a header of its own."
  }),
  header: Type.Optional(Type.String({ description: "The header's name, for a header credential only, like X-Api-Key." })),
  purpose: Type.String({ maxLength: 200, description: "What it's for, in a few words the user reads before they enter it." })
});

const SecretRequest = Type.Object({
  name: Type.String({ description: "The credential's name, as list_secrets shows it." }),
  url: Type.String({ description: "An https URL on the credential's own origin." }),
  method: Type.Optional(Type.String({ description: "GET when left out. Anything but GET and HEAD waits for the user's approval." })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  body: Type.Optional(Type.String())
});

const READS = new Set(["GET", "HEAD"]);

const NOT_A_CHAT = "Only a chat with the user can use credentials.";

export function inboundTools(inbound: Inbound): Extension {
  const { desk } = inbound;

  return defineExtension({
    name: "credentials",
    tools: [
      defineTool({
        name: "request_secret",
        description:
          "Ask the user for an API credential: a token, key or password ky calls an API with. The chat shows them a masked field; what they type goes " +
          "to ky's Vault and never to you. Your turn ends here; once they save it you're told, and call the API with secret_request. " +
          "Never ask for a credential in a message: the user's words are in the chat's history.",
        parameters: RequestSecret,
        replay: "safe",
        execute: async (args, api) => {
          const session = String(api.conversationId);

          if (!desk.chat(session)) return reply(NOT_A_CHAT, true);
          const info: CredentialInfo = { origin: args.origin, scheme: args.scheme, header: args.header ?? null, purpose: args.purpose.trim() };
          const bad = badInfo(args.name, info);

          if (bad) return reply(bad, true);
          inbound.ask(session, args.name, info);

          return {
            ...reply(`A masked field for ${args.name} is showing in the chat. Your turn ends here; you're told once the user saves it.`),
            control: { terminate: true }
          };
        }
      }),
      defineTool({
        name: "list_secrets",
        description: "The API credentials ky keeps: each one's name, the origin it is sent to, how, and what it's for. Never their values.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api) => {
          if (!desk.chat(String(api.conversationId))) return reply(NOT_A_CHAT, true);
          const kept = (await desk.vault().status()).filter((secret) => secret.kind === HTTP_KIND);

          if (kept.length === 0) return reply("No credentials yet. Ask for one with request_secret.");

          return reply(
            kept
              .map(({ id, meta }) => {
                const how = meta?.scheme === "header" ? `header ${String(meta.header)}` : String(meta?.scheme);

                return `${id}: ${String(meta?.origin)} (${how}): ${String(meta?.purpose)}`;
              })
              .join("\n")
          );
        }
      }),
      defineTool({
        name: "secret_request",
        description:
          "Call an API with a credential the user saved: ky's Vault adds it and makes the call, to that credential's origin only, and answers with the " +
          "status and body, the credential cut out of it, up to 20,000 characters. It follows no redirect. A GET or HEAD goes at once; any other " +
          "method waits for the user's approval, and your turn ends until they decide.",
        parameters: SecretRequest,
        replay: "unsafe",
        execute: async (args, api) => {
          const conversation = String(api.conversationId);
          const method = (args.method ?? "GET").toUpperCase();

          if (!desk.chat(conversation)) return reply(NOT_A_CHAT, true);

          if (!/^[A-Z]{1,16}$/.test(method)) return reply("A method is a word, like GET or POST.", true);

          const call: SecretCall = { name: args.name, url: args.url, method, headers: args.headers ?? {}, body: args.body ?? null, guarded: inbound.guarded(conversation) };

          if (!READS.has(method)) return askToCall(inbound, call, conversation, { ...args, method });

          const answer = await desk.vault().httpRequest(call.name, { url: call.url, method, headers: call.headers, body: call.body });

          return reply(replyText(answer), replyFailed(answer));
        }
      })
    ]
  });
}

async function askToCall(inbound: Inbound, call: SecretCall, conversation: string, args: JsonObject) {
  const summary = `${call.method} ${call.url} with ${call.name}${await sentWith(inbound, call)}${call.guarded ? WHILE_ON_HOOK : ""}`;

  const asked = await inbound.requestApproval(
    { kind: "secret-request", subject: call.name, summary, payload: call, conversation },
    "secret_request",
    args
  );

  if ("refused" in asked) return reply(asked.refused, true);

  if (asked.asked.status !== "pending") return reply(`The user already ${asked.asked.status === "accepted" ? "approved" : "turned down"} that call, and ky is carrying it out. Don't ask again.`, true);

  return {
    ...reply(`${call.method} ${call.url} waits for the user's approval, asked for in the chat. Your turn ends here; ky makes the call if they approve, and tells you what came back.`),
    control: { terminate: true }
  };
}

export function hookGuard(inbound: Inbound): Extension {
  return defineExtension({
    name: "hook-guard",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          const conversation = String(api.conversationId);

          if (HOOK_TURN_TOOLS.has(call.name) || !inbound.guarded(conversation) || inbound.passed(conversation, call.name, call.arguments)) return undefined;

          const asked = await inbound.requestApproval(
            {
              kind: "webhook-action",
              subject: call.name,
              summary: `${call.name} ${brief(call.arguments)}${WHILE_ON_HOOK}`,
              payload: { tool: call.name, arguments: call.arguments },
              conversation
            },
            call.name,
            call.arguments
          );

          if ("refused" in asked) return { block: `This chat is working on a webhook's outside data, so ${call.name} isn't made: ${asked.refused}` };

          if (asked.asked.status !== "pending") {
            return { block: `This chat is working on a webhook's outside data. The user already ${asked.asked.status === "accepted" ? "approved" : "turned down"} that call, and ky is carrying it out: don't make it again.` };
          }

          return {
            block:
              `This chat is working on a webhook's outside data, so ${call.name} waits for the user's approval, asked for in the chat. ` +
              "Don't call it again: say what you would do, and end your turn. You're told what they decide."
          };
        }
      })
    ]
  });
}

const BRIEF_CHARS = 600;

const keptHeaderOf = Schema.decodeUnknownOption(Schema.Struct({ header: Schema.NullOr(Schema.String) }));

const WHILE_ON_HOOK = ", while working on a webhook";

async function sentWith(inbound: Inbound, call: SecretCall): Promise<string> {
  const meta = (await inbound.desk.vault().status()).find((secret) => secret.kind === HTTP_KIND && secret.id === call.name)?.meta;
  const own = Option.getOrElse(Option.flatMapNullishOr(keptHeaderOf(meta), (kept) => kept.header), () => "Authorization").toLowerCase();
  const headers = Object.fromEntries(Object.entries(call.headers).filter(([key]) => key.toLowerCase() !== own));
  const sent: JsonObject = {};

  if (Object.keys(headers).length > 0) sent.headers = headers;

  if (call.body !== null) sent.body = call.body;

  return Object.keys(sent).length > 0 ? ` ${brief(sent)}` : "";
}

function brief(args: JsonObject): string {
  const text = JSON.stringify(args);

  return text.length > BRIEF_CHARS ? `${text.slice(0, BRIEF_CHARS - 1)}…` : text;
}
