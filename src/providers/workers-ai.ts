import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AiBinding,
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
import type { Endpoint } from "../models";
import { Breaker } from "./breaker";
import type { ProviderRecord } from "./records";
import { sending } from "./transport";

/**
 * Workers AI through the deploy's AI binding: models that need no key, so a
 * deploy with no secrets still chats. Requests go to AI Gateway's default
 * gateway over the binding's `fetch`, which carries the account's identity;
 * the auth header pi wants is a placeholder the gateway drops.
 */

export const WORKERS_AI = "workers-ai";

export const WORKERS_AI_RECORD: ProviderRecord = {
  id: WORKERS_AI,
  kind: "workers-ai",
  vendor: null,
  machine: null,
  port: null,
  api: null,
  label: "Workers AI",
  enabled: true
};

/**
 * The models offered, each one that calls tools, from pi-ai's AI Gateway
 * catalog. The first is the default: it reads images and has a 1M window.
 */
const MODEL_IDS = [
  "workers-ai/@cf/zai-org/glm-5.3-flash",
  "workers-ai/@cf/moonshotai/kimi-k2.6",
  "workers-ai/@cf/openai/gpt-oss-120b"
];

/** The binding's route to AI Gateway's default gateway, in place of the catalog's HTTPS one. */
const ROOT = "https://workers-binding.ai/ai-gateway/gateways/default";

const GATEWAY = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/[^/]+/;

/** The placeholder pi's auth check wants, and no SDK auth header, which the gateway would take as a key of the caller's. */
const HEADERS = {
  "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
  Authorization: null,
  "x-api-key": null
};

export function workersAI(ai: AiBinding): Endpoint {
  const models = MODEL_IDS.map((modelId): Model<Api> => {
    const base = Object.values(CLOUDFLARE_AI_GATEWAY_MODELS).find((model) => model.id === modelId);

    if (!base) throw new TypeError(`No Workers AI model "${modelId}" in pi-ai's catalog.`);

    return { ...base, provider: WORKERS_AI, baseUrl: base.baseUrl.replace(GATEWAY, ROOT) };
  });

  const breaker = new Breaker(WORKERS_AI_RECORD.label);
  const fetch = breaker.watch(createAiBindingFetch(ai));

  const provider = createProvider({
    id: WORKERS_AI,
    name: WORKERS_AI_RECORD.label,
    auth: {
      apiKey: {
        name: "AI binding",
        resolve: async () => ({ auth: { apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL }, source: "the AI binding" })
      }
    },
    models,
    api: openAICompletionsApi()
  });

  return {
    provider: sending(provider, (given) => ({ fetch, headers: { ...given?.headers, ...HEADERS } })),
    name: WORKERS_AI_RECORD.label,
    needs: "the AI binding",
    models,
    thinkingLevel: "high",
    breaker,
    connected: () => true
  };
}
