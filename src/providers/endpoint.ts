import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { Breaker } from "./breaker";
import type { ProviderKind } from "./contract";

export type Endpoint = {
  readonly provider: Provider;
  readonly kind: ProviderKind;
  readonly name: string;
  readonly needs: string;
  readonly models: readonly Model<Api>[];
  readonly featured: readonly Model<Api>[];
  readonly light?: Model<Api>;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly breaker: Breaker;
  readonly connected: () => boolean;
  readonly reachable?: () => Promise<boolean>;
};
