import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
  TranscriptContext
} from "@earendil-works/pi-ai";
import { createModels, getSupportedThinkingLevels, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { MachineHub } from "../machines/contract";
import type { RunnerPipe } from "../machines/wiring";
import { type ModelChoice, type ModelOption, nearestLevel, type ProviderInfo, type Purpose, type SettingsView } from "../settings/contract";
import { Settings } from "../settings/wiring";
import { apiKey, apiKeyRecord, type Vendor, VENDORS } from "./sources/api-keys";
import type { Now } from "./breaker";
import {
  type AskLimits,
  CONTEXT_WINDOW,
  type KeyVault,
  KeyRefused,
  ModelFailed,
  type ModelsBoundary,
  type ModelNeed,
  NoKey,
  NoKeyToRemove,
  NoProvider,
  NoVendor,
  type ProviderKind,
  type ProviderRecord,
  SubscriptionToken,
  TestUnfinished
} from "./contract";
import type { Endpoint, LiveSource, Source } from "./endpoint";
import { Records } from "./records";
import { SOURCES } from "./sources";

const SHORT: AskLimits = { timeoutMs: 30_000, maxTokens: 2_000 };

const KEY_TEST: AskLimits = { timeoutMs: 20_000, maxTokens: 16 };

const NO_ENV = { env: async () => undefined, fileExists: async () => false };

const STAND_IN = Symbol("stand-in");

const BACKGROUND = Symbol("background");

type CallOptions = SimpleStreamOptions & { readonly [STAND_IN]?: true; readonly [BACKGROUND]?: true };

export type Resolved = { readonly choice: ModelChoice; readonly model: Model<Api> };

const BY_KIND: ReadonlyMap<ProviderKind, Source> = new Map(SOURCES.map((source) => [source.kind, source]));

const priority = (kind: ProviderKind): number => BY_KIND.get(kind)?.priority ?? Number.POSITIVE_INFINITY;

export class Host extends Context.Service<
  Host,
  {
    readonly storage: DurableObjectStorage;
    readonly boundary: ModelsBoundary;
    readonly vault: KeyVault;
    readonly machines: Pick<MachineHub, "machines" | "online">;
    readonly pipe: Pick<RunnerPipe, "fetcher">;
  }
>()("ky/providers/Host") {}

function made({ id, kind, vendor, machine, port, api }: ProviderRecord): string {
  return JSON.stringify([id, kind, vendor, machine, port, api]);
}

function choiceOf(endpoint: Endpoint, model: Model<Api>): ModelChoice {
  return { provider: endpoint.provider.id, modelId: model.id, thinkingLevel: nearestLevel(getSupportedThinkingLevels(model), endpoint.thinkingLevel) };
}

function cheapest(endpoints: readonly Endpoint[]): ModelChoice | undefined {
  const endpoint = endpoints.at(-1);
  const model = endpoint?.light ?? endpoint?.featured[0];

  return endpoint && model && choiceOf(endpoint, model);
}

function best(endpoints: readonly Endpoint[], need: ModelNeed = {}, except?: Model<Api>): ModelChoice | undefined {
  for (const endpoint of endpoints) {
    const model = endpoint.featured.find((each) => each !== except && (!need.images || each.input.includes("image")));

    if (model) return choiceOf(endpoint, model);
  }

  return undefined;
}

function compacting(provider: Provider): Provider {
  const cap = <M extends { readonly contextWindow: number }>(model: M): M => (model.contextWindow > CONTEXT_WINDOW ? { ...model, contextWindow: CONTEXT_WINDOW } : model);

  return {
    ...provider,
    getModels: () => provider.getModels().map(cap),
    getAllModels: () => (provider.getAllModels?.() ?? provider.getModels()).map((model) => ("contextWindow" in model ? cap(model) : model))
  };
}

function textOf(answer: AssistantMessage): string {
  return answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function option(model: Model<Api>, featured: boolean): ModelOption {
  const base: ModelOption = { modelId: model.id, name: model.name, featured, levels: getSupportedThinkingLevels(model), images: model.input.includes("image") };

  return model.cost.input > 0 ? { ...base, cost: { input: model.cost.input, output: model.cost.output } } : base;
}

function failed(model: Model<Api>, errorMessage: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage,
    timestamp
  };
}

const make = Effect.gen(function* () {
  const { storage, boundary, vault, machines, pipe } = yield* Host;
  const records = yield* Records;
  const clock = yield* Clock.Clock;
  const now: Now = () => clock.currentTimeMillisUnsafe();
  const listeners = new Set<() => void>();
  const answers = new Set<(purpose: Purpose, answer: AssistantMessage) => void>();
  const madeFrom = new WeakMap<Endpoint, string>();
  let endpoints: readonly Endpoint[] = [];

  const changed = () => {
    for (const listener of listeners) listener();
  };

  const valid = (choice: ModelChoice): ModelChoice | undefined => {
    const endpoint = endpoints.find((each) => each.provider.id === choice.provider && each.connected());
    const model = endpoint?.models.find((each) => each.id === choice.modelId);

    return model && { ...choice, thinkingLevel: nearestLevel(getSupportedThinkingLevels(model), choice.thinkingLevel) };
  };

  const settings = new Settings(storage, valid);
  const registry: MutableModels = createModels({ authContext: NO_ENV });

  const endpointFor = (provider: string): Endpoint => {
    const endpoint = endpoints.find((each) => each.provider.id === provider);

    if (!endpoint) throw new TypeError(`No provider "${provider}".`);

    return endpoint;
  };

  const modelFor = ({ provider, modelId }: ModelChoice): Model<Api> => {
    const model = endpointFor(provider).models.find((each) => each.id === modelId);

    if (!model) throw new TypeError(`No ${provider} model "${modelId}".`);

    return model;
  };

  const healthy = async (endpoint: Endpoint) => (await (endpoint.reachable?.() ?? true)) && endpoint.breaker.closed();

  const sources: ReadonlyMap<ProviderKind, LiveSource> = new Map(SOURCES.map((source) => [source.kind, source.start({ boundary, vault, machines, pipe, now, changed })]));

  const live = (record: ProviderRecord): Endpoint | undefined => sources.get(record.kind)?.build(record);

  const standIn = async (model: Model<Api>, options?: CallOptions): Promise<{ model: Model<Api>; options: CallOptions } | undefined> => {
    const others = endpoints.filter((endpoint) => endpoint.provider.id !== model.provider);
    const health = await Promise.all(others.map(healthy));
    const up = others.filter((_endpoint, index) => health[index]);
    const stored = settings.get("fallback");
    const fallback = stored && up.some((endpoint) => endpoint.provider.id === stored.provider) ? stored : best(up);
    const choice = options?.[BACKGROUND] ? cheapest(up) : fallback;

    if (!choice) return undefined;
    const stood = modelFor(choice);
    const { reasoning, apiKey: _apiKey, headers: _headers, ...rest } = options ?? {};
    const level = nearestLevel(getSupportedThinkingLevels(stood), reasoning ? choice.thinkingLevel : "off");
    const sent: CallOptions = { ...rest, [STAND_IN]: true };

    return { model: stood, options: level === "off" ? sent : { ...sent, reasoning: level } };
  };

  const routed = (endpoint: Endpoint): Provider => {
    const { provider } = endpoint;

    const streamSimple = (model: Model<Api>, context: TranscriptContext, options: CallOptions | undefined): AssistantMessageEventStream => {
      const out = createAssistantMessageEventStream();

      void (async () => {
        try {
          const stood = options?.[STAND_IN] || (await healthy(endpoint)) ? undefined : await standIn(model, options);

          if (stood) console.warn(`${endpoint.name} is down; this call runs on ${stood.model.name}.`);

          const inner = stood ? registry.streamSimple(stood.model, context, stood.options) : provider.streamSimple(model, context, options);

          for await (const event of inner) out.push(event);
          out.end(await inner.result());
        } catch (error) {
          out.push({ type: "error", reason: "error", error: failed(model, error instanceof Error ? error.message : String(error), now()) });
        }
      })();

      return out;
    };

    return { ...provider, streamSimple };
  };

  const load = Effect.gen(function* () {
    const before = endpoints;
    const listed = yield* records.list;

    endpoints = listed
      .filter((record) => record.enabled)
      .sort((a, b) => priority(a.kind) - priority(b.kind))
      .flatMap((record) => {
        const kept = before.find((endpoint) => madeFrom.get(endpoint) === made(record));

        if (kept) return [kept];
        const endpoint = live(record);

        if (endpoint) madeFrom.set(endpoint, made(record));

        return endpoint ?? [];
      });

    for (const gone of before) if (!endpoints.includes(gone)) registry.deleteProvider(gone.provider.id);

    for (const endpoint of endpoints) if (!before.includes(endpoint)) registry.setProvider(compacting(routed(endpoint)));
  });

  // Each source puts in place the records it wants from what ky sees now. Only a missing or moved one is written, as
  // an upsert, so a refresh that changes nothing writes nothing, and a record's enabled flag stays the user's.
  const place = Effect.gen(function* () {
    const stored = new Map((yield* records.list).map((record) => [record.id, made(record)]));
    const wanted = [...sources.values()].flatMap((source) => source.place());

    yield* Effect.forEach(
      wanted.filter((record) => stored.get(record.id) !== made(record)),
      (record) => records.add(record),
      { discard: true }
    );
  });

  const mainOf = (need: ModelNeed) =>
    Effect.suspend(() => {
      const connected = endpoints.filter((endpoint) => endpoint.connected());
      const choice = best(connected, need) ?? best(connected) ?? best(endpoints);

      return choice ? Effect.succeed(choice) : Effect.fail(new NoProvider());
    });

  const fallbackOf = (from: Model<Api>, need: ModelNeed) => {
    const connected = endpoints.filter((endpoint) => endpoint.connected());
    const up = connected.filter((endpoint) => endpoint.breaker.closed());
    const elsewhere = up.filter((endpoint) => endpoint.provider.id !== from.provider);

    return best(elsewhere, need) ?? best(up, need, from) ?? best(connected, {}, from);
  };

  const resolve = (purpose: Purpose, need: ModelNeed = {}): Effect.Effect<Resolved, NoProvider> =>
    Effect.gen(function* () {
      const choice = settings.get(purpose) ?? (yield* defaultOf(purpose, need));

      return { choice, model: yield* Effect.sync(() => modelFor(choice)) };
    });

  const backgroundOf = (need: ModelNeed) =>
    Effect.gen(function* () {
      const cheap = endpoints.find((endpoint) => BY_KIND.get(endpoint.kind)?.background);
      const first = cheap?.featured[0];
      const { choice, model } = cheap && first ? { choice: choiceOf(cheap, first), model: first } : yield* resolve("main", need);

      return { ...choice, thinkingLevel: nearestLevel(getSupportedThinkingLevels(model), "off") };
    });

  const defaultOf = (purpose: Purpose, need: ModelNeed): Effect.Effect<ModelChoice, NoProvider> => {
    switch (purpose) {
      case "main":
        return mainOf(need);
      case "worker":
        return Effect.map(resolve("main", need), (main) => main.choice);
      case "background":
        return backgroundOf(need);
      case "fallback":
        return Effect.map(resolve("main"), (main) => fallbackOf(main.model, need) ?? main.choice);
    }
  };

  const catalog = (): ProviderInfo[] =>
    endpoints.map((endpoint) => {
      const failure = endpoint.breaker.failure();

      const info: ProviderInfo = {
        id: endpoint.provider.id,
        kind: endpoint.kind,
        name: endpoint.name,
        connected: endpoint.connected(),
        needs: endpoint.needs,
        models: endpoint.models.map((model) => option(model, endpoint.featured.includes(model)))
      };

      return failure === undefined ? info : { ...info, failure };
    });

  const probe = Effect.promise(() => Promise.all(endpoints.flatMap((endpoint) => endpoint.reachable?.() ?? [])));

  const testCall = (vendor: Vendor, key: string) =>
    Effect.gen(function* () {
      const candidate = apiKey(vendor, boundary.fetch, async () => ({ apiKey: key }), now);
      const trial = createModels({ authContext: NO_ENV });
      const timestamp = yield* Clock.currentTimeMillis;
      const model = candidate.light ?? candidate.featured[0];

      if (!model) return yield* Effect.die(new TypeError(`${vendor.name} offers no model to test.`));
      trial.setProvider(candidate.provider);

      const answer = yield* Effect.promise(() =>
        trial.completeSimple(
          model,
          { messages: [{ role: "user", content: "Say hi.", timestamp }] },
          { maxTokens: KEY_TEST.maxTokens, signal: AbortSignal.timeout(KEY_TEST.timeoutMs) }
        )
      );

      if (answer.stopReason === "error") return yield* new KeyRefused({ vendor: vendor.name, reason: answer.errorMessage ?? "no reason given" });

      if (answer.stopReason !== "stop" && answer.stopReason !== "length") return yield* new TestUnfinished({ vendor: vendor.name, reason: answer.errorMessage ?? answer.stopReason });
    });

  const ask = (purpose: Purpose, system: string, messages: Message[], limits: AskLimits = SHORT) =>
    Effect.gen(function* () {
      const { choice, model } = yield* resolve(purpose);
      const options: CallOptions = { maxTokens: limits.maxTokens, ...(purpose === "background" && { [BACKGROUND]: true }) };

      if (choice.thinkingLevel !== "off") options.reasoning = choice.thinkingLevel;

      const answer = yield* Effect.promise(async () => {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), limits.timeoutMs);

        try {
          return await registry.completeSimple(model, { systemPrompt: system, messages }, { ...options, signal: timeout.signal });
        } finally {
          clearTimeout(timer);
        }
      });

      for (const listener of answers) listener(purpose, answer);

      if (answer.stopReason === "error") return yield* new ModelFailed({ message: answer.errorMessage ?? `The ${purpose} model failed.` });

      return answer;
    });

  yield* place;
  yield* load;

  return {
    settings,
    registry,
    valid,
    catalog,
    resolve,
    probe,
    ask,
    onChange: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    onAnswer: (listener: (purpose: Purpose, answer: AssistantMessage) => void) => {
      answers.add(listener);

      return () => answers.delete(listener);
    },
    choices: Effect.sync(() => {
      const featured = catalog().flatMap((provider) =>
        provider.connected ? provider.models.flatMap((model) => (model.featured ? [`${provider.id}/${model.modelId} (${model.levels.join(", ") || "off"})`] : [])) : []
      );

      return `Choose one of: ${featured.join("; ")}. Any other model those providers offer works too, by its id.`;
    }),
    view: Effect.gen(function* () {
      const purposes =
        endpoints.length === 0
          ? {}
          : {
              main: (yield* resolve("main")).choice,
              worker: (yield* resolve("worker")).choice,
              background: (yield* resolve("background")).choice,
              fallback: (yield* resolve("fallback")).choice
            };

      const keyed = new Set(endpoints.map((endpoint) => endpoint.provider.id));
      const vendors = VENDORS.flatMap((vendor) => (keyed.has(vendor.id) ? [] : [{ id: vendor.id, name: vendor.name }]));

      return { providers: catalog(), purposes, vendors } satisfies SettingsView;
    }),
    addKey: (vendorId: string, key: string) =>
      Effect.gen(function* () {
        const vendor = VENDORS.find((each) => each.id === vendorId);

        if (!vendor) return yield* new NoVendor({ vendorId });
        const trimmed = key.trim();

        if (!trimmed) return yield* new NoKey({ vendor: vendor.name });

        if (vendor.subscription?.(trimmed)) return yield* new SubscriptionToken();
        yield* testCall(vendor, trimmed);
        yield* Effect.promise(() => vault.put("provider", vendor.id, { apiKey: trimmed }));
        yield* records.add(apiKeyRecord(vendor));
        yield* load;
        changed();

        return {};
      }),
    removeKey: (providerId: string) =>
      Effect.gen(function* () {
        const record = (yield* records.list).find((each) => each.id === providerId);

        if (record?.kind !== "api-key") return yield* new NoKeyToRemove({ providerId });
        yield* Effect.promise(() => vault.remove("provider", providerId));
        yield* records.remove(providerId);
        yield* load;
        changed();

        return {};
      }),
    refresh: Effect.gen(function* () {
      const before = endpoints;

      yield* Effect.promise(() => Promise.all([...sources.values()].flatMap((source) => source.check?.() ?? [])));
      yield* place;
      yield* load;

      if (endpoints.some((endpoint) => !before.includes(endpoint))) changed();
      yield* probe;
    }),
    worker: (own?: ModelChoice | null) =>
      Effect.suspend(() => {
        const kept = own && valid(own);

        return kept ? Effect.succeed(kept) : Effect.map(resolve("worker"), (worker) => worker.choice);
      }),
    imageSupport: (purpose: Purpose) =>
      Effect.gen(function* () {
        const own = (yield* resolve(purpose, { images: true })).model;
        const endpoint = yield* Effect.sync(() => endpointFor(own.provider));
        const model = (yield* Effect.promise(() => healthy(endpoint))) ? own : ((yield* Effect.promise(() => standIn(own)))?.model ?? own);

        return model.input.includes("image") ? null : `${model.name} can't read images. Pick a model that can in Models, or send text only.`;
      }),
    complete: (purpose: Purpose, system: string, text: string) =>
      Effect.gen(function* () {
        const timestamp = yield* Clock.currentTimeMillis;

        return textOf(yield* ask(purpose, system, [{ role: "user", content: text, timestamp }]));
      })
  };
});

export class Providers extends Context.Service<Providers, Effect.Success<typeof make>>()("ky/providers/Providers") {
  static readonly layer = Layer.effect(Providers)(make).pipe(Layer.provide(Records.layer));
}
