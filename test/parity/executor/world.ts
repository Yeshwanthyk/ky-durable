import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { type Attempt, type CallResult, type ExecutorConfig, type ExecutorGate, type ExecutorRetarget, type ExecutorVault, type ProgramOutcome, programOutcome, type ResumeAction } from "../../../src/executor/contract";
import { callOnce, executeOnce, executorExtension, ExecutorLink } from "../../../src/executor/wiring";
import { FakeExecutor } from "../../../src/tests/fake-executor";
import type { Instance, Json } from "../kit";

export const TOKEN = "ky-stack-executor";

export const BASE = "https://executor.test/mcp";

export const AGENT = "agent";

export const THEIRS = "theirs";

export const REFUSED_RESUME = "That request is another chat's.";

const REACHABLE = new Set(["executor.test", "localhost"]);

export type LinkSide = {
  onChange(listener: () => Promise<void> | void): void;
  config(): Promise<ExecutorConfig | null>;
  view(): Promise<{ url: string | null }>;
  connect(url: string, token: string): Promise<{ refused?: string }>;
  retarget(url: string): Promise<{ refused?: string }>;
  disconnect(): Promise<void>;
};

export type Side = {
  link(vault: () => ExecutorVault, id: string, reach: typeof fetch): LinkSide;
  extension(config: ExecutorConfig, gate: ExecutorGate, retargeted?: ExecutorRetarget): Extension;
  callOnce(config: ExecutorConfig, name: string, args: Record<string, JsonValue | undefined>, signal?: AbortSignal): Promise<Attempt>;
  executeOnce(config: ExecutorConfig, code: string, signal: AbortSignal): Promise<{ text: string; error: boolean }>;
  programOutcome(text: string): ProgramOutcome;
};

export const next: Side = {
  link: (vault, id, reach) => new ExecutorLink(vault, id, reach),
  extension: executorExtension,
  callOnce,
  executeOnce,
  programOutcome
};

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

  tables(): Json {
    return Object.fromEntries([...this.rows].sort(([a], [b]) => a.localeCompare(b)));
  }
}

export type Action =
  | { readonly kind: "connect"; readonly url: string; readonly token: string }
  | { readonly kind: "retarget"; readonly url: string }
  | { readonly kind: "disconnect" }
  | { readonly kind: "config" }
  | { readonly kind: "view" }
  | { readonly kind: "skills"; readonly app?: string }
  | { readonly kind: "execute"; readonly code: string }
  | { readonly kind: "resume"; readonly requestId: string; readonly action: ResumeAction; readonly content?: Record<string, string> }
  | { readonly kind: "connection"; readonly url?: string }
  | { readonly kind: "once"; readonly code: string; readonly aborted: boolean }
  | { readonly kind: "executeOnce"; readonly code: string }
  | { readonly kind: "outcome"; readonly text: string }
  | { readonly kind: "expire" }
  | { readonly kind: "refuse"; readonly times: number }
  | { readonly kind: "rotate"; readonly token: string }
  | { readonly kind: "loseResume" }
  | { readonly kind: "damage"; readonly value: Json; readonly meta: Json };

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

export const PROGRAMS = [
  "hello",
  "answer [1]",
  "answer null",
  'answer {"a":2}',
  "throw boom",
  "fail nope",
  "approve gmail.send mail sam",
  "ask which label",
  "lose-response"
];

export const OUTCOMES = [
  '{"status":"completed","execution":{"ok":true,"value":[1]}}',
  '{"status":"completed","execution":{"ok":true}}',
  '{"status":"completed","execution":{"ok":false,"error":"  boom  "}}',
  '{"status":"completed","execution":{"ok":false,"error":{"message":"nope"}}}',
  '{"status":"completed","execution":{"ok":false,"error":{"message":"   "}}}',
  '{"status":"completed","execution":{"ok":false,"error":{"code":7}}}',
  '{"status":"completed","execution":{"ok":false}}',
  '{"status":"completed","execution":{"ok":false,"error":""}}',
  '{"status":"failed","execution":{"ok":false}}',
  '{"status":"approval-required","requestId":"r"}',
  '{"status" : "input-required"}',
  '{"status":"completed"}',
  "  not json at all  ",
  "x".repeat(300)
];

const requestIds = fc.constantFrom("request-1", "request-2", "request-3", THEIRS);

