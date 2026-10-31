import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Edge, makeEdge, type Refusable, runOrThrow } from "../core/edge";
import { isRefusal } from "../core/refusal";
import { Sql } from "../core/sql";
import type { MachineHub } from "../machines/contract";
import type { RunnerPipe } from "../machines/wiring";
import type { ModelChoice, ProviderInfo, Purpose, SettingsView } from "../settings/contract";
import type { Settings } from "../settings/wiring";
import * as ChatGpt from "./chatgpt";
import type { AskLimits, ChatGptLogin, Device, Fetch, KeyVault, ModelsBoundary, ModelNeed } from "./contract";
import { Host, Providers, type Resolved } from "./models";

export { notSetUp } from "./sources";

export { vibeProxyFrom } from "./sources/vibeproxy";

type Service = Providers["Service"];

async function answered<A, E extends Refusable, R>(edge: Edge<R>, effect: Effect.Effect<A, E, R>): Promise<A> {
  const result = await edge.runPromise(Effect.map(effect, (value) => ({ value })));

  if (isRefusal(result)) throw new Error(result.refused);

  return result.value;
}

async function once<A, E extends Refusable>(effect: Effect.Effect<A, E>): Promise<A> {
  const edge = makeEdge(Layer.empty);

  try {
    return await answered(edge, effect);
  } finally {
    await edge.dispose();
  }
}

export function startDevice(fetch: Fetch): Promise<Device> {
  return once(ChatGpt.begin(fetch));
}

export function pollDevice(fetch: Fetch, device: Device): Promise<ChatGptLogin | "pending"> {
  return once(ChatGpt.poll(fetch, device));
}

export function refreshLogin(fetch: Fetch, current: ChatGptLogin): Promise<ChatGptLogin> {
  return once(ChatGpt.renew(fetch, current));
}

type Picker = {
  choices(): string;
  valid(choice: ModelChoice): ModelChoice | undefined;
};

export class Models implements Picker {
  readonly settings: Settings;
  readonly registry: MutableModels;
  readonly #edge: Edge<Providers>;
  readonly #providers: Service;

  constructor(
    storage: DurableObjectStorage,
    boundary: ModelsBoundary,
    vault: KeyVault,
    machines: Pick<MachineHub, "machines" | "online">,
    pipe: Pick<RunnerPipe, "fetcher">,
    clock?: Clock.Clock
  ) {
    const host = Layer.succeed(Host)({ storage, boundary, vault, machines, pipe });
    const layer = Providers.layer.pipe(Layer.provide(Layer.mergeAll(host, Sql.layer(storage))));

    this.#edge = makeEdge(clock ? layer.pipe(Layer.provide(Layer.succeed(Clock.Clock)(clock))) : layer);
    this.#providers = this.#edge.run(Providers.use(Effect.succeed));
    this.settings = this.#providers.settings;
    this.registry = this.#providers.registry;
  }

  onChange(listener: () => void): () => void {
    return this.#providers.onChange(listener);
  }

  /** Each answer a direct ask gets, by the purpose that asked; pi's turns are counted by their own hook. */
  onAnswer(listener: (purpose: Purpose, answer: AssistantMessage) => void): () => void {
    return this.#providers.onAnswer(listener);
  }

  choices(): string {
    return this.#edge.run(this.#providers.choices);
  }

  catalog(): ProviderInfo[] {
    return this.#providers.catalog();
  }

  view(): SettingsView {
    return runOrThrow(this.#edge, this.#providers.view);
  }

  addKey(vendorId: string, key: string): Promise<{ refused?: string }> {
    return this.#edge.runPromise(this.#providers.addKey(vendorId, key));
  }

  async removeKey(providerId: string): Promise<void> {
    await answered(this.#edge, this.#providers.removeKey(providerId));
  }

  refresh(): Promise<void> {
    return this.#edge.runPromise(this.#providers.refresh);
  }

  async probe(): Promise<void> {
    await this.#edge.runPromise(this.#providers.probe);
  }

  resolve(purpose: Purpose, need: ModelNeed = {}): Resolved {
    return runOrThrow(this.#edge, this.#providers.resolve(purpose, need));
  }

  worker(own?: ModelChoice | null): ModelChoice {
    return runOrThrow(this.#edge, this.#providers.worker(own));
  }

  valid(choice: ModelChoice): ModelChoice | undefined {
    return this.#providers.valid(choice);
  }

  imageSupport(purpose: Purpose): Promise<string | null> {
    return answered(this.#edge, this.#providers.imageSupport(purpose));
  }

  complete(purpose: Purpose, system: string, text: string): Promise<string> {
    return answered(this.#edge, this.#providers.complete(purpose, system, text));
  }

  ask(purpose: Purpose, system: string, messages: Message[], limits?: AskLimits): Promise<AssistantMessage> {
    return answered(this.#edge, this.#providers.ask(purpose, system, messages, limits));
  }
}
