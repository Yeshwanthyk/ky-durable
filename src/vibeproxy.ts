import type { Api, Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type { Endpoint } from "./models";
import type { NotSetUp } from "./setup";

/**
 * Claude through VibeProxy on a computer of the user's. The computer runs a
 * Cloudflare Tunnel that has no public hostname; this Worker reaches it only
 * through its Workers VPC binding. Requests may only go to the two Messages
 * API paths, and VibeProxy still checks its own key.
 *
 * One call per tunnel. The provider is offered only while its probe answers;
 * models.ts runs a turn on the fallback model when it does not.
 */

export const VIBEPROXY_PROVIDER = "vibeproxy";

const NAME = "Claude via VibeProxy";

/** What the Models settings show when this deploy has no tunnel binding, origin, or key for VibeProxy. */
export const VIBEPROXY_NOT_SET_UP: NotSetUp = {
  id: VIBEPROXY_PROVIDER,
  name: NAME,
  needs: "the VIBEPROXY binding, VIBEPROXY_ORIGIN, and the VIBEPROXY_KEY secret"
};

const ALLOWED_PATHS = new Set(["/v1/messages", "/v1/models"]);

const PROBE_TIMEOUT_MS = 3_000;

const PROBE_TTL_MS = 30_000;

export type VibeProxyConfig = {
  /** The pi provider id; one per tunnel. */
  readonly id?: string;
  /** The name the Models settings show. */
  readonly name?: string;
  /** What brings it online, for the Models settings. */
  readonly needs?: string;
  /** The tunnel's Workers VPC binding. */
  readonly binding: Pick<Fetcher, "fetch">;
  /** VibeProxy's listen address on that computer, which the tunnel forwards to, e.g. http://127.0.0.1:8317. */
  readonly origin: string;
  readonly key: string;
  /** Claude models to offer. */
  readonly modelIds: readonly string[];
  /** Called when the computer comes online or goes away. */
  readonly onChange?: (up: boolean) => void;
  /** How long one probe's answer is trusted; 30s by default. */
  readonly probeTtlMs?: number;
};

export type VibeProxy = Endpoint & {
  /** Probe now, or reuse a fresh probe, and say whether VibeProxy answers. */
  readonly reachable: () => Promise<boolean>;
};

export function vibeProxy(config: VibeProxyConfig): VibeProxy {
  const id = config.id ?? VIBEPROXY_PROVIDER;
  const origin = new URL(config.origin).origin;

  const models = config.modelIds.map((modelId): Model<Api> => {
    const base = Object.values(ANTHROPIC_MODELS).find((model) => model.id === modelId);

    if (!base) throw new TypeError(`No Anthropic model "${modelId}" in pi-ai's catalog.`);

    return { ...base, provider: id, baseUrl: origin };
  });

  const api = anthropicMessagesApi();

  const send = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.origin !== origin || !ALLOWED_PATHS.has(url.pathname)) {
      return new Response("ky only sends Messages API requests to VibeProxy.", { status: 403 });
    }

    return config.binding.fetch(request);
  };

  let probe: { at: number; up: Promise<boolean> } | undefined;
  let lastUp = false;

  const reachable = (): Promise<boolean> => {
    if (probe && Date.now() - probe.at < (config.probeTtlMs ?? PROBE_TTL_MS)) return probe.up;

    const up = send(`${origin}/v1/models`, {
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
    id,
    name: "VibeProxy",
    baseUrl: origin,
    auth: {
      apiKey: {
        name: "VibeProxy key",
        resolve: async () => ({ auth: { apiKey: config.key }, source: "VIBEPROXY_KEY" })
      }
    },
    models,
    api: {
      stream: (target, context, options) => api.stream(target, context, { ...options, fetch: send }),
      streamSimple: (target, context, options) => api.streamSimple(target, context, { ...options, fetch: send })
    }
  });

  return {
    provider,
    name: config.name ?? NAME,
    needs: config.needs ?? "the computer online with VibeProxy",
    setUp: true,
    models,
    // Direct requests (titles) need the key in their options; pi's registry resolves it through `auth` above.
    apiKey: { name: "VIBEPROXY_KEY", value: config.key },
    /** The last probe reached it. Starts a new probe when that one is stale. */
    connected: () => {
      void reachable();

      return lastUp;
    },
    reachable
  };
}
