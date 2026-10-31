import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import type { MachineInfo } from "../../../src/protocol";
import type { ChatGptLogin, Device, Fetch, KeyVault, ModelsBoundary, ProviderKey } from "../../../src/providers/contract";
import { Models, pollDevice, refreshLogin, startDevice } from "../../../src/providers/wiring";
import type { ModelChoice, Purpose } from "../../../src/settings/contract";
import { type AiCall, chatCompletions, fakeAI, type Reply } from "../../fakes/ai";
import { vendors } from "../../fakes/vendors";
import { fakeVibeProxy, VIBEPROXY_KEY, VIBEPROXY_TEST_PORT } from "../../fakes/vibeproxy";
import { clockAt } from "../access/clock";
import type { Clock, Json } from "../kit";
import { storageOf } from "../skills/storage";

type Machines = ConstructorParameters<typeof Models>[3];

type Pipe = ConstructorParameters<typeof Models>[4];

export const START = 1_700_000_000_000;

export const PROBE_TTL_MS = 10_000;

export const COOLDOWN_MS = 60_000;

export const OPENCODE_KEY = "opencode-test-key";

const MODELS = {
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

export const DEVICE_ANSWERS = ["ok", "interval0", "garbled", "refused", "bare500", "topCode", "throws"] as const;

export const POLL_ANSWERS = ["ok", "pending403", "pending404", "forbidden", "noAccount", "badJwt", "tokenRefused", "throws"] as const;

export const REFRESH_ANSWERS = ["ok", "keeps", "invalidated", "badJwt", "noExp", "garbled"] as const;

type DeviceAnswer = (typeof DEVICE_ANSWERS)[number];

type PollAnswer = (typeof POLL_ANSWERS)[number];

type RefreshAnswer = (typeof REFRESH_ANSWERS)[number];

type ActionOf<K extends Action["kind"]> = Extract<Action, { readonly kind: K }>;

type Steps = { readonly [K in Action["kind"]]: (action: ActionOf<K>) => Promise<Answer> };

export type Action =
  | { readonly kind: "removeKey"; readonly id: string }
  | { readonly kind: "machine"; readonly name: string; readonly online: boolean; readonly shares: boolean }
  | { readonly kind: "refresh" }
  | { readonly kind: "probe" }
  | { readonly kind: "resolve"; readonly purpose: Purpose; readonly images: boolean }
  | { readonly kind: "ask"; readonly purpose: Purpose; readonly text: string; readonly maxTokens: number }
  | { readonly kind: "complete"; readonly purpose: Purpose }
  | { readonly kind: "reboot"; readonly tunnel: boolean }
  | { readonly kind: "enable"; readonly id: string; readonly enabled: 0 | 1 }
  | { readonly kind: "device"; readonly answer: DeviceAnswer }
  | { readonly kind: "poll"; readonly answer: PollAnswer }
  | { readonly kind: "refreshLogin"; readonly answer: RefreshAnswer };

export const aChoice: fc.Arbitrary<ModelChoice> = fc
  .constantFrom(...Object.entries(MODELS).flatMap(([provider, ids]) => ids.map((modelId) => ({ provider, modelId }))))
  .chain((pick) => fc.constantFrom("off", "minimal", "low", "medium", "high", "xhigh", "max" as const).map((thinkingLevel) => ({ ...pick, thinkingLevel })));

const base64url = (value: Json) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const jwt = (claims: { readonly [key: string]: Json }) => `${base64url({ alg: "none" })}.${base64url(claims)}.sig`;

const ID_TOKEN = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });

const ACCESS_TOKEN = jwt({ exp: 1_800_000_000 });

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
  /** The ChatGPT sign-in's access token in the Vault; null while signed out. Parity's actions never sign in. */
  chatgpt: string | null = null;
  reply: Reply = REPLIES.hi;
  changes = 0;
  models: Models;
  readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
    this.models = this.boot();
  }

  boot(): Models {
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
      chatgptToken: async () => (this.chatgpt === null ? null : { accessToken: this.chatgpt }),
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

    const models = new Models(storageOf(this.db), boundary, vault, machines, pipe, clockAt(() => this.clock.now()));

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
    return settle(() => this.#step(action.kind, action));
  }

  readonly #steps = {
    removeKey: async ({ id }) => {
      await this.models.removeKey(id);

      return {};
    },
    machine: async ({ name, online, shares }) => {
      this.machines.set(name, { online, shares });

      return null;
    },
    refresh: async () => {
      await this.models.refresh();

      return null;
    },
    probe: async () => {
      await this.models.probe();

      return null;
    },
    resolve: async ({ purpose, images }) => {
      const { choice, model } = this.models.resolve(purpose, images ? { images: true } : {});

      return { choice, model: shownModel(model) };
    },
    ask: async ({ purpose, text, maxTokens }) => {
      const messages: Message[] = [{ role: "user", content: text, timestamp: this.clock.now() }];

      return shownAnswer(await this.models.ask(purpose, "Be brief.", messages, { timeoutMs: 20_000, maxTokens }));
    },
    complete: async ({ purpose }) => this.models.complete(purpose, "Name this chat.", "hello"),
    reboot: async ({ tunnel }) => {
      this.tunnel = tunnel;
      this.models = this.boot();

      return null;
    },
    enable: async ({ id, enabled }) => {
      this.db.prepare("UPDATE ky_providers SET enabled = ? WHERE id = ?").run(enabled, id);

      return null;
    },
    device: async ({ answer }) => startDevice(this.#openai(() => deviceAnswer(answer))),
    poll: async ({ answer }) => pollDevice(this.#openai((path) => pollAnswer(answer, path)), DEVICE),
    refreshLogin: async ({ answer }) => refreshLogin(this.#openai(() => refreshAnswer(answer)), LOGIN)
  } satisfies Steps;

  #step<K extends Action["kind"]>(kind: K, action: ActionOf<K>): Promise<Answer> {
    const steps: Steps = this.#steps;

    return steps[kind](action);
  }

  tables(): Json {
    // SAFETY: both tables hold only text, integers and nulls.
    const rows = (query: string) => this.db.prepare(query).all().map((row) => ({ ...row }) as Json);

    return {
      ky_providers: rows("SELECT id, kind, vendor, machine, port, api, label, enabled FROM ky_providers ORDER BY rowid"),
      ky_purposes: rows("SELECT purpose, value FROM ky_purposes ORDER BY purpose")
    };
  }
}
