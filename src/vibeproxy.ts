import type { Api, AssistantMessage, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/**
 * Claude through VibeProxy on the user's Mac. The Mac runs a Cloudflare Tunnel
 * that has no public hostname; this Worker reaches it only through its Workers
 * VPC binding. Requests may only go to the two Messages API paths, and
 * VibeProxy still checks its own key.
 *
 * Claude is offered only while the Mac answers. When it is asleep or offline,
 * a turn already on Claude runs on the fallback model instead, so ky keeps
 * answering.
 */

export const VIBEPROXY_PROVIDER = "vibeproxy";

/** VibeProxy's listen address on the Mac; the tunnel forwards here. */
const ORIGIN = "http://127.0.0.1:8317";

const ALLOWED_PATHS = new Set(["/v1/messages", "/v1/models"]);

const PROBE_TIMEOUT_MS = 3_000;

const PROBE_TTL_MS = 30_000;

export type VibeProxyConfig = {
  readonly binding: Fetcher;
  readonly key: string | undefined;
  /** Claude models to offer; the first is the one turns use. */
  readonly modelIds: readonly string[];
  /** Runs the turn when VibeProxy is unreachable. */
  readonly fallback: (
    context: TranscriptContext,
    options: SimpleStreamOptions | undefined
  ) => ReturnType<Provider["streamSimple"]>;
  /** Called when the Mac comes online or goes away. */
  readonly onChange?: (up: boolean) => void;
};

export type VibeProxy = {
  readonly provider: Provider;
  readonly model: Model<Api>;
  readonly models: readonly Model<Api>[];
  /** The last probe reached the Mac. Starts a new probe when that one is stale. */
  readonly connected: () => boolean;
  /** Probe now, or reuse a fresh probe, and say whether the Mac answers. */
  readonly check: () => Promise<boolean>;
};

export function vibeProxy(config: VibeProxyConfig): VibeProxy {
  const models = config.modelIds.map((id): Model<Api> => {
    const base = Object.values(ANTHROPIC_MODELS).find((model) => model.id === id);

    if (!base) throw new TypeError(`No Anthropic model "${id}" in pi-ai's catalog.`);

    return { ...base, provider: VIBEPROXY_PROVIDER, baseUrl: ORIGIN };
  });

  const model = models[0]!;
  const api = anthropicMessagesApi();

  const send = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.origin !== ORIGIN || !ALLOWED_PATHS.has(url.pathname)) {
      return new Response("ky only sends Messages API requests to VibeProxy.", { status: 403 });
    }

    return config.binding.fetch(request);
  };

  let probe: { at: number; up: Promise<boolean> } | undefined;
  let lastUp = false;

  const reachable = (): Promise<boolean> => {
    if (!config.key) return Promise.resolve(false);

    if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.up;

    const up = send(`${ORIGIN}/v1/models`, {
      headers: { "x-api-key": config.key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    }).then(
      (response) => response.ok,
      () => false
    );
    probe = { at: Date.now(), up };

    void up.then((value) => {
      if (value === lastUp) return;

      lastUp = value;
      config.onChange?.(value);
    });

    return up;
  };

  const provider = createProvider({
    id: VIBEPROXY_PROVIDER,
    name: "VibeProxy (Mac)",
    baseUrl: ORIGIN,
    auth: {
      apiKey: {
        name: "VibeProxy key",
        resolve: async () =>
          config.key ? { auth: { apiKey: config.key }, source: "VIBEPROXY_KEY" } : undefined
      }
    },
    models,
    api: {
      stream: (target, context, options) => api.stream(target, context, { ...options, fetch: send }),
      streamSimple: (target, context, options) => {
        const out = createAssistantMessageEventStream();

        void (async () => {
          const up = await reachable();

          if (!up) console.warn("VibeProxy is unreachable; this turn runs on the fallback model.");
          const inner = up
            ? api.streamSimple(target, context, { ...options, fetch: send })
            : config.fallback(context, options);

          for await (const event of inner) out.push(event);
          out.end(await inner.result());
        })().catch((error: unknown) => {
          const message: AssistantMessage = {
            role: "assistant",
            content: [],
            api: target.api,
            provider: target.provider,
            model: target.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            },
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now()
          };
          out.push({ type: "error", reason: "error", error: message });
        });

        return out;
      }
    }
  });

  return {
    provider,
    model,
    models,
    connected: () => {
      void reachable();

      return lastUp;
    },
    check: reachable
  };
}
