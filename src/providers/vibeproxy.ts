import type { Api, Model } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type { Endpoint } from "../models";
import type { NotSetUp } from "../setup";
import type { ProviderRecord } from "./records";
import { type RunnerLocalConfig, runnerLocal } from "./runner-local";

/**
 * Claude through VibeProxy on a computer of the user's, a runner-local
 * provider (runner-local.ts) that speaks the Anthropic Messages API on port
 * 8317. It is reached one of two ways:
 *
 * - through the runner of a paired machine that shares VibeProxy's port
 *   (KY_RUNNER_PORTS), over the pipe: "Claude via VibeProxy on <machine>";
 * - through the owner overlay's Cloudflare Tunnel, which has no public
 *   hostname: this Worker reaches it only through its Workers VPC binding.
 *
 * The pipe wins: the tunnel is used only while no paired machine shares the
 * port. VibeProxy still checks its own key.
 */

export const VIBEPROXY_PROVIDER = "vibeproxy";

/** The port VibeProxy listens on. */
export const VIBEPROXY_PORT = 8317;

const NAME = "Claude via VibeProxy";

/** Claude models to offer: the main agent's first, then a small and quick one. */
const MODEL_IDS = ["claude-opus-5-5", "claude-haiku-4-5"];

/** What reaches VibeProxy from outside the Worker: production's in server.ts, the fakes' in src/tests/stack.ts. */
export type VibeProxyBoundary = {
  /** The port a machine's runner shares VibeProxy on: VIBEPROXY_PORT, unless the local stack moves it off the real one. */
  readonly port: number;
  /** VIBEPROXY_KEY, VibeProxy's own key, when the overlay sets it. */
  readonly key: string | undefined;
  /** The overlay's tunnel when this deploy has its binding, VIBEPROXY_ORIGIN and key. */
  readonly tunnel: VibeProxyTunnel | undefined;
};

export type VibeProxyTunnel = {
  /** The tunnel's Workers VPC binding. */
  readonly binding: Pick<Fetcher, "fetch">;
  /** VibeProxy's listen address on that computer, which the tunnel forwards to, e.g. http://127.0.0.1:8317. */
  readonly origin: string;
};

/** VibeProxy's record: on `machine`'s port when a runner shares it, else (machine null) on the tunnel's. */
export function vibeProxyRecord(machine: string | null, port: number): ProviderRecord {
  return { id: VIBEPROXY_PROVIDER, kind: "runner-local", vendor: null, machine, port, api: "anthropic-messages", label: NAME, enabled: true };
}

/** The port of the tunnel's origin. */
export function tunnelPort({ origin }: VibeProxyTunnel): number {
  const url = new URL(origin);

  // URL leaves out a scheme's default port.
  return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}

/** What the Models settings show while no machine shares VibeProxy and this deploy has no tunnel to it. */
export const VIBEPROXY_NOT_SET_UP: NotSetUp = {
  id: VIBEPROXY_PROVIDER,
  name: NAME,
  needs: `a paired machine whose runner shares port ${VIBEPROXY_PORT} (KY_RUNNER_PORTS=${VIBEPROXY_PORT}), or the VIBEPROXY binding, VIBEPROXY_ORIGIN, and the VIBEPROXY_KEY secret`
};

/** Where one VibeProxy is: a paired machine's port over the pipe, or the overlay's tunnel (machine null). */
export type VibeProxyConfig = Pick<RunnerLocalConfig, "transport" | "online" | "onChange" | "probeTtlMs"> & {
  readonly machine: string | null;
  readonly origin: string;
  readonly key: string | undefined;
};

export function vibeProxy({ machine, key, ...config }: VibeProxyConfig): Endpoint {
  const models = MODEL_IDS.map((modelId): Model<Api> => {
    const model = Object.values(ANTHROPIC_MODELS).find((each) => each.id === modelId);

    if (!model) throw new TypeError(`No Anthropic model "${modelId}" in pi-ai's catalog.`);

    return model;
  });

  return runnerLocal({
    ...config,
    id: VIBEPROXY_PROVIDER,
    name: machine === null ? NAME : `${NAME} on ${machine}`,
    needs: machine === null ? "the computer online with VibeProxy" : `${machine} online, with VibeProxy on port ${new URL(config.origin).port}`,
    api: "anthropic-messages",
    models,
    light: "claude-haiku-4-5",
    thinkingLevel: "medium",
    // A VibeProxy that checks no key takes any, and pi sends one.
    key: key ?? "none"
  });
}
