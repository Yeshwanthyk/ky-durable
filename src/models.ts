import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  FetchFunction,
  Message,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  TranscriptContext
} from "@earendil-works/pi-ai";
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import {
  createModels,
  getSupportedThinkingLevels,
  type MutableModels,
  type Provider
} from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentChange } from "@earendil-works/pi-durable";
import { apiKey, apiKeyRecord, type ProviderKey, type Vendor, VENDORS } from "./providers/api-key";
import type { Breaker } from "./providers/breaker";
import { type ProviderKind, type ProviderRecord, ProviderRecords } from "./providers/records";
import { type VibeProxyConfig, VIBEPROXY_PROVIDER, vibeProxy, vibeProxyRecord } from "./providers/vibeproxy";
import { WORKERS_AI, WORKERS_AI_RECORD, workersAI } from "./providers/workers-ai";
import {
  type ModelChoice,
  type ModelOption,
  nearestLevel,
  type ProviderInfo,
  type Purpose,
  Settings,
  type SettingsView
} from "./settings";

/**
 * Which model does what (C5). This owns the providers this deploy has (their
 * records, and each made live by its module in providers/), the one pi
 * registry every call goes through, the user's choice per purpose (kept by
 * Settings), and `resolve(purpose, need)`, the only way a model is picked.
 *
 * A provider is healthy while it is connected (VibeProxy's probe answers)
 * and its circuit breaker is closed. Each call asks once when it starts,
 * then streams from exactly one provider: the one asked for while it is
 * healthy, else a stand-in on another provider that is healthy now, else the
 * one asked for, so the call fails fast and pi's retry applies.
 */

/** The context window pi's harness is told for every model; see `compacting`. */
export const CONTEXT_WINDOW = 136_000;

/** How long `ask` waits, and how many tokens the answer may take. */
export type AskLimits = { readonly timeoutMs: number; readonly maxTokens: number };

/** Room for a model that cannot stop thinking to think, then answer. */
const SHORT: AskLimits = { timeoutMs: 30_000, maxTokens: 2_000 };

/** The call a new key must answer before it is saved. */
const KEY_TEST: AskLimits = { timeoutMs: 20_000, maxTokens: 16 };

/** Keys come from the Vault, never from the Worker's env or files. */
const NO_ENV = { env: async () => undefined, fileExists: async () => false };

/** A provider record made live: pi's provider, sending through its transport, and what the catalog shows about it. */
export type Endpoint = {
  readonly provider: Provider;
  readonly kind: ProviderKind;
  /** The name Settings shows. */
  readonly name: string;
  /** What connects it, when it is not. */
  readonly needs: string;
  /** The models offered; the first is the provider's default. */
  readonly models: readonly Model<Api>[];
  /** Its quick, cheap model for background work while it stands in; its default when unset. */
  readonly light?: Model<Api>;
  /** The thinking level its models run at by default. */
  readonly thinkingLevel: ModelThinkingLevel;
  /** Opens on a response that says the provider can't take requests now. */
  readonly breaker: Breaker;
  /** It took requests when last checked; never waits. */
  readonly connected: () => boolean;
  /** Ask it now (or reuse a fresh answer), for a provider that can go away. */
  readonly reachable?: () => Promise<boolean>;
};

/** What the models reach outside the Worker: production's in server.ts, the fakes' in src/tests/stack.ts. */
export type ModelsBoundary = {
  /** Workers AI, which every deploy has. */
  readonly ai: AiBinding;
  /** How api-key providers reach their vendors. */
  readonly fetch: FetchFunction;
  /** The tunnel to VibeProxy on a computer of the user's, when this deploy has one. */
  readonly vibeProxy?: Pick<VibeProxyConfig, "binding" | "origin" | "key">;
  /** How long a VibeProxy probe's answer is reused; vibeproxy.ts's default when unset. */
  readonly probeTtlMs?: number;
};

/** Where the api-key providers' keys are kept: the Vault, through its stub (vault.ts). */
export type KeyVault = {
  auth(providerId: string): Promise<ProviderKey | null>;
  put(kind: "provider", id: string, value: ProviderKey): Promise<void>;
  remove(kind: "provider", id: string): Promise<void>;
};

/** What a purpose may need of the model ky picks for it. A user's own choice stands even when it lacks them. */
export type Need = {
  readonly images?: boolean;
};

/** The options of a call sent to a stand-in, which streams where it was sent: re-routing it could bounce forever. */
const STAND_IN = Symbol("stand-in");

