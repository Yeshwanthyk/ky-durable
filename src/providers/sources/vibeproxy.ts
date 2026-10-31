import type { FetchFunction } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type { Missing as NotSetUp } from "../../avatars/contract";
import { Breaker } from "../breaker";
import type { ProviderRecord } from "../contract";
import type { Endpoint, Source, SourceHost } from "../endpoint";
import { type Offer, offered } from "../offer";
import { sending } from "../transport";

/**
 * Claude via VibeProxy: an Anthropic-compatible proxy on the user's computer. ky reaches it one of
 * two ways: through a paired machine's runner, which shares its port over the runner's socket
 * (src/machines/pipe.ts), or through a tunnel this deploy is bound to (VIBEPROXY, VIBEPROXY_ORIGIN
 * and the VIBEPROXY_KEY secret). This file is the only one in ky that knows either.
 */

export const VIBEPROXY_PROVIDER = "vibeproxy";

export const VIBEPROXY_PORT = 8317;

export const VIBEPROXY_NAME = "Claude via VibeProxy";

export const VIBEPROXY_OFFER: Offer = { featured: ["claude-opus-5-5", "claude-haiku-5-5"], light: "claude-haiku-5-5" };

export const VIBEPROXY_NOT_SET_UP: NotSetUp = {
  id: VIBEPROXY_PROVIDER,
  name: VIBEPROXY_NAME,
  needs: `a paired machine whose runner shares port ${VIBEPROXY_PORT} (KY_RUNNER_PORTS=${VIBEPROXY_PORT}), or the VIBEPROXY binding, VIBEPROXY_ORIGIN, and the VIBEPROXY_KEY secret`
};

export type VibeProxyTunnel = { readonly binding: Pick<Fetcher, "fetch">; readonly origin: string };

export type VibeProxyBoundary = { readonly port: number; readonly key: string | undefined; readonly tunnel: VibeProxyTunnel | undefined };

/** This deploy's way to VibeProxy, from its env: the runner port always, the tunnel when it has all three. */
export function vibeProxyFrom({ VIBEPROXY: binding, VIBEPROXY_ORIGIN: origin, VIBEPROXY_KEY: key }: Partial<Pick<Env, "VIBEPROXY" | "VIBEPROXY_ORIGIN" | "VIBEPROXY_KEY">>): VibeProxyBoundary {
  return { port: VIBEPROXY_PORT, key: key || undefined, tunnel: binding && origin && key ? { binding, origin } : undefined };
}

export function vibeProxyRecord(machine: string | null, port: number): ProviderRecord {
  return { id: VIBEPROXY_PROVIDER, kind: "runner-local", vendor: null, machine, port, api: "anthropic-messages", label: VIBEPROXY_NAME, enabled: true };
}

export function tunnelPort({ origin }: VibeProxyTunnel): number {
  const url = new URL(origin);

  return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}

const PATHS = new Set(["/v1/messages", "/v1/models"]);

const PROBE_TIMEOUT_MS = 3_000;

const PROBE_TTL_MS = 30_000;

type Way = {
  readonly machine: string | null;
  readonly origin: string;
  readonly transport: FetchFunction;
  readonly online: () => boolean;
};

function endpoint({ machine, transport, online, ...way }: Way, host: SourceHost): Endpoint {
  const { boundary, now, changed } = host;
  const key = boundary.vibeProxy.key ?? "none";
  const name = machine === null ? VIBEPROXY_NAME : `${VIBEPROXY_NAME} on ${machine}`;
  const origin = new URL(way.origin).origin;

  const { models, featured, light } = offered(
    Object.values(ANTHROPIC_MODELS).map((model) => ({ ...model, provider: VIBEPROXY_PROVIDER, baseUrl: origin })),
    VIBEPROXY_OFFER
  );

  const breaker = new Breaker(name, now);

  const allowed =
    (fetch: FetchFunction): FetchFunction =>
    async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.origin !== origin || !PATHS.has(url.pathname)) {
        return new Response(`ky only sends anthropic-messages requests to ${name}.`, { status: 403 });
      }

      return fetch(request);
    };

  const send = allowed(breaker.watch(transport));
  const ask = allowed(transport);

  let probe: { at: number; online: boolean; up: Promise<boolean> } | undefined;
  let lastUp = false;

  const reachable = (): Promise<boolean> => {
    const isOnline = online();

    if (probe && probe.online === isOnline && now() - probe.at < (boundary.probeTtlMs ?? PROBE_TTL_MS)) return probe.up;

    const up = isOnline
      ? ask(`${origin}/v1/models`, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).then(
          (response) => response.ok,
          () => false
        )
      : Promise.resolve(false);

    probe = { at: now(), online: isOnline, up };

    void up.then((value) => {
      if (value === lastUp) return;

      lastUp = value;
      changed();
    });

    return up;
  };

  const provider = createProvider({
    id: VIBEPROXY_PROVIDER,
    name,
    baseUrl: origin,
    auth: {
      apiKey: {
        name: `${name} key`,
        resolve: async () => ({ auth: { apiKey: key }, source: VIBEPROXY_PROVIDER })
      }
    },
    models,
    api: anthropicMessagesApi()
  });

  return {
    provider: sending(provider, () => ({ fetch: send })),
    kind: "runner-local",
    name,
    needs: machine === null ? "the computer online with VibeProxy" : `${machine} online, with VibeProxy on port ${new URL(origin).port}`,
    models,
    featured,
    ...(light && { light }),
    thinkingLevel: "medium",
    breaker,
    connected: () => {
      void reachable();

      return lastUp && online();
    },
    reachable
  };
}

export const vibeProxy: Source = {
  kind: "runner-local",
  priority: 0,
  missing: ({ vibeProxy: { tunnel } }, providers) => (tunnel || providers.includes(VIBEPROXY_PROVIDER) ? [] : [VIBEPROXY_NOT_SET_UP]),
  start: (host) => ({
    // The machine that shares the port, online first; else the tunnel. The record stays when both go, so a reboot finds it.
    place: () => {
      const { port, tunnel } = host.boundary.vibeProxy;
      const sharing = host.machines.machines().filter((machine) => machine.facts?.ports.includes(port));
      const machine = sharing.find((each) => each.online) ?? sharing[0];

      if (machine) return [vibeProxyRecord(machine.name, port)];

      return tunnel ? [vibeProxyRecord(null, tunnelPort(tunnel))] : [];
    },
    build: ({ id, machine, port }) => {
      if (id !== VIBEPROXY_PROVIDER) return undefined;

      if (machine !== null && port !== null) {
        return endpoint({ machine, origin: `http://127.0.0.1:${port}`, transport: host.pipe.fetcher(machine, port), online: () => host.machines.online(machine) }, host);
      }

      const { tunnel } = host.boundary.vibeProxy;

      return tunnel && endpoint({ machine: null, origin: tunnel.origin, transport: (input, init) => tunnel.binding.fetch(input, init), online: () => true }, host);
    }
  })
};
