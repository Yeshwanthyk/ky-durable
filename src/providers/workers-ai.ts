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

type Thinking = Pick<Model<Api>, "reasoning" | "thinkingLevelMap">;

/**
 * The models offered, each one that calls tools, from pi-ai's AI Gateway
 * catalog, and how each takes a thinking level as `reasoning_effort` on the
 * compat endpoint (probed live, docs/setup-plan.md C5). The first is the
 * default: it reads images and has a 1M window.
 *
 * - GLM 5.3 Flash thinks on its own. Any effort cuts its thinking to a few
 *   tokens, "high" as much as "low", and "none" is ignored, so it offers no
 *   level.
 * - Kimi K2.6 stops thinking at "none" and thinks at "high"; the levels
 *   between change little, so it offers off and high.
 * - GPT OSS 120B thinks less at "low" and more at "high", and refuses
 *   "none", so it offers low, medium and high.
 */
const MODELS: ReadonlyArray<readonly [string, Thinking]> = [
  ["workers-ai/@cf/zai-org/glm-5.3-flash", { reasoning: false }],
  ["workers-ai/@cf/moonshotai/kimi-k2.6", { reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null } }],
  ["workers-ai/@cf/openai/gpt-oss-120b", { reasoning: true, thinkingLevelMap: { off: null, minimal: null } }]
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
  const models = MODELS.map(([modelId, thinking]): Model<Api> => {
    const base = Object.values(CLOUDFLARE_AI_GATEWAY_MODELS).find((model) => model.id === modelId);

    if (!base) throw new TypeError(`No Workers AI model "${modelId}" in pi-ai's catalog.`);

    return {
      ...base,
      ...thinking,
      compat: { ...base.compat, supportsReasoningEffort: thinking.reasoning },
      provider: WORKERS_AI,
      baseUrl: base.baseUrl.replace(GATEWAY, ROOT)
    };
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
    kind: WORKERS_AI_RECORD.kind,
    name: WORKERS_AI_RECORD.label,
    needs: "the AI binding",
    models,
    thinkingLevel: "high",
    breaker,
    connected: () => true
  };
}