/** The options of a background call, whose stand-in is the cheapest healthy provider's light model. */
const BACKGROUND = Symbol("background");

type CallOptions = SimpleStreamOptions & { readonly [STAND_IN]?: true; readonly [BACKGROUND]?: true };

/** What a purpose runs on. */
export type Resolved = {
  readonly choice: ModelChoice;
  readonly model: Model<Api>;
};

/**
 * The order "best" follows when ky picks: a model on the user's own computer, then a vendor they pay with a key,
 * then Workers AI.
 */
const RANK: Readonly<Record<ProviderKind, number>> = { "runner-local": 0, "api-key": 1, "workers-ai": 2 };

/** A choice as a conversation's agent takes it. */
export function agentModel({ provider, modelId, thinkingLevel }: ModelChoice): AgentChange {
  return { model: { provider, modelId }, thinkingLevel };
}

export class Models {
  readonly settings: Settings;
  /** pi's registry, for the harness and for every call ky makes itself. */
  readonly registry: MutableModels;
  readonly #records: ProviderRecords;
  readonly #boundary: ModelsBoundary;
  readonly #vault: KeyVault;
  readonly #listeners = new Set<() => void>();
  #endpoints: readonly Endpoint[] = [];

  constructor(sql: SqlStorage, boundary: ModelsBoundary, vault: KeyVault) {
    this.#records = new ProviderRecords(sql);
    this.#boundary = boundary;
    this.#vault = vault;
    this.#records.add(WORKERS_AI_RECORD);

    if (boundary.vibeProxy) this.#records.add(vibeProxyRecord(boundary.vibeProxy.origin));

    this.settings = new Settings(sql, (choice) => this.valid(choice));
    this.registry = createModels({ authContext: NO_ENV });
    this.#load();
  }

