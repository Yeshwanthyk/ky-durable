import type { FetchFunction, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { Breaker, type Now } from "./breaker";
import type { ProviderKey, ProviderRecord } from "./contract";
import type { Endpoint } from "./endpoint";
import { type Offer, offered } from "./offer";
import { sending } from "./transport";

export type Vendor = {
  readonly id: string;
  readonly name: string;
  readonly provider: () => Provider;
  readonly offer: Offer;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly session?: string;
  readonly subscription?: (key: string) => boolean;
};

export const VENDORS: readonly Vendor[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    provider: anthropicProvider,
    offer: { featured: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"], light: "claude-haiku-4-5" },
    thinkingLevel: "medium",
    subscription: (key) => key.includes("sk-ant-oat")
  },
  {
    id: "openai",
    name: "OpenAI",
    provider: openaiProvider,
    offer: { featured: ["gpt-6.1-sol", "gpt-6-luna"], light: "gpt-6-luna" },
    thinkingLevel: "medium"
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    provider: opencodeGoProvider,
    offer: { featured: ["deepseek-v4.1-flash"] },
    thinkingLevel: "high",
    session: "ky"
  }
];

export function apiKeyRecord(vendor: Vendor): ProviderRecord {
  return { id: vendor.id, kind: "api-key", vendor: vendor.id, machine: null, port: null, api: null, label: vendor.name, enabled: true };
}

export function apiKey(vendor: Vendor, fetch: FetchFunction, key: (providerId: string) => Promise<ProviderKey | null>, now: Now): Endpoint {
  const provider = vendor.provider();
  const { models, featured, light } = offered(provider.getModels(), vendor.offer);
  const breaker = new Breaker(vendor.name, now);
  const watched = breaker.watch(fetch);

  const keyed: Provider = {
    ...provider,
    auth: {
      apiKey: {
        name: `${vendor.name} API key`,
        resolve: async () => {
          const found = await key(vendor.id);

          return found ? { auth: found, source: "the Vault" } : undefined;
        }
      }
    }
  };

  return {
    provider: sending(keyed, (given) => ({ fetch: watched, sessionId: given?.sessionId ?? vendor.session })),
    kind: "api-key",
    name: vendor.name,
    needs: "an API key",
    models,
    featured,
    ...(light && { light }),
    thinkingLevel: vendor.thinkingLevel,
    breaker,
    connected: () => true
  };
}
