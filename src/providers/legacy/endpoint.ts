import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { Breaker } from "./breaker";
import type { ProviderKind } from "./records";

/** A provider record made live: pi's provider, sending through its transport, and what the catalog shows about it. */
export type Endpoint = {
  readonly provider: Provider;
  readonly kind: ProviderKind;
  /** The name Settings shows. */
  readonly name: string;
  /** What connects it, when it is not. */
  readonly needs: string;
  /** Every model offered, the featured ones first; any of them can be chosen. */
  readonly models: readonly Model<Api>[];
  /** The models shown up front and picked by default; the first is the provider's default. */
  readonly featured: readonly Model<Api>[];
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