  /** `listener` is called when the providers change: one that can go away comes or goes, or a key is saved or removed. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  catalog(): ProviderInfo[] {
    return this.#endpoints.map((endpoint) => {
      const failure = endpoint.breaker.failure();

      const info: ProviderInfo = {
        id: endpoint.provider.id,
        kind: endpoint.kind,
        name: endpoint.name,
        connected: endpoint.connected(),
        needs: endpoint.needs,
        models: endpoint.models.map(option)
      };

      return failure === undefined ? info : { ...info, failure };
    });
  }

  view(): SettingsView {
    // With no provider enabled no purpose resolves, and Settings says so.
    const purposes =
      this.#endpoints.length === 0
        ? {}
        : {
            main: this.resolve("main").choice,
            worker: this.resolve("worker").choice,
            background: this.resolve("background").choice,
            fallback: this.resolve("fallback").choice
          };

    const keyed = new Set(this.#endpoints.map((endpoint) => endpoint.provider.id));
    const vendors = VENDORS.flatMap((vendor) => (keyed.has(vendor.id) ? [] : [{ id: vendor.id, name: vendor.name }]));

    return { providers: this.catalog(), purposes, vendors };
  }

  /**
   * Save the user's API key for a vendor once a test call on its light model succeeds, so its models can be
   * chosen; why it was refused, when it was. The key goes to the Vault and nowhere else.
   */
  async addKey(vendorId: string, key: string): Promise<{ refused?: string }> {
    const vendor = VENDORS.find((each) => each.id === vendorId);

    if (!vendor) return { refused: `ky has no vendor "${vendorId}".` };
    const trimmed = key.trim();

    const refused = trimmed
      ? (vendor.refuse?.(trimmed) ?? (await this.#testCall(vendor, trimmed)))
      : `Paste your ${vendor.name} API key.`;

    if (refused) return { refused };

    await this.#vault.put("provider", vendor.id, { apiKey: trimmed });
    this.#records.add(apiKeyRecord(vendor));
    this.#load();
    this.#changed();

    return {};
  }

  /** Forget an api-key provider's key, and the provider with it; what ran on it moves to the next healthy one. */
  async removeKey(providerId: string): Promise<void> {
    const record = this.#records.list().find((each) => each.id === providerId);

    if (record?.kind !== "api-key") throw new Error(`${providerId} has no API key to remove.`);
    await this.#vault.remove("provider", providerId);
    this.#records.remove(providerId);
    this.#load();
    this.#changed();
  }

  /** Ask every provider that can go away now, or reuse a fresh answer. */
  async probe(): Promise<void> {
    await Promise.all(this.#endpoints.map((endpoint) => endpoint.reachable?.()));
  }

  /**
   * What a purpose runs on: the user's choice while its provider is connected, else the purpose's default.
   *
   * - main: the best connected model, with its provider's thinking level;
   * - worker: main's;
   * - background: Workers AI's default model (main's while its record is disabled), at its lowest thinking level;
   * - fallback: the best healthy model on another provider than main's, else the best that isn't main's model.
   *
   * A call whose provider is down when it starts runs on a stand-in on another provider that is healthy now: the
   * user's fallback, else the best there; a background call, the cheapest's light model (#standIn).
   *
   * A default meets `need` when a connected model does.
   */
  resolve(purpose: Purpose, need: Need = {}): Resolved {
    const choice = this.settings.get(purpose) ?? this.#default(purpose, need);

    return { choice, model: this.#model(choice) };
  }

  /** A task's own model while it can run, else the worker's: for specialists and automations. */
  worker(own?: ModelChoice | null): ModelChoice {
    return (own && this.valid(own)) ?? this.resolve("worker").choice;
  }

  /** The choice as it can run: a connected provider, a model it offers, its nearest level; undefined when it cannot. */
  valid(choice: ModelChoice): ModelChoice | undefined {
    const endpoint = this.#endpoints.find((each) => each.provider.id === choice.provider && each.connected());
    const model = endpoint?.models.find((each) => each.id === choice.modelId);

    if (!model) return undefined;

    return { ...choice, thinkingLevel: nearestLevel(getSupportedThinkingLevels(model), choice.thinkingLevel) };
  }

  /** Why the model a purpose runs on now, or its stand-in while its provider is down, can't read images; null when it can. */
  async imageSupport(purpose: Purpose): Promise<string | null> {
    const own = this.resolve(purpose, { images: true }).model;
    const model = (await this.#healthy(this.#endpoint(own.provider))) ? own : ((await this.#standIn(own))?.model ?? own);

    if (model.input.includes("image")) return null;

    return `${model.name} can't read images. Pick a model that can in Models, or send text only.`;
  }

  /** One short answer from a purpose's model. */
  async complete(purpose: Purpose, system: string, text: string): Promise<string> {
    const answer = await this.ask(purpose, system, [{ role: "user", content: text, timestamp: Date.now() }]);

    return textOf(answer);
  }

  /** A purpose's model's next message after `messages`, outside any conversation; it throws when the model fails. */
  async ask(purpose: Purpose, system: string, messages: Message[], limits: AskLimits = SHORT): Promise<AssistantMessage> {
    const { choice, model } = this.resolve(purpose);
    // Cleared once the model answers: a timer still pending keeps the object from stopping until it fires.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), limits.timeoutMs);
    const options: CallOptions = { maxTokens: limits.maxTokens, signal: timeout.signal, ...(purpose === "background" && { [BACKGROUND]: true }) };

    if (choice.thinkingLevel !== "off") options.reasoning = choice.thinkingLevel;

    let answer: AssistantMessage;

    try {
      answer = await this.registry.completeSimple(model, { systemPrompt: system, messages }, options);
    } finally {
      clearTimeout(timer);
    }

    if (answer.stopReason === "error") throw new Error(answer.errorMessage ?? `The ${purpose} model failed.`);

    return answer;
  }

  /** Why a call on `vendor`'s light model with `key` didn't prove the key, when it didn't. */
  async #testCall(vendor: Vendor, key: string): Promise<string | undefined> {
    // The test call goes through a registry of its own, so the key is resolved as every later call's will be.
    const candidate = apiKey(vendor, this.#boundary.fetch, async () => ({ apiKey: key }));
    const trial = createModels({ authContext: NO_ENV });
    trial.setProvider(candidate.provider);

    const answer = await trial.completeSimple(
      candidate.light ?? candidate.models[0]!,
      { messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }] },
      { maxTokens: KEY_TEST.maxTokens, signal: AbortSignal.timeout(KEY_TEST.timeoutMs) }
    );

    if (answer.stopReason === "error") return `${vendor.name} refused the key: ${answer.errorMessage ?? "no reason given"}`;

    // Only a finished answer proves the key; a timeout or an unfinished call saves nothing.
    return answer.stopReason === "stop" || answer.stopReason === "length"
      ? undefined
      : `${vendor.name} didn't finish the test call (${answer.errorMessage ?? answer.stopReason}). Try again.`;
  }

  /** Make each enabled record live, keeping the endpoints already live (and their breakers), and plug pi's registry to match. */
  #load(): void {
    const before = this.#endpoints;

    this.#endpoints = this.#records
      .list()
      .filter((record) => record.enabled)
      .sort((a, b) => RANK[a.kind] - RANK[b.kind])
      .flatMap((record) => before.find((endpoint) => endpoint.provider.id === record.id) ?? this.#live(record) ?? []);

    for (const gone of before) if (!this.#endpoints.includes(gone)) this.registry.deleteProvider(gone.provider.id);

    for (const endpoint of this.#endpoints) {
      if (!before.includes(endpoint)) this.registry.setProvider(compacting(this.#routed(endpoint)));
    }
  }

  /** A record's provider made live, when its transport is there now. */
  #live(record: ProviderRecord): Endpoint | undefined {
    const boundary = this.#boundary;

    switch (record.kind) {
      case "workers-ai":
        return workersAI(boundary.ai);
      case "api-key": {
        const vendor = VENDORS.find((each) => each.id === record.vendor);

        return vendor && apiKey(vendor, boundary.fetch, (id) => this.#vault.auth(id));
      }

      case "runner-local":
        // Node P reaches runner-local providers through their machine's runner; until then only VibeProxy's tunnel.
        return record.id === VIBEPROXY_PROVIDER && boundary.vibeProxy
          ? vibeProxy({ ...boundary.vibeProxy, probeTtlMs: boundary.probeTtlMs, onChange: () => this.#changed() })
          : undefined;
    }
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  #endpoint(provider: string): Endpoint {
    const endpoint = this.#endpoints.find((each) => each.provider.id === provider);

    if (!endpoint) throw new TypeError(`No provider "${provider}".`);

    return endpoint;
  }

  #model({ provider, modelId }: ModelChoice): Model<Api> {
    const model = this.#endpoint(provider).models.find((each) => each.id === modelId);

    if (!model) throw new TypeError(`No ${provider} model "${modelId}".`);

    return model;
  }

  /** Connected, and its breaker closed. Asks a provider that can go away afresh. */
  async #healthy(endpoint: Endpoint): Promise<boolean> {
    return (await (endpoint.reachable?.() ?? true)) && endpoint.breaker.closed();
  }

  #default(purpose: Purpose, need: Need): ModelChoice {
    switch (purpose) {
      case "main":
        return this.#main(need);
      case "worker":
        return this.resolve("main", need).choice;
      case "background":
        return this.#background(need);
      case "fallback": {
        const main = this.resolve("main");

        return this.#fallback(main.model, need) ?? main.choice;
      }
    }
  }

  /** The best connected model; with every provider away, the best that can go away and come back. */
  #main(need: Need): ModelChoice {
    const connected = this.#endpoints.filter((endpoint) => endpoint.connected());
    const choice = best(connected, need) ?? best(connected) ?? best(this.#endpoints);

    if (!choice) throw new Error("No model provider is enabled.");

    return choice;
  }

  /** Workers AI's default model, or main's while the Workers AI record is disabled, at its lowest thinking level. */
  #background(need: Need): ModelChoice {
    const workersAI = this.#endpoints.find((endpoint) => endpoint.provider.id === WORKERS_AI);
    const first = workersAI?.models[0];
    const { choice, model } = workersAI && first ? { choice: choiceOf(workersAI, first), model: first } : this.resolve("main", need);

    return { ...choice, thinkingLevel: nearestLevel(getSupportedThinkingLevels(model), "off") };
  }

  /** The best healthy model on another provider than `from`'s, else the best that isn't `from`. */
  #fallback(from: Model<Api>, need: Need = {}): ModelChoice | undefined {
    const connected = this.#endpoints.filter((endpoint) => endpoint.connected());
    const healthy = connected.filter((endpoint) => endpoint.breaker.closed());
    const elsewhere = healthy.filter((endpoint) => endpoint.provider.id !== from.provider);

    return best(elsewhere, need) ?? best(healthy, need, from) ?? best(connected, {}, from);
  }

  /**
   * What a call on `model`, whose provider is down, runs on instead, on another provider that is healthy now; none
   * when no other provider is. A background call takes the cheapest such provider's light model. Any other takes
   * the user's fallback while its provider is healthy, else the best model there.
   */
  async #standIn(model: Model<Api>, options?: CallOptions): Promise<{ model: Model<Api>; options: CallOptions } | undefined> {
    const others = this.#endpoints.filter((endpoint) => endpoint.provider.id !== model.provider);
    const health = await Promise.all(others.map((endpoint) => this.#healthy(endpoint)));
    const healthy = others.filter((_endpoint, index) => health[index]);
    const stored = this.settings.get("fallback");
    const fallback = stored && healthy.some((endpoint) => endpoint.provider.id === stored.provider) ? stored : best(healthy);
    const choice = options?.[BACKGROUND] ? cheapest(healthy) : fallback;

    if (!choice) return undefined;
    const standIn = this.#model(choice);

    // Auth is resolved again for the stand-in's provider. It thinks at its own level, or not at all when the call asked for none.
    const { reasoning, apiKey: _apiKey, headers: _headers, ...rest } = options ?? {};
    const level = nearestLevel(getSupportedThinkingLevels(standIn), reasoning ? choice.thinkingLevel : "off");

    const sent: CallOptions = { ...rest, [STAND_IN]: true };

    return { model: standIn, options: level === "off" ? sent : { ...sent, reasoning: level } };
  }

  /** The provider pi streams through: each call asks whether it is healthy, and runs on a stand-in when not. */
  #routed(endpoint: Endpoint): Provider {
    const { provider } = endpoint;

    const streamSimple = (
      model: Model<Api>,
      context: TranscriptContext,
      options: CallOptions | undefined
    ): AssistantMessageEventStream => {
      const out = createAssistantMessageEventStream();

      void (async () => {
        try {
          const standIn = options?.[STAND_IN] || (await this.#healthy(endpoint)) ? undefined : await this.#standIn(model, options);

          if (standIn) console.warn(`${endpoint.name} is down; this call runs on ${standIn.model.name}.`);

          const inner = standIn
            ? this.registry.streamSimple(standIn.model, context, standIn.options)
            : provider.streamSimple(model, context, options);

          for await (const event of inner) out.push(event);
          out.end(await inner.result());
        } catch (error) {
          out.push({ type: "error", reason: "error", error: failed(model, error instanceof Error ? error.message : String(error)) });
        }
      })();

      return out;
    };

    return { ...provider, streamSimple };
  }
}

/** The light model of the last of `endpoints`, which are ranked dearest first. */
function cheapest(endpoints: readonly Endpoint[]): ModelChoice | undefined {
  const endpoint = endpoints.at(-1);
  const model = endpoint?.light ?? endpoint?.models[0];

  return endpoint && model && choiceOf(endpoint, model);
}

/** The first model of `endpoints`, in order, that meets `need` and isn't `except`. */
function best(endpoints: readonly Endpoint[], need: Need = {}, except?: Model<Api>): ModelChoice | undefined {
  for (const endpoint of endpoints) {
    const model = endpoint.models.find((each) => each !== except && (!need.images || each.input.includes("image")));

    if (model) return choiceOf(endpoint, model);
  }

  return undefined;
}

function choiceOf(endpoint: Endpoint, model: Model<Api>): ModelChoice {
  return {
    provider: endpoint.provider.id,
    modelId: model.id,
    thinkingLevel: nearestLevel(getSupportedThinkingLevels(model), endpoint.thinkingLevel)
  };
}

/**
 * The provider as pi's harness sees it, with every context window capped at
 * CONTEXT_WINDOW. pi reads the window only to decide when to compact, so a
 * 1M-token model compacts in the background from about 87k tokens and before
 * a turn from about 120k, with pi's default reserve, instead of near 1M.
 */
function compacting(provider: Provider): Provider {
  const cap = <M extends { readonly contextWindow: number }>(model: M): M =>
    model.contextWindow > CONTEXT_WINDOW ? { ...model, contextWindow: CONTEXT_WINDOW } : model;

  return {
    ...provider,
    getModels: () => provider.getModels().map(cap),
    // pi-ai's Models reads this list when a provider has one; image models have no window to cap.
    getAllModels: () =>
      (provider.getAllModels?.() ?? provider.getModels()).map((model) => ("contextWindow" in model ? cap(model) : model))
  };
}

function textOf(answer: AssistantMessage): string {
  return answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function option(model: Model<Api>): ModelOption {
  const base: ModelOption = {
    modelId: model.id,
    name: model.name,
    levels: getSupportedThinkingLevels(model),
    images: model.input.includes("image")
  };

  return model.cost.input > 0 ? { ...base, cost: { input: model.cost.input, output: model.cost.output } } : base;
}

function failed(model: Model<Api>, errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now()
  };
}
