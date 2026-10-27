import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import { type CallResult, type ExecutorGate, type ExecutorVault, programOutcome, type ResumeAction } from "../../../src/executor/contract";
import { callOnce, executeOnce, executorExtension, ExecutorLink } from "../../../src/executor/wiring";
import { FakeExecutor } from "../../../src/tests/fake-executor";
import type { Json } from "../kit";

export const TOKEN = "ky-stack-executor";

export const BASE = "https://executor.test/mcp";

export const AGENT = "agent";

export const THEIRS = "theirs";

export const REFUSED_RESUME = "That request is another chat's.";

const REACHABLE = new Set(["executor.test", "localhost"]);

type Stored = { readonly value: Json; readonly meta: Json };

export class FakeVault {
  readonly rows = new Map<string, Stored>();
  readonly writes: Json[] = [];

  constructor() {
    this.rows.set(`executor/other`, { value: { url: "https://other.test/mcp", token: "other-token" }, meta: { url: "https://other.test/mcp" } });
    this.rows.set(`github/${AGENT}`, { value: { token: "gh" }, meta: { url: "https://github.com" } });
  }

  store(id: string, value: Json, meta: Json): void {
    this.rows.set(`executor/${id}`, { value, meta });
  }

  readonly vault = (): ExecutorVault => {
    const { rows, writes } = this;

    const reading = {
      executor: async (id: string) => rows.get(`executor/${id}`)?.value ?? null,
      status: async () =>
        [...rows].map(([key, row]) => {
          const [kind = "", id = ""] = key.split("/");

          return { kind, id, meta: row.meta };
        }),
      put: async (kind: string, id: string, value: Json, meta: Json) => {
        writes.push({ put: kind, id, value, meta });
        rows.set(`${kind}/${id}`, { value, meta });
      },
      remove: async (kind: string, id: string) => {
        writes.push({ remove: kind, id });
        rows.delete(`${kind}/${id}`);
      }
    };

    // SAFETY: the vault hands back what was stored, a damaged row too, as the real Vault's #current does.
    return reading as ExecutorVault;
  };
}

export const URLS = [
  BASE,
  `  ${BASE}  `,
  `${BASE}?elicitation_mode=browser`,
  `${BASE}?elicitation_mode=browser&team=1`,
  "https://executor.test/v2/mcp",
  "http://localhost/mcp",
  "http://executor.test/mcp",
  "https://elsewhere.test/mcp",
  "not a url",
  "ftp://executor.test/mcp",
  ""
];

export const TOKENS = [TOKEN, `  ${TOKEN} `, "wrong", "", "  "];

const plain = Schema.decodeUnknownSync(Schema.MutableJson);

function json<Value>(value: Value): Json {
  return plain(JSON.parse(JSON.stringify(value) ?? "null"));
}

export class World {
  readonly executor = new FakeExecutor(TOKEN);
  readonly vault = new FakeVault();
  readonly gate: Json[] = [];
  readonly fetched: string[] = [];
  changes = 0;
  readonly link: ExecutorLink;
  #extension: Extension | undefined;

  constructor() {
    this.link = new ExecutorLink(this.vault.vault, AGENT, this.reach);
    this.link.onChange(() => {
      this.changes++;
      this.#extension = undefined;
    });
  }

  readonly reach = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(new Request(input, init).url);

    this.fetched.push(url.host);

    if (!REACHABLE.has(url.hostname)) throw new TypeError("fetch failed");

    return this.executor.fetch(input, init);
  };

  readonly gateOf: ExecutorGate = {
    replied: async (result: CallResult, conversation: string) => {
      this.gate.push({ replied: conversation, result: json(result) });

      return result;
    },
    beforeResume: (requestId: string, action: ResumeAction, conversation: string) => {
      this.gate.push({ beforeResume: requestId, action, conversation });

      return requestId === THEIRS ? REFUSED_RESUME : undefined;
    },
    resumed: (requestId: string) => {
      this.gate.push({ resumed: requestId });
    }
  };

  async tool(name: string, args: Record<string, JsonValue | undefined>): Promise<Json> {
    const config = await this.link.config();

    if (config === null) return { notConnected: name };
    this.#extension ??= executorExtension(config, this.gateOf, (url) => this.link.retarget(url));
    const tool = this.#extension.tools?.find((each) => each.name === name);

    if (tool === undefined) return { noTool: name };
    // SAFETY: the executor tools read only the calling conversation from their api.
    const api = { conversationId: 7 } as ToolExecutionApi;

    return json(await tool.execute(args, api, BACKGROUND_CONTEXT));
  }

  async once(code: string, signal?: AbortSignal): Promise<Json> {
    const config = await this.link.config();

    return config === null ? { notConnected: "once" } : json(await callOnce(config, "execute", { code }, signal));
  }

  async executeOnce(code: string): Promise<Json> {
    const config = await this.link.config();

    return config === null ? { notConnected: "executeOnce" } : json(await executeOnce(config, code, new AbortController().signal));
  }
}

export const outcomeOf = (text: string): Json => json(programOutcome(text));
