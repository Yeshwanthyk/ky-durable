import type { Api, Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type { Endpoint } from "../models";
import type { NotSetUp } from "../setup";
import { Breaker } from "./breaker";
import type { ProviderRecord } from "./records";
import { sending } from "./transport";

/**
 * Claude through VibeProxy on a computer of the user's. The computer runs a
 * Cloudflare Tunnel that has no public hostname; this Worker reaches it only
 * through its Workers VPC binding. Requests may only go to the two Messages
 * API paths, and VibeProxy still checks its own key.
 *
 * The provider is offered only while its probe answers; models.ts runs a
 * call on the fallback model when it does not.
 */

export const VIBEPROXY_PROVIDER = "vibeproxy";

const NAME = "Claude via VibeProxy";

/** Claude models to offer: the main agent's first, then a small and quick one. */
const MODEL_IDS = ["claude-opus-5-5", "claude-haiku-4-5"];

/** A runner-local provider on the port of `origin`, reached through the overlay's tunnel until node P pipes it through the runner. */
export function vibeProxyRecord(origin: string): ProviderRecord {
  return {
    id: VIBEPROXY_PROVIDER,
    kind: "runner-local",
    vendor: null,
    machine: null,
    port: Number(new URL(origin).port),
    api: "anthropic-messages",
    label: NAME,
    enabled: true
  };
}

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
  /** The tunnel's Workers VPC binding. */
  readonly binding: Pick<Fetcher, "fetch">;
  /** VibeProxy's listen address on that computer, which the tunnel forwards to, e.g. http://127.0.0.1:8317. */
  readonly origin: string;
  readonly key: string;
  /** Called when the computer comes online or goes away. */
  readonly onChange?: (up: boolean) => void;
  /** How long one probe's answer is trusted; 30s by default. */
  readonly probeTtlMs?: number;
};

export function vibeProxy(config: VibeProxyConfig): Endpoint {
  const origin = new URL(config.origin).origin;

  const models = MODEL_IDS.map((modelId): Model<Api> => {
    const base = Object.values(ANTHROPIC_MODELS).find((model) => model.id === modelId);

    if (!base) throw new TypeError(`No Anthropic model "${modelId}" in pi-ai's catalog.`);

    return { ...base, provider: VIBEPROXY_PROVIDER, baseUrl: origin };
  });

  const breaker = new Breaker(NAME);
  const tunnel = breaker.watch((input, init) => config.binding.fetch(input, init));

  const send = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.origin !== origin || !ALLOWED_PATHS.has(url.pathname)) {
      return new Response("ky only sends Messages API requests to VibeProxy.", { status: 403 });
    }

    return tunnel(request);
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
    id: VIBEPROXY_PROVIDER,
    name: "VibeProxy",
    baseUrl: origin,
    auth: {
      apiKey: {
        name: "VibeProxy key",
        resolve: async () => ({ auth: { apiKey: config.key }, source: "VIBEPROXY_KEY" })
      }
    },
    models,
    api: anthropicMessagesApi()
  });

  return {
    provider: sending(provider, () => ({ fetch: send })),
    name: NAME,
    needs: "the computer online with VibeProxy",
    models,
    thinkingLevel: "medium",
    breaker,
    /** The last probe reached it. Starts a new probe when that one is stale. */
    connected: () => {
      void reachable();

      return lastUp;
    },
    reachable
  };
}
