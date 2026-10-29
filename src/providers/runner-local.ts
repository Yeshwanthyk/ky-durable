import type { Api, FetchFunction, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { Endpoint } from "./endpoint";
import { type Offer, offered } from "./offer";
import { Breaker, type Now } from "./breaker";
import { sending } from "./transport";

export type LocalApi = "anthropic-messages" | "openai-completions";

const APIS: Readonly<Record<LocalApi, { paths: ReadonlySet<string>; probe: (key: string) => Record<string, string>; api: () => ReturnType<typeof anthropicMessagesApi> }>> = {
  "anthropic-messages": {
    paths: new Set(["/v1/messages", "/v1/models"]),
    probe: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    api: anthropicMessagesApi
  },
  "openai-completions": {
    paths: new Set(["/v1/chat/completions", "/v1/models"]),
    probe: (key) => ({ authorization: `Bearer ${key}` }),
    api: openAICompletionsApi
  }
};

const PROBE_TIMEOUT_MS = 3_000;

const PROBE_TTL_MS = 30_000;

export type RunnerLocalConfig = {
  readonly id: string;
  readonly name: string;
  readonly needs: string;
  readonly api: LocalApi;
  readonly origin: string;
  readonly catalog: readonly Model<Api>[];
  readonly offer: Offer;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly key: string;
  readonly transport: FetchFunction;
  readonly online: () => boolean;
  readonly onChange?: (up: boolean) => void;
  readonly probeTtlMs?: number;
  readonly now: Now;
};

export function runnerLocal(config: RunnerLocalConfig): Endpoint {
  const origin = new URL(config.origin).origin;
  const { paths, probe: probeHeaders, api } = APIS[config.api];

  const { models, featured, light } = offered(
    config.catalog.map((model) => ({ ...model, provider: config.id, baseUrl: origin })),
    config.offer
  );

  const breaker = new Breaker(config.name, config.now);

  const allowed =
    (fetch: FetchFunction): FetchFunction =>
    async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.origin !== origin || !paths.has(url.pathname)) {
        return new Response(`ky only sends ${config.api} requests to ${config.name}.`, { status: 403 });
      }

      return fetch(request);
    };

  const send = allowed(breaker.watch(config.transport));
  const ask = allowed(config.transport);

  let probe: { at: number; online: boolean; up: Promise<boolean> } | undefined;
  let lastUp = false;

  const reachable = (): Promise<boolean> => {
    const online = config.online();

    if (probe && probe.online === online && config.now() - probe.at < (config.probeTtlMs ?? PROBE_TTL_MS)) return probe.up;

    const up = online
      ? ask(`${origin}/v1/models`, { headers: probeHeaders(config.key), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).then(
          (response) => response.ok,
          () => false
        )
      : Promise.resolve(false);

    probe = { at: config.now(), online, up };

    void up.then((value) => {
      if (value === lastUp) return;

      lastUp = value;
      config.onChange?.(value);
    });

    return up;
  };

  const provider = createProvider({
    id: config.id,
    name: config.name,
    baseUrl: origin,
    auth: {
      apiKey: {
        name: `${config.name} key`,
        resolve: async () => ({ auth: { apiKey: config.key }, source: config.id })
      }
    },
    models,
    api: api()
  });

  return {
    provider: sending(provider, () => ({ fetch: send })),
    kind: "runner-local",
    name: config.name,
    needs: config.needs,
    models,
    featured,
    ...(light && { light }),
    thinkingLevel: config.thinkingLevel,
    breaker,
    connected: () => {
      void reachable();

      return lastUp && config.online();
    },
    reachable
  };
}
