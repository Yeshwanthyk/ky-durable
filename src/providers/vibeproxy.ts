import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { type ProviderRecord, VIBEPROXY_NAME, VIBEPROXY_PROVIDER, type VibeProxyTunnel } from "./contract";
import type { Endpoint } from "./endpoint";
import type { Offer } from "./offer";
import { type RunnerLocalConfig, runnerLocal } from "./runner-local";

export const VIBEPROXY_OFFER: Offer = { featured: ["claude-opus-5-5", "claude-haiku-5-5"], light: "claude-haiku-5-5" };

export function vibeProxyRecord(machine: string | null, port: number): ProviderRecord {
  return { id: VIBEPROXY_PROVIDER, kind: "runner-local", vendor: null, machine, port, api: "anthropic-messages", label: VIBEPROXY_NAME, enabled: true };
}

export function tunnelPort({ origin }: VibeProxyTunnel): number {
  const url = new URL(origin);

  return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}

type VibeProxyConfig = Pick<RunnerLocalConfig, "transport" | "online" | "onChange" | "probeTtlMs" | "now"> & {
  readonly machine: string | null;
  readonly origin: string;
  readonly key: string | undefined;
};

export function vibeProxy({ machine, key, ...config }: VibeProxyConfig): Endpoint {
  return runnerLocal({
    ...config,
    id: VIBEPROXY_PROVIDER,
    name: machine === null ? VIBEPROXY_NAME : `${VIBEPROXY_NAME} on ${machine}`,
    needs: machine === null ? "the computer online with VibeProxy" : `${machine} online, with VibeProxy on port ${new URL(config.origin).port}`,
    api: "anthropic-messages",
    catalog: Object.values(ANTHROPIC_MODELS),
    offer: VIBEPROXY_OFFER,
    thinkingLevel: "medium",
    key: key ?? "none"
  });
}
