import type { FetchFunction, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { Endpoint } from "../models";
import type { NotSetUp } from "../setup";
import { Breaker } from "./breaker";
import type { ProviderRecord } from "./records";
import { sending } from "./transport";

/**
 * Vendors reached with an API key of the user's. pi-ai's provider for each
 * resolves the key by its secret's name from the registry's env, which reads
 * the Worker's secrets for now (node K moves them to the Vault).
 */

/** The secrets that hold the vendors' keys, each an optional var of env.optional.d.ts. */
export type ApiKeySecret = "OPENCODE_API_KEY";

export type Vendor = {
  /** The pi provider id, which is also the record's id and vendor. */
  readonly id: string;
  readonly name: string;
  /** The secret that holds the key. */
  readonly secret: ApiKeySecret;
  readonly provider: () => Provider;
  /** The models offered, the first being the default; pi-ai's first model of the vendor stands in for any it has dropped. */
  readonly modelIds: readonly string[];
  readonly thinkingLevel: ModelThinkingLevel;
  /** The session sent with a request that has none, for a vendor that refuses those. */
  readonly session?: string;
};

export const VENDORS: readonly Vendor[] = [
  {
    id: "opencode-go",
    name: "OpenCode Go",
    secret: "OPENCODE_API_KEY",
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

/** What Settings shows for a vendor whose secret is not set. */
export function vendorNotSetUp(vendor: Vendor): NotSetUp {
  return { id: vendor.id, name: vendor.name, needs: `the ${vendor.secret} secret` };
}

/** `vendor`'s provider, reaching it through `fetch`. */
export function apiKey(vendor: Vendor, fetch: FetchFunction): Endpoint {
  const provider = vendor.provider();
  const all = provider.getModels();
  const offered = all.filter((model) => vendor.modelIds.includes(model.id));
  // SAFETY: pi-ai's vendor providers ship fixed, non-empty model lists.
  const models = offered.length > 0 ? offered : [all[0]!];
  const breaker = new Breaker(vendor.name);
  const watched = breaker.watch(fetch);

  return {
    provider: sending(provider, (given) => ({ fetch: watched, sessionId: given?.sessionId ?? vendor.session })),
    name: vendor.name,
    needs: vendorNotSetUp(vendor).needs,
    models,
    thinkingLevel: vendor.thinkingLevel,
    breaker,
    connected: () => true
  };
}
