import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type Message,
  type ModelThinkingLevel
} from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { CLAUDE_MODEL, CLAUDE_SMALL, kyDefaults, Models } from "../models";
import { preamble } from "../prompt";
import type { ProviderInfo, Slot, SlotSetting } from "../settings";
import { Titler } from "../titles";
import { vibeProxy } from "../vibeproxy";

/** What the faux cloud model was asked. */
export type FauxCall = { model: string; reasoning: string | null; system: string };

const MAC_UP_KEY = "test:mac-up";

function textOf(content: Message["content"] | undefined): string {
  if (content === undefined) return "";

  if (!Array.isArray(content)) return content;

  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * ky's model wiring as server.ts composes it: Claude through vibeProxy over
 * the env's VIBEPROXY binding, and a faux cloud model where OpenCode Go
 * stands. VIBEPROXY refuses connections (the Mac is away); `mac(true)`
 * switches this object to VIBEPROXY_UP, a fake VibeProxy that answers.
 */
export class ModelsTestObject extends DurableObject<Cloudflare.Env> {
  readonly #calls: FauxCall[] = [];
  readonly #faux = fauxProvider({
    provider: "cloud",
    models: [
      { id: "cloud-think", name: "Cloud Think", reasoning: true, input: ["text", "image"] },
      { id: "cloud-text", name: "Cloud Text", input: ["text"] }
    ],
    tokensPerSecond: 1_000
  });
  /** Claude, with a probe that is never reused, so a test sees the Mac leave at once. */
  readonly claude = vibeProxy({
    binding: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const up = (await this.ctx.storage.get<boolean>(MAC_UP_KEY)) === true;

        return (up ? this.env.VIBEPROXY_UP : this.env.VIBEPROXY).fetch(input, init);
      }
    },
    origin: this.env.VIBEPROXY_ORIGIN,
    key: this.env.VIBEPROXY_KEY,
    modelIds: [CLAUDE_MODEL, CLAUDE_SMALL],
    probeTtlMs: 0
  });
  readonly models = new Models(
    this.ctx.storage.sql,
    [
      this.claude,
      {
        provider: this.#faux.provider,
        name: "Cloud",
        needs: "nothing",
        models: this.#faux.models,
        connected: () => true
      }
    ],
    kyDefaults({ provider: "cloud", modelId: "cloud-think" })
  );
  readonly titler = new Titler((system, text) => this.models.complete("titles", system, text));
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install({
        name: "ky",
        sections: [
          {
            key: "preamble",
            render: () => preamble({ repo: this.env.KY_REPO, workCopy: this.env.KY_WORK_COPY, url: this.env.KY_URL }),
            tag: false
          }
        ]
      });

      return Harness.open(
        storage,
        {
          models: this.models.registry(),
          registry: this.registry,
          settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    // A conversation already on Claude, as the main one is when the Mac goes away.
    defaults: { model: this.models.model("vibeproxy", CLAUDE_MODEL), thinkingLevel: "medium" }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#faux.setResponses(
      Array.from({ length: 50 }, () => (context, options, _state, model) => {
        const last = context.messages.filter((each) => each.role === "user").at(-1);
        const text = last ? textOf(last.content) : "";
        this.#calls.push({ model: model.id, reasoning: options?.reasoning ?? null, system: JSON.stringify(context.messages.filter((each) => each.role === "system")) });

        return text.includes("fail")
          ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "cloud failed" })
          : fauxAssistantMessage([fauxText(`cloud ${model.id}: ${text}`)]);
      })
    );
  }

  /** Bring the Mac's VibeProxy up or take it away, and probe it, as PiAgent does on start. */
  async mac(up: boolean): Promise<void> {
    await this.ctx.storage.put(MAC_UP_KEY, up);
    await this.claude.reachable();
  }

  /** The Mac goes away and nothing has probed it since: the catalog still shows Claude connected. */
  async macLeaves(): Promise<void> {
    await this.ctx.storage.put(MAC_UP_KEY, false);
  }

  async resolve(slot: Slot): Promise<{ provider: string; modelId: string; thinkingLevel: ModelThinkingLevel; fellBack: boolean }> {
    const { provider, model, thinkingLevel, fellBack } = await this.models.resolve(slot);

    return { provider: provider.id, modelId: model.id, thinkingLevel, fellBack };
  }

  /** Store a slot choice; the stored setting, or why it was refused. */
  set(slot: Slot, setting: SlotSetting): SlotSetting | string {
    try {
      return this.models.settings.set(slot, setting);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** The provider list the Models settings show. */
  catalog(): ProviderInfo[] {
    return this.models.catalog();
  }

  imageSupport(slot: Slot): Promise<string | null> {
    return this.models.imageSupport(slot);
  }

  title(text: string): Promise<string | null> {
    return this.titler.title(text);
  }

  /** One main-agent turn; its reply. */
  async prompt(text: string): Promise<string> {
    return (await this.harness.prompt(text)).text ?? "";
  }

  calls(): FauxCall[] {
    return this.#calls;
  }
}
