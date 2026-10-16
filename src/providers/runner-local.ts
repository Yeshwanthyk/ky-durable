import type { Api, FetchFunction, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { Endpoint } from "./endpoint";
import { type Offer, offered } from "./offer";
import { Breaker } from "./breaker";
import { sending } from "./transport";

/**
 * A model server on one of the user's computers (C5's `runner-local`), such
 * as VibeProxy: an Anthropic-compatible or OpenAI-compatible API on a port of
 * a paired machine, reached through its runner over the pipe (pipe.ts), or
 * through the owner overlay's tunnel. Requests may only go to the API's own
 * paths. The provider is offered only while its machine is online and its
 * probe answers; models.ts runs a call on a stand-in when it does not.
 */

/** The APIs a runner-local provider may speak, and what ky may ask of each. */
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
  /** The name Settings shows. */
  readonly name: string;
  /** What connects it, when it is not. */
  readonly needs: string;
  readonly api: LocalApi;
  /** The server's address as pi's models name it, e.g. http://127.0.0.1:8317; only its path reaches the server. */
  readonly origin: string;
  /** The server's catalog; each model's `baseUrl` is set to `origin`. */
  readonly catalog: readonly Model<Api>[];
  /** What of the catalog is featured, and its light model. */
  readonly offer: Offer;
  readonly thinkingLevel: ModelThinkingLevel;
  /** The server's own key. */
  readonly key: string;
  /** How requests reach the server: the machine's pipe, or the overlay's tunnel. */
  readonly transport: FetchFunction;
  /** Its machine's runner is connected now; a tunnel's machine is always taken to be, and the probe tells. */
  readonly online: () => boolean;
  /** Called when it comes or goes. */
  readonly onChange?: (up: boolean) => void;
  /** How long one probe's answer is trusted while the machine stays online; 30s by default. */
  readonly probeTtlMs?: number;
};

export function runnerLocal(config: RunnerLocalConfig): Endpoint {
  const origin = new URL(config.origin).origin;
  const { paths, probe: probeHeaders, api } = APIS[config.api];

  const { models, featured, light } = offered(
    config.catalog.map((model) => ({ ...model, provider: config.id, baseUrl: origin })),
    config.offer
  );

  const breaker = new Breaker(config.name);

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
  // The probe goes around the breaker: its answer must not close a breaker that the calls opened.
  const ask = allowed(config.transport);

  let probe: { at: number; online: boolean; up: Promise<boolean> } | undefined;
  let lastUp = false;

  // A machine that went offline is down at once, whatever the last probe said.
  const reachable = (): Promise<boolean> => {
    const online = config.online();

    if (probe && probe.online === online && Date.now() - probe.at < (config.probeTtlMs ?? PROBE_TTL_MS)) return probe.up;

    const up = online
      ? ask(`${origin}/v1/models`, { headers: probeHeaders(config.key), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).then(
          (response) => response.ok,
          () => false
        )
      : Promise.resolve(false);

    probe = { at: Date.now(), online, up };

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
    /** Online, and the last probe reached it. Starts a new probe when that one is stale. */
    connected: () => {
      void reachable();

      return lastUp && config.online();
    },
    reachable
  };
}
