import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import type { MachineInfo } from "../../../src/protocol";
import type { ChatGptLogin, Device, Fetch, KeyVault, ModelsBoundary, ProviderKey } from "../../../src/providers/contract";
import { Models, pollDevice, refreshLogin, startDevice } from "../../../src/providers/wiring";
import type { ModelChoice, Purpose } from "../../../src/settings/contract";
import { type AiCall, chatCompletions, fakeAI, type Reply } from "../../fakes/ai";
import { ANTHROPIC_KEY, OPENAI_KEY, vendors } from "../../fakes/vendors";
import { fakeVibeProxy, VIBEPROXY_KEY, VIBEPROXY_TEST_PORT } from "../../fakes/vibeproxy";
import { clockAt } from "../access/clock";
import type { Clock, Instance, Json } from "../kit";
import { storageOf } from "../skills/storage";

export type ModelsSide = Pick<
  Models,
  "settings" | "registry" | "onChange" | "choices" | "catalog" | "view" | "addKey" | "removeKey" | "refresh" | "probe" | "resolve" | "worker" | "valid" | "imageSupport" | "complete" | "ask"
>;

type Machines = ConstructorParameters<typeof Models>[3];

type Pipe = ConstructorParameters<typeof Models>[4];

export type Side = {
  models(storage: DurableObjectStorage, boundary: ModelsBoundary, vault: KeyVault, machines: Machines, pipe: Pipe, clock: Clock): ModelsSide;
  startDevice(fetch: Fetch): Promise<Device>;
  pollDevice(fetch: Fetch, device: Device): Promise<ChatGptLogin | "pending">;
  refreshLogin(fetch: Fetch, current: ChatGptLogin): Promise<ChatGptLogin>;
  timed<T>(clock: Clock, work: () => Promise<T>): Promise<T>;
};

export const next: Side = {
  models: (storage, boundary, vault, machines, pipe, clock) => new Models(storage, boundary, vault, machines, pipe, clockAt(() => clock.now())),
  startDevice,
  pollDevice,
  refreshLogin,
  timed: (_clock, work) => work()
};

export const START = 1_700_000_000_000;

export const PROBE_TTL_MS = 10_000;

export const COOLDOWN_MS = 60_000;

export const MACHINES = ["mac", "mini"] as const;

export const PURPOSES: readonly Purpose[] = ["main", "worker", "background", "fallback"];

export const OPENCODE_KEY = "opencode-test-key";

export const SUBSCRIPTION_TOKEN = "sk-ant-oat01-subscription";

export const MODELS = {
  "workers-ai": ["workers-ai/@cf/zai-org/glm-5.3-flash", "workers-ai/@cf/moonshotai/kimi-k2.6", "workers-ai/@cf/openai/gpt-oss-120b"],
  vibeproxy: ["claude-opus-5-5", "claude-haiku-5-5"],
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-opus-4-5"],
  openai: ["gpt-6.1-sol", "gpt-6-luna"],
  "opencode-go": ["deepseek-v4.1-flash", "glm-5.3"],
  gone: ["retired"]
} as const satisfies Record<string, readonly string[]>;

export const REPLIES = {
  hi: { text: "hi" },
  title: { text: "Title: A fine chat" },
  bad: { status: 400, error: "bad request" },
  unauthorized: { status: 401, error: "no such key" },
  limited: { status: 429, error: "slow down" },
  broken: { status: 500, error: "upstream broke" }
} satisfies Record<string, Reply>;

export type ReplyName = keyof typeof REPLIES;

export const DEVICE_ANSWERS = ["ok", "interval0", "garbled", "refused", "bare500", "topCode", "throws"] as const;

export const POLL_ANSWERS = ["ok", "pending403", "pending404", "forbidden", "noAccount", "badJwt", "tokenRefused", "throws"] as const;

export const REFRESH_ANSWERS = ["ok", "keeps", "invalidated", "badJwt", "noExp", "garbled"] as const;

type DeviceAnswer = (typeof DEVICE_ANSWERS)[number];

type PollAnswer = (typeof POLL_ANSWERS)[number];

type RefreshAnswer = (typeof REFRESH_ANSWERS)[number];

