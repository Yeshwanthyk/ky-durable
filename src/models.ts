import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  TranscriptContext
} from "@earendil-works/pi-ai";
import {
  createModels,
  getSupportedThinkingLevels,
  type MutableModels,
  type Provider
} from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { type ModelOption, type ProviderInfo, Settings, type Slot, type SlotSetting } from "./settings";
import type { NotSetUp } from "./setup";
import { VIBEPROXY_PROVIDER } from "./vibeproxy";

/**
 * Which model does what. This owns the catalog of providers, the four slots
 * (kept by Settings), `resolve(slot)`, the stand-in when a provider is
 * unreachable, and whether a slot's model reads images.
 *
 * A provider that can go away (Claude on the user's Mac) has a probe. A turn
 * on such a provider asks the probe once when it starts, then streams from
 * exactly one provider: that one when it answers, else the fallback slot's.
 */

/** The model the main agent uses on Claude. */
export const CLAUDE_MODEL = "claude-opus-5-5";

/** Small and quick: names chats and tasks. */
export const CLAUDE_SMALL = "claude-haiku-4-5";

/** The one OpenCode Go model the catalog offers: subagents, and the main agent while Claude is away. */
const OPENCODE_MODEL = "deepseek-v4.1-flash";

/** The context window pi's harness is told for every model; see `compacting`. */
export const CONTEXT_WINDOW = 136_000;

/** How long `ask` waits, and how many tokens the answer may take. */
export type AskLimits = { readonly timeoutMs: number; readonly maxTokens: number };

/** Room for a model that cannot stop thinking to think, then answer. */
const SHORT: AskLimits = { timeoutMs: 30_000, maxTokens: 2_000 };

/** A pi provider plus what the catalog shows about it. */
export type Endpoint = {
  readonly provider: Provider;
  /** The name the Models settings show. */
  readonly name: string;
  /** What connects it, when it is not. */
  readonly needs: string;
  /** The deploy has what it needs, its key or its binding; Settings shows it as not set up when not. */
  readonly setUp: boolean;
  /** The models offered in the catalog. */
  readonly models: readonly Model<Api>[];
  /** It took requests when last checked; never waits. */
  readonly connected: () => boolean;
  /** Ask it now (or reuse a fresh answer). Providers with a probe fall back to the fallback slot when it says no. */
  readonly reachable?: () => Promise<boolean>;
  /** The secret pi resolves this provider's key from, by name. */
  readonly apiKey?: { readonly name: string; readonly value: string | undefined };
};

/** What a slot runs on right now. */
export type Resolved = {
  readonly provider: Provider;
  readonly model: Model<Api>;
  readonly thinkingLevel: ModelThinkingLevel;
  /** The key to send with a direct request, when the provider takes one. */
  readonly apiKey: string | undefined;
  /** The slot's provider is unreachable, so this is the fallback slot's model. */
  readonly fellBack: boolean;
};

/**
 * OpenCode Go in the cloud, always on while its key is set. The catalog offers one model of it. It is in
 * the catalog even without its key, since the slot defaults end on it.
 */
export function opencodeGo(key: string | undefined): Endpoint {
  const provider = opencodeGoProvider();
  const model = provider.getModels().find((each) => each.id === OPENCODE_MODEL);

  if (!model) throw new TypeError(`No OpenCode Go model "${OPENCODE_MODEL}" in pi-ai's catalog.`);

  return {
    provider,
    name: "OpenCode Go",
    needs: "the OPENCODE_API_KEY secret",
    setUp: Boolean(key),
    models: [model],
    connected: () => Boolean(key),
    apiKey: { name: "OPENCODE_API_KEY", value: key }
  };
}

/**
 * ky's slot defaults: Claude while VibeProxy answers, else the cheap cloud
 * model. Each slot lists its choices in order; the first whose provider is
 * connected wins, and the last is used when none is.
 */
export function kyDefaults(cheap: { readonly provider: string; readonly modelId: string }): Record<
  Slot,
  readonly SlotSetting[]
> {
  const high: SlotSetting = { ...cheap, thinkingLevel: "high" };

  return {
    main: [{ provider: VIBEPROXY_PROVIDER, modelId: CLAUDE_MODEL, thinkingLevel: "medium" }, high],
    subagents: [high],
    fallback: [high],
    titles: [
      { provider: VIBEPROXY_PROVIDER, modelId: CLAUDE_SMALL, thinkingLevel: "off" },
      { ...high, thinkingLevel: "off" }
    ]
  };
}

export class Models {
  readonly settings: Settings;
  readonly #endpoints: readonly Endpoint[];
  readonly #notSetUp: readonly NotSetUp[];
  readonly #defaults: Readonly<Record<Slot, readonly SlotSetting[]>>;

  constructor(
    sql: SqlStorage,
    endpoints: readonly Endpoint[],
    notSetUp: readonly NotSetUp[],
    defaults: Readonly<Record<Slot, readonly SlotSetting[]>>
  ) {
    this.#endpoints = endpoints;
    this.#notSetUp = notSetUp;
    this.#defaults = defaults;
    this.settings = new Settings(
      sql,
      () => this.catalog(),
      () => this.#defaultSettings()
    );
  }

