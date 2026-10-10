import type { FetchFunction, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { Endpoint } from "../models";
import { Breaker } from "./breaker";
import type { ProviderRecord } from "./records";
import { sending } from "./transport";

/**
 * Vendors reached with an API key of the user's, which Settings saves in the
 * Vault. Each request's key is read from the Vault as it is sent; pi-ai's own
 * ways to find one (the env, a stored credential, a vendor's sign-in) are
 * never asked.
 */

/** What an api-key provider's requests authenticate with, as the Vault keeps it. */
export type ProviderKey = { readonly apiKey: string; readonly headers?: Readonly<Record<string, string>> };

export type Vendor = {
  /** The pi provider id, which is also the record's id and vendor. */
  readonly id: string;
  readonly name: string;
  readonly provider: () => Provider;
  /** The models offered, the first being the default; pi-ai's first model of the vendor stands in for any it has dropped. */
  readonly modelIds: readonly string[];
  /** Its quick, cheap model, which also takes the test call a new key gets. */
  readonly light?: string;
  readonly thinkingLevel: ModelThinkingLevel;
  /** The session sent with a request that has none, for a vendor that refuses those. */
  readonly session?: string;
  /** Why a key the vendor would take must not be saved, when it must not. */
  readonly refuse?: (key: string) => string | undefined;
};

/** Why a Claude subscription token is refused as an API key, and where it goes instead. */
export const CLAUDE_TOKEN_HERE =
  "That's a Claude subscription token. It goes in Settings › Subscriptions, where tasks on your machines use it. Here, paste an Anthropic API key (sk-ant-api…).";

export const VENDORS: readonly Vendor[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    provider: anthropicProvider,
    modelIds: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
    light: "claude-haiku-4-5",
    thinkingLevel: "medium",
    // pi sends a subscription token as Claude Code would, which policy 8 rules out.
    refuse: (key) => (key.includes("sk-ant-oat") ? CLAUDE_TOKEN_HERE : undefined)
  },
  {
    id: "openai",
    name: "OpenAI",
    provider: openaiProvider,
    modelIds: ["gpt-6.1-sol", "gpt-6-luna"],
    light: "gpt-6-luna",
    thinkingLevel: "medium"
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    provider: opencodeGoProvider,
    modelIds: ["deepseek-v4.1-flash"],
    thinkingLevel: "high",
    // OpenCode Go routes by session and refuses requests without one.
    session: "ky"
  }
];

export function apiKeyRecord(vendor: Vendor): ProviderRecord {
  return {
    id: vendor.id,
    kind: "api-key",
    vendor: vendor.id,
    machine: null,
    port: null,
    api: null,
    label: vendor.name,
    enabled: true
  };
}

/** `vendor`'s provider, reaching it through `fetch` with the key `key` finds for it as each request is sent. */
export function apiKey(
  vendor: Vendor,
  fetch: FetchFunction,
  key: (providerId: string) => Promise<ProviderKey | null>
): Endpoint {
  const provider = vendor.provider();
  const all = provider.getModels();
  const offered = vendor.modelIds.flatMap((id) => all.find((model) => model.id === id) ?? []);
  // SAFETY: pi-ai's vendor providers ship fixed, non-empty model lists.
  const models = offered.length > 0 ? offered : [all[0]!];
  const breaker = new Breaker(vendor.name);
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
    light: models.find((model) => model.id === vendor.light),
    thinkingLevel: vendor.thinkingLevel,
    breaker,
    connected: () => true
  };
}
