import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AiBinding,
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
import { Breaker, type Now } from "../breaker";
import type { ProviderRecord } from "../contract";
import type { Endpoint, Source } from "../endpoint";
import { offered } from "../offer";
import { sending } from "../transport";

const WORKERS_AI = "workers-ai";

const WORKERS_AI_RECORD: ProviderRecord = {
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

const MODELS: ReadonlyArray<readonly [string, Thinking]> = [
  ["workers-ai/@cf/zai-org/glm-5.3-flash", { reasoning: false }],
  ["workers-ai/@cf/moonshotai/kimi-k2.6", { reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null } }],
  ["workers-ai/@cf/openai/gpt-oss-120b", { reasoning: true, thinkingLevelMap: { off: null, minimal: null } }]
];

const ROOT = "https://workers-binding.ai/ai-gateway/gateways/default";

const GATEWAY = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/[^/]+/;

const HEADERS = {
  "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
  Authorization: null,
  "x-api-key": null
};

function workersAI(ai: AiBinding, now: Now): Endpoint {
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

  const breaker = new Breaker(WORKERS_AI_RECORD.label, now);
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
    ...offered(models, { featured: models.map((model) => model.id) }),
    thinkingLevel: "high",
    breaker,
    connected: () => true
  };
}

/** Workers AI, through this deploy's AI binding: always there, always last, and the default for background work. */
export const workersAi: Source = {
  kind: "workers-ai",
  priority: 3,
  background: true,
  start: ({ boundary, now }) => ({
    place: () => [WORKERS_AI_RECORD],
    build: () => workersAI(boundary.ai, now)
  })
};