export const actions: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("connect" as const), url: fc.constantFrom(...URLS), token: fc.constantFrom(...TOKENS) }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("retarget" as const), url: fc.constantFrom(...URLS) }), weight: 2 },
  { arbitrary: fc.constant({ kind: "disconnect" as const }), weight: 1 },
  { arbitrary: fc.constant({ kind: "config" as const }), weight: 1 },
  { arbitrary: fc.constant({ kind: "view" as const }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("skills" as const), app: fc.constantFrom("calendar", undefined) }, { requiredKeys: ["kind"] }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("execute" as const), code: fc.constantFrom(...PROGRAMS) }), weight: 4 },
  {
    arbitrary: fc.record(
      {
        kind: fc.constant("resume" as const),
        requestId: requestIds,
        action: fc.constantFrom<ResumeAction>("answer", "decline", "cancel"),
        content: fc.constantFrom({ label: "work" }, undefined)
      },
      { requiredKeys: ["kind", "requestId", "action"] }
    ),
    weight: 3
  },
  { arbitrary: fc.record({ kind: fc.constant("connection" as const), url: fc.constantFrom(...URLS, undefined) }, { requiredKeys: ["kind"] }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("once" as const), code: fc.constantFrom(...PROGRAMS), aborted: fc.boolean() }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("executeOnce" as const), code: fc.constantFrom(...PROGRAMS) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("outcome" as const), text: fc.constantFrom(...OUTCOMES) }), weight: 2 },
  { arbitrary: fc.constant({ kind: "expire" as const }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("refuse" as const), times: fc.integer({ min: 1, max: 2 }) }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("rotate" as const), token: fc.constantFrom(TOKEN, "rotated") }), weight: 1 },
  { arbitrary: fc.constant({ kind: "loseResume" as const }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant("damage" as const),
      value: fc.constantFrom<Json>({ url: BASE }, { url: 5, token: TOKEN }, "nonsense"),
      meta: fc.constantFrom<Json>({ url: 7 }, null, { url: "" })
    }),
    weight: 1
  }
);

const plain = Schema.decodeUnknownSync(Schema.MutableJson);

function json<Value>(value: Value): Json {
  return plain(JSON.parse(JSON.stringify(value) ?? "null"));
}

const abortedSignal = (): AbortSignal => {
  const controller = new AbortController();

  controller.abort();

  return controller.signal;
};

export class World {
  readonly executor = new FakeExecutor(TOKEN);
  readonly vault = new FakeVault();
  readonly gate: Json[] = [];
  readonly fetched: string[] = [];
  changes = 0;
  readonly #side: Side;
  readonly link: LinkSide;
  #extension: Extension | undefined;

  constructor(side: Side) {
    this.#side = side;
    this.link = side.link(this.vault.vault, AGENT, this.reach);
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

  async #tool(name: string, args: Record<string, JsonValue | undefined>): Promise<Json> {
    const config = await this.link.config();

    if (config === null) return { notConnected: name };
    this.#extension ??= this.#side.extension(config, this.gateOf, (url) => this.link.retarget(url));
    const tool = this.#extension.tools?.find((each) => each.name === name);

    if (tool === undefined) return { noTool: name };
    // SAFETY: the executor tools read only the calling conversation from their api.
    const api = { conversationId: 7 } as ToolExecutionApi;

    return json(await tool.execute(args, api, BACKGROUND_CONTEXT));
  }

  async #once(run: (config: ExecutorConfig) => Promise<object>): Promise<Json> {
    const config = await this.link.config();

    return config === null ? { notConnected: "once" } : json(await run(config));
  }

  async #config(): Promise<Json> {
    const config = await this.link.config();

    return config === null ? null : { url: config.url, token: config.token, fetch: config.fetch === this.reach };
  }

  async apply(action: Action): Promise<Json> {
    switch (action.kind) {
      case "connect":
        return json(await this.link.connect(action.url, action.token));
      case "retarget":
        return json(await this.link.retarget(action.url));
      case "disconnect":
        await this.link.disconnect();

        return null;
      case "config":
        return this.#config();
      case "view":
        return json(await this.link.view());
      case "skills":
        return this.#tool("executor_skills", action.app === undefined ? {} : { app: action.app });
      case "execute":
        return this.#tool("executor_execute", { code: action.code });
      case "resume":
        return this.#tool("executor_resume", {
          requestId: action.requestId,
          response: action.content === undefined ? { action: action.action } : { action: action.action, content: action.content }
        });
      case "connection":
        return this.#tool("executor_connection", action.url === undefined ? {} : { url: action.url });
      case "once":
        return this.#once(async (config) => this.#side.callOnce(config, "execute", { code: action.code }, action.aborted ? abortedSignal() : undefined));
      case "executeOnce":
        return this.#once(async (config) => this.#side.executeOnce(config, action.code, new AbortController().signal));
      case "outcome":
        return json(this.#side.programOutcome(action.text));
      case "expire":
        this.executor.open.clear();

        return null;
      case "refuse":
        this.executor.refuseConnects = action.times;

        return null;
      case "rotate":
        this.executor.token = action.token;

        return null;
      case "loseResume":
        this.executor.loseResumeAnswers = 1;

        return null;
      case "damage":
        this.vault.store(AGENT, action.value, action.meta);

        return null;
    }
  }

  effects(): Json {
    const executor = this.executor;

    return {
      runs: Object.fromEntries(executor.runs),
      sessions: executor.sessions,
      unauthorized: executor.unauthorized,
      cancelled: executor.cancelled,
      connectedUrls: executor.connectedUrls,
      resumes: json(executor.resumes),
      fetched: this.fetched,
      writes: this.vault.writes,
      gate: this.gate,
      changes: this.changes
    };
  }
}

export function instanceOf(side: Side): Instance<Action> {
  const world = new World(side);

  return {
    apply: async (action) => world.apply(action),
    tables: async () => world.vault.tables(),
    effects: async () => world.effects(),
    dispose: async () => undefined
  };
}