  catalog(): ProviderInfo[] {
    return [
      ...this.#endpoints.map((endpoint) => ({
        id: endpoint.provider.id,
        name: endpoint.name,
        setUp: endpoint.setUp,
        connected: endpoint.connected(),
        needs: endpoint.needs,
        models: endpoint.models.map(option)
      })),
      ...this.#notSetUp.map((each) => ({ ...each, setUp: false, connected: false, models: [] }))
    ];
  }

  model(provider: string, modelId: string): Model<Api> {
    const model = this.#endpoint(provider).provider.getModels().find((each) => each.id === modelId);

    if (!model) throw new TypeError(`No ${provider} model "${modelId}" in pi-ai's catalog.`);

    return model;
  }

  /**
   * The provider, model and thinking level a slot runs on now. A slot whose
   * provider does not answer gets the fallback slot's model; the titles slot
   * keeps its own light thinking there, so names stay quick.
   */
  async resolve(slot: Slot): Promise<Resolved> {
    const own = this.settings.get(slot);
    const reachable = this.#endpoint(own.provider).reachable;

    if (slot === "fallback" || !reachable || (await reachable())) return this.#resolved(own, own.thinkingLevel, false);

    const standIn = this.settings.get("fallback");

    return this.#resolved(standIn, slot === "titles" ? own.thinkingLevel : standIn.thinkingLevel, true);
  }

  /** Why the model a slot runs on now can't read images, or null when it can. */
  async imageSupport(slot: Slot): Promise<string | null> {
    const { model } = await this.resolve(slot);

    if (model.input.includes("image")) return null;

    return `${model.name} can't read images. Pick a model that can in Models, or send text only.`;
  }

  /** One short answer from a slot's model. */
  async complete(slot: Slot, system: string, text: string): Promise<string> {
    const answer = await this.ask(slot, system, [{ role: "user", content: text, timestamp: Date.now() }]);

    return textOf(answer);
  }

  /** A slot's model's next message after `messages`, outside any conversation; it throws when the model fails. */
  async ask(slot: Slot, system: string, messages: Message[], limits: AskLimits = SHORT): Promise<AssistantMessage> {
    const { provider, model, thinkingLevel, apiKey } = await this.resolve(slot);
    // Cleared once the model answers: a timer still pending keeps the object from stopping until it fires.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), limits.timeoutMs);

    const options: SimpleStreamOptions = {
      maxTokens: limits.maxTokens,
      // OpenCode Go routes by session and refuses requests without one.
      sessionId: `ky-${slot}`,
      signal: timeout.signal
    };

    if (thinkingLevel !== "off") options.reasoning = thinkingLevel;

    if (apiKey) options.apiKey = apiKey;

    const context = normalizeContext({ systemPrompt: system, messages });

    let answer: AssistantMessage;

    try {
      answer = await provider.streamSimple(model, context, options).result();
    } finally {
      clearTimeout(timer);
    }

    if (answer.stopReason === "error") throw new Error(answer.errorMessage ?? `The ${slot} model failed.`);

    return answer;
  }

  /** pi's model registry for the harness. A provider with a probe falls back per turn. */
  registry(): MutableModels {
    const registry = createModels({
      authContext: {
        env: async (name) => this.#endpoints.find((each) => each.apiKey?.name === name)?.apiKey?.value || undefined,
        fileExists: async () => false
      }
    });

    for (const endpoint of this.#endpoints) registry.setProvider(compacting(this.#routed(endpoint)));

    return registry;
  }

  #endpoint(provider: string): Endpoint {
    const endpoint = this.#endpoints.find((each) => each.provider.id === provider);

    if (!endpoint) throw new TypeError(`No provider "${provider}".`);

    return endpoint;
  }

  #resolved(setting: SlotSetting, wanted: ModelThinkingLevel, fellBack: boolean): Resolved {
    const endpoint = this.#endpoint(setting.provider);
    const model = this.model(setting.provider, setting.modelId);
    const levels = getSupportedThinkingLevels(model);

    return {
      provider: endpoint.provider,
      model,
      // A level the model lacks becomes its lightest.
      thinkingLevel: levels.includes(wanted) ? wanted : (levels[0] ?? "off"),
      apiKey: endpoint.apiKey?.value || undefined,
      fellBack
    };
  }

  #defaultSettings(): Record<Slot, SlotSetting> {
    const connected = new Set(this.catalog().flatMap((each) => (each.connected ? [each.id] : [])));

    const pick = (choices: readonly SlotSetting[]) =>
      choices.find((each) => connected.has(each.provider)) ?? choices.at(-1)!;

    return {
      main: pick(this.#defaults.main),
      subagents: pick(this.#defaults.subagents),
      fallback: pick(this.#defaults.fallback),
      titles: pick(this.#defaults.titles)
    };
  }

  /** The provider pi streams through: as is, or asking its probe once per turn and standing in when it says no. */
  #routed(endpoint: Endpoint): Provider {
    const { provider, reachable } = endpoint;

    if (!reachable) return provider;

    const streamSimple = (
      model: Model<Api>,
      context: TranscriptContext,
      options: SimpleStreamOptions | undefined
    ): AssistantMessageEventStream => {
      const out = createAssistantMessageEventStream();

      void (async () => {
        try {
          const up = await reachable();

          if (!up) console.warn(`${endpoint.name} is unreachable; this turn runs on the fallback model.`);

          const inner = up ? provider.streamSimple(model, context, options) : this.#standIn(context, options);

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

  /** The fallback slot's model streams the turn, with its own thinking level and key. */
  #standIn(context: TranscriptContext, options: SimpleStreamOptions | undefined): AssistantMessageEventStream {
    const setting = this.settings.get("fallback");
    const { provider, model, thinkingLevel, apiKey } = this.#resolved(setting, setting.thinkingLevel, true);
    const { reasoning: _reasoning, apiKey: _apiKey, ...rest } = options ?? {};
    const standIn: SimpleStreamOptions = { ...rest };

    if (thinkingLevel !== "off") standIn.reasoning = thinkingLevel;

    if (apiKey) standIn.apiKey = apiKey;

    return provider.streamSimple(model, context, standIn);
  }
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