export type Action =
  | { readonly kind: "addKey"; readonly vendor: string; readonly key: string }
  | { readonly kind: "removeKey"; readonly id: string }
  | { readonly kind: "machine"; readonly name: string; readonly online: boolean; readonly shares: boolean }
  | { readonly kind: "vibe"; readonly up: boolean }
  | { readonly kind: "down"; readonly provider: "workers-ai" | "opencode-go"; readonly down: boolean }
  | { readonly kind: "reply"; readonly reply: ReplyName }
  | { readonly kind: "refresh" }
  | { readonly kind: "probe" }
  | { readonly kind: "set"; readonly purpose: Purpose; readonly choice: ModelChoice }
  | { readonly kind: "resolve"; readonly purpose: Purpose; readonly images: boolean }
  | { readonly kind: "view" }
  | { readonly kind: "catalog" }
  | { readonly kind: "choices" }
  | { readonly kind: "worker"; readonly own: ModelChoice | null }
  | { readonly kind: "valid"; readonly choice: ModelChoice }
  | { readonly kind: "imageSupport"; readonly purpose: Purpose }
  | { readonly kind: "ask"; readonly purpose: Purpose; readonly text: string; readonly maxTokens: number }
  | { readonly kind: "complete"; readonly purpose: Purpose }
  | { readonly kind: "reboot"; readonly tunnel: boolean }
  | { readonly kind: "record"; readonly row: RawRow }
  | { readonly kind: "enable"; readonly id: string; readonly enabled: 0 | 1 }
  | { readonly kind: "device"; readonly answer: DeviceAnswer }
  | { readonly kind: "poll"; readonly answer: PollAnswer }
  | { readonly kind: "refreshLogin"; readonly answer: RefreshAnswer };

export type RawRow = {
  readonly id: string;
  readonly kind: string;
  readonly vendor: string | null;
  readonly machine: string | null;
  readonly port: number | null;
  readonly api: string | null;
  readonly label: string;
  readonly enabled: number;
};

export const PROVIDER_IDS = ["workers-ai", "vibeproxy", "anthropic", "openai", "opencode-go", "gone"];

const aPurpose = fc.constantFrom(...PURPOSES);

export const aChoice: fc.Arbitrary<ModelChoice> = fc
  .constantFrom(...Object.entries(MODELS).flatMap(([provider, ids]) => ids.map((modelId) => ({ provider, modelId }))))
  .chain((pick) => fc.constantFrom("off", "minimal", "low", "medium", "high", "xhigh", "max" as const).map((thinkingLevel) => ({ ...pick, thinkingLevel })));

const aKey = fc.constantFrom(ANTHROPIC_KEY, OPENAI_KEY, OPENCODE_KEY, `  ${ANTHROPIC_KEY}  `, SUBSCRIPTION_TOKEN, `x${SUBSCRIPTION_TOKEN}`, "", "   ", "wrong");

export const aRawRow: fc.Arbitrary<RawRow> = fc.oneof(
  fc.record({
    id: fc.constantFrom("nope", "anthropic", "elsewhere"),
    kind: fc.constant("api-key"),
    vendor: fc.constantFrom("nope", "anthropic", "openai", null),
    machine: fc.constant(null),
    port: fc.constant(null),
    api: fc.constant(null),
    label: fc.constantFrom("Nope", "Anthropic"),
    enabled: fc.constantFrom(0, 1, 2)
  }),
  fc.record({
    id: fc.constantFrom("ollama", "vibeproxy"),
    kind: fc.constant("runner-local"),
    vendor: fc.constant(null),
    machine: fc.constantFrom(...MACHINES, null),
    port: fc.constantFrom(VIBEPROXY_TEST_PORT, null),
    api: fc.constantFrom("anthropic-messages", "openai-completions"),
    label: fc.constantFrom("Ollama", "Claude via VibeProxy"),
    enabled: fc.constantFrom(0, 1)
  })
);

