import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { Missing as NotSetUp } from "../avatars/contract";
import type { MachineHub } from "../machines/contract";
import type { RunnerPipe } from "../machines/wiring";
import type { Breaker, Now } from "./breaker";
import type { KeyVault, ModelsBoundary, ProviderKind, ProviderRecord } from "./contract";

/** One provider ky can call: what pi-ai sends through, what it offers, and whether it can be used now. */
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

/** What a source is handed when ky starts: the boundary, and the parts of ky it may read. */
export type SourceHost = {
  readonly boundary: ModelsBoundary;
  readonly vault: KeyVault;
  readonly machines: Pick<MachineHub, "machines" | "online">;
  readonly pipe: Pick<RunnerPipe, "fetcher">;
  readonly now: Now;
  /** Tell ky an endpoint's state moved, so Settings and the pickers look again. */
  readonly changed: () => void;
};

/** A source as ky runs it: the records it wants kept, and an endpoint for each. */
export type LiveSource = {
  /** Look again at what it depends on, before a refresh places its records. */
  readonly check?: () => Promise<void>;
  /** The records it puts in place from what ky sees now. Runs at start and on every refresh. */
  readonly place: () => readonly ProviderRecord[];
  /** A live endpoint for one of its records, or none when it can't make one now. */
  build(record: ProviderRecord): Endpoint | undefined;
};

/**
 * One way models reach ky. Each lives in its own file under sources/, and models.ts knows them only
 * through this: it never names one.
 */
export type Source = {
  /** The kind of record it builds. */
  readonly kind: ProviderKind;
  /** Where its endpoints sort, lowest first: the first featured model of the first connected one is the default. */
  readonly priority: number;
  /** Background work runs on its first model whenever it has an endpoint. */
  readonly background?: boolean;
  /** What Settings lists as not set up on this deploy, given the providers ky has. */
  readonly missing?: (boundary: ModelsBoundary, providers: readonly string[]) => readonly NotSetUp[];
  readonly start: (host: SourceHost) => LiveSource;
};
