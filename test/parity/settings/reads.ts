import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type Choice = {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: ModelThinkingLevel;
};

export type Nearest = (levels: readonly ModelThinkingLevel[], wanted: ModelThinkingLevel) => ModelThinkingLevel;

export const PURPOSES = ["main", "worker", "background", "fallback"] as const;

export type PurposeName = (typeof PURPOSES)[number];

export const CATALOG = new Map<string, ReadonlyMap<string, readonly ModelThinkingLevel[]>>([
  [
    "workers-ai",
    new Map([
      ["glm", []],
      ["gpt-oss", ["low", "medium", "high"]],
      ["kimi", ["off", "high"]]
    ])
  ],
  [
    "vibeproxy",
    new Map([
      ["claude-opus-5-5", ["off", "low", "medium", "high", "xhigh", "max"]],
      ["claude-haiku-5-5", ["off", "minimal"]]
    ])
  ]
]);

export function levelsOf(choice: Pick<Choice, "provider" | "modelId">, connected: ReadonlySet<string>): readonly ModelThinkingLevel[] | undefined {
  return connected.has(choice.provider) ? CATALOG.get(choice.provider)?.get(choice.modelId) : undefined;
}

export function validOf(nearest: Nearest, connected: ReadonlySet<string>) {
  return (choice: Choice): Choice | undefined => {
    const levels = levelsOf(choice, connected);

    return (
      levels && {
        ...choice,
        thinkingLevel: nearest(levels, choice.thinkingLevel)
      }
    );
  };
}

const CONNECTIONS: ReadonlyArray<ReadonlySet<string>> = [new Set(["workers-ai", "vibeproxy"]), new Set(["workers-ai"]), new Set()];

export function readsOf(get: (connected: ReadonlySet<string>, purpose: PurposeName) => Choice | undefined) {
  return CONNECTIONS.map((connected) => ({
    connected: [...connected],
    purposes: Object.fromEntries(PURPOSES.map((purpose) => [purpose, get(connected, purpose) ?? null]))
  }));
}