export const actions: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("addKey" as const), vendor: fc.constantFrom("anthropic", "openai", "opencode-go", "nope"), key: aKey }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("removeKey" as const), id: fc.constantFrom(...PROVIDER_IDS) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("machine" as const), name: fc.constantFrom(...MACHINES), online: fc.boolean(), shares: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("vibe" as const), up: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("down" as const), provider: fc.constantFrom("workers-ai" as const, "opencode-go" as const), down: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("reply" as const), reply: fc.constantFrom<ReplyName>("hi", "title", "bad", "unauthorized", "limited", "broken") }) },
  { weight: 2, arbitrary: fc.constant({ kind: "refresh" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "probe" as const }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("set" as const), purpose: aPurpose, choice: aChoice }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("resolve" as const), purpose: aPurpose, images: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ kind: "view" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "catalog" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "choices" as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("worker" as const), own: fc.option(aChoice, { nil: null }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("valid" as const), choice: aChoice }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("imageSupport" as const), purpose: aPurpose }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("ask" as const), purpose: aPurpose, text: fc.constantFrom("hello", "please fail"), maxTokens: fc.constantFrom(16, 2_000) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("complete" as const), purpose: aPurpose }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("reboot" as const), tunnel: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("record" as const), row: aRawRow }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("enable" as const), id: fc.constantFrom(...PROVIDER_IDS), enabled: fc.constantFrom(0 as const, 1 as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("device" as const), answer: fc.constantFrom(...DEVICE_ANSWERS) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("poll" as const), answer: fc.constantFrom(...POLL_ANSWERS) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("refreshLogin" as const), answer: fc.constantFrom(...REFRESH_ANSWERS) }) }
);

export const advances = fc.constantFrom(1_000, PROBE_TTL_MS, COOLDOWN_MS - 1, COOLDOWN_MS + 1_000);

const base64url = (value: Json) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const jwt = (claims: { readonly [key: string]: Json }) => `${base64url({ alg: "none" })}.${base64url(claims)}.sig`;

export const ID_TOKEN = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });

export const ACCESS_TOKEN = jwt({ exp: 1_800_000_000 });

export const DEVICE: Device = { deviceAuthId: "dev-1", userCode: "ABCD-1234", intervalMs: 5_000 };

export const LOGIN: ChatGptLogin = { accessToken: ACCESS_TOKEN, refreshToken: "refresh-1", idToken: ID_TOKEN, accountId: "acct-1", expiresAt: 1_800_000_000_000 };

const tokens = (overrides: { readonly [key: string]: Json } = {}) => Response.json({ id_token: ID_TOKEN, access_token: ACCESS_TOKEN, refresh_token: "refresh-2", ...overrides });

function deviceAnswer(answer: DeviceAnswer): Response {
  switch (answer) {
    case "ok":
      return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "5" });
    case "interval0":
      return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "0" });
    case "garbled":
      return new Response("not json");
    case "refused":
      return Response.json({ error: { code: "bad_client" } }, { status: 401 });
    case "bare500":
      return new Response("down", { status: 500 });
    case "topCode":
      return Response.json({ code: "rate_limited", error: "slow" }, { status: 429 });
    case "throws":
      throw new Error("getaddrinfo ENOTFOUND auth.openai.com");
  }
}

function pollAnswer(answer: PollAnswer, path: string): Response {
  if (path.endsWith("/deviceauth/token")) {
    switch (answer) {
      case "pending403":
        return Response.json({ error: { code: "deviceauth_authorization_pending" } }, { status: 403 });
      case "pending404":
        return Response.json({ code: "deviceauth_authorization_pending" }, { status: 404 });
      case "forbidden":
        return Response.json({ error: "denied" }, { status: 403 });
      case "throws":
        throw new Error("socket hang up");
      default:
        return Response.json({ authorization_code: "code-1", code_verifier: "verifier-1" });
    }
  }

  switch (answer) {
    case "noAccount":
      return tokens({ id_token: jwt({}) });
    case "badJwt":
      return tokens({ access_token: "not-a-jwt" });
    case "tokenRefused":
      return Response.json({ error: { code: "invalid_grant" } }, { status: 400 });
    default:
      return tokens();
  }
}

function refreshAnswer(answer: RefreshAnswer): Response {
  switch (answer) {
    case "ok":
      return tokens();
    case "keeps":
      return Response.json({ access_token: ACCESS_TOKEN });
    case "invalidated":
      return Response.json({ error: { code: "refresh_token_invalidated" } }, { status: 401 });
    case "badJwt":
      return Response.json({ access_token: "a.b.c" });
    case "noExp":
      return Response.json({ access_token: jwt({}) });
    case "garbled":
      return Response.json({ access_token: 7 });
  }
}

type MachineState = { online: boolean; shares: boolean };

const flushed = async () => {
  for (let tick = 0; tick < 8; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function machineInfo(name: string, state: MachineState): MachineInfo {
  return {
    name,
    online: state.online,
    seenAt: 0,
    reason: null,
    active: 0,
    state: "on",
    note: "",
    facts: {
      os: "darwin",
      chrome: false,
      repos: [],
      agents: { claude: { installed: false, signedIn: false }, codex: { installed: false, signedIn: false } },
      ports: state.shares ? [VIBEPROXY_TEST_PORT] : [],
      kind: "computer"
    },
    login: "own",
    cloud: null,
    sandbox: null
  };
}

const shownModel = (model: { provider: string; id: string; name: string; input: readonly string[]; contextWindow: number }): Json => ({
  provider: model.provider,
  id: model.id,
  name: model.name,
  input: [...model.input],
  contextWindow: model.contextWindow
});

const shownAnswer = (answer: AssistantMessage): Json => ({
  stopReason: answer.stopReason,
  provider: answer.provider,
  model: answer.model,
  errorMessage: answer.errorMessage ?? null,
  text: answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
});

type Answer = object | string | number | boolean | null | undefined;

async function settle(call: () => Answer | Promise<Answer>): Promise<Json> {
  try {
    const result = await call();

    // SAFETY: what Models and sign-in answer is plain data, rows and strings; JSON keeps what is JSON of it.
    return result === undefined ? null : (JSON.parse(JSON.stringify(result)) as Json);
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

export class World {
  readonly db = new DatabaseSync(":memory:");
  readonly keys = new Map<string, ProviderKey>();
  readonly vaultLog: Json[] = [];
  readonly calls: AiCall[] = [];
  readonly openai: Json[] = [];
  readonly machines = new Map<string, MachineState>();
  readonly down = new Set<string>();
  vibeUp = true;
  tunnel = false;
  reply: Reply = REPLIES.hi;
  changes = 0;
  models: ModelsSide;
  readonly side: Side;
  readonly clock: Clock;

  constructor(side: Side, clock: Clock) {
    this.side = side;
    this.clock = clock;
    this.models = this.boot();
  }

  boot(): ModelsSide {
    const script = () => this.reply;
    const refusing = (id: string) => async () => (this.down.has(id) ? 503 : undefined);

    const vibe = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!this.vibeUp) throw new Error("connect ECONNREFUSED 127.0.0.1:8317");

      return fakeVibeProxy(new Request(input, init));
    };

    const boundary: ModelsBoundary = {
      ai: fakeAI(chatCompletions(script, this.calls, refusing("workers-ai"))),
      fetch: vendors(script, this.calls, chatCompletions(script, this.calls, refusing("opencode-go"))),
      vibeProxy: { port: VIBEPROXY_TEST_PORT, key: VIBEPROXY_KEY, tunnel: this.tunnel ? { binding: { fetch: vibe }, origin: "https://vibeproxy.test:8443" } : undefined },
      probeTtlMs: PROBE_TTL_MS
    };

    const vault: KeyVault = {
      auth: async (id) => this.keys.get(id) ?? null,
      put: async (kind, id, value) => {
        this.vaultLog.push({ put: kind, id, apiKey: value.apiKey });
        this.keys.set(id, value);
      },
      remove: async (kind, id) => {
        this.vaultLog.push({ remove: kind, id });
        this.keys.delete(id);
      }
    };

    const machines: Machines = {
      machines: () => [...this.machines].map(([name, state]) => machineInfo(name, state)),
      online: (name) => this.machines.get(name)?.online === true
    };

    const pipe: Pipe = {
      fetcher: (machine) => async (input, init) => {
        if (!this.machines.get(machine)?.online) throw new Error(`${machine} is offline.`);

        return vibe(input, init);
      }
    };

    const models = this.side.models(storageOf(this.db), boundary, vault, machines, pipe, this.clock);

    models.onChange(() => this.changes++);

    return models;
  }

  #openai(answer: (path: string) => Response): Fetch {
    return async (input, init) => {
      const path = new URL(input).pathname;

      this.openai.push({ path, body: await new Request(input, init).text() });

      return answer(path);
    };
  }

  apply(action: Action): Promise<Json> {
    return settle(() => this.#step(action));
  }

  async #step(action: Action): Promise<Answer> {
    const models = this.models;

    switch (action.kind) {
      case "addKey":
        return models.addKey(action.vendor, action.key);
      case "removeKey":
        await models.removeKey(action.id);

        return {};
      case "machine":
        this.machines.set(action.name, { online: action.online, shares: action.shares });

        return null;
      case "vibe":
        this.vibeUp = action.up;

        return null;
      case "down":
        if (action.down) this.down.add(action.provider);
        else this.down.delete(action.provider);

        return null;
      case "reply":
        this.reply = REPLIES[action.reply];

        return null;
      case "refresh":
        await models.refresh();

        return null;
      case "probe":
        await models.probe();

        return null;
      case "set":
        return models.settings.set(action.purpose, action.choice);

      case "resolve": {
        const { choice, model } = models.resolve(action.purpose, action.images ? { images: true } : {});

        return { choice, model: shownModel(model) };
      }

      case "view":
        return models.view();

      case "catalog":
        return models.catalog();
      case "choices":
        return models.choices();
      case "worker":
        return models.worker(action.own);

      case "valid":
        return models.valid(action.choice) ?? null;

      case "imageSupport":
        return models.imageSupport(action.purpose);
      case "ask": {
        const messages: Message[] = [{ role: "user", content: action.text, timestamp: this.clock.now() }];

        return models.ask(action.purpose, "Be brief.", messages, { timeoutMs: 20_000, maxTokens: action.maxTokens }).then(shownAnswer);
      }

      case "complete":
        return models.complete(action.purpose, "Name this chat.", "hello");
      case "reboot":
        this.tunnel = action.tunnel;
        this.models = this.boot();

        return null;
      case "record": {
        const { id, kind, vendor, machine, port, api, label, enabled } = action.row;

        this.db
          .prepare(
            `INSERT INTO ky_providers (id, kind, vendor, machine, port, api, label, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, vendor = excluded.vendor, machine = excluded.machine, port = excluded.port, api = excluded.api, enabled = excluded.enabled`
          )
          .run(id, kind, vendor, machine, port, api, label, enabled);

        return null;
      }

      case "enable":
        this.db.prepare("UPDATE ky_providers SET enabled = ? WHERE id = ?").run(action.enabled, action.id);

        return null;
      case "device": {
        const { answer } = action;

        return this.side.startDevice(this.#openai(() => deviceAnswer(answer)));
      }

      case "poll": {
        const { answer } = action;

        return this.side.pollDevice(this.#openai((path) => pollAnswer(answer, path)), DEVICE);
      }

      case "refreshLogin": {
        const { answer } = action;

        return this.side.refreshLogin(this.#openai(() => refreshAnswer(answer)), LOGIN);
      }
    }
  }

  tables(): Json {
    // SAFETY: both tables hold only text, integers and nulls.
    const rows = (query: string) => this.db.prepare(query).all().map((row) => ({ ...row }) as Json);

    return {
      ky_providers: rows("SELECT id, kind, vendor, machine, port, api, label, enabled FROM ky_providers ORDER BY rowid"),
      ky_purposes: rows("SELECT purpose, value FROM ky_purposes ORDER BY purpose")
    };
  }

  effects(): Json {
    return {
      vault: this.vaultLog,
      calls: this.calls.map((call) => ({ url: call.url, model: call.model, reasoning: call.reasoning, key: call.headers["x-api-key"] ?? call.headers.authorization ?? null })),
      openai: this.openai,
      changes: this.changes
    };
  }
}

export function instanceOf(side: Side, clock: Clock): Instance<Action> {
  const world = side.timed(clock, async () => new World(side, clock));

  return {
    apply: async (action) =>
      side.timed(clock, async () => {
        const result = await (await world).apply(action);

        await flushed();

        return result;
      }),
    tables: async () => (await world).tables(),
    effects: async () => (await world).effects(),
    dispose: async () => (await world).db.close()
  };
}
