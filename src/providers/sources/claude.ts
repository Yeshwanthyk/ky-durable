import type { FetchFunction } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { Breaker } from "../breaker";
import { remoteClaudeApi } from "../claude/remote";
import { CLAUDE_MODELS } from "../claude/wire";
import type { ProviderRecord } from "../contract";
import type { Endpoint, Source, SourceHost } from "../endpoint";
import { type Offer, offered } from "../offer";

/**
 * The user's Claude subscription, in ky's own chat: the `sk-ant-oat…` setup token Settings › Subscriptions
 * keeps in the Vault for Claude Code tasks, run through Claude Code inside ky's cloud machine container
 * (`POST /claude` in cli/runner/cloud.ts, via CloudMachine.claude).
 */

const CLAUDE = "claude";

const NAME = "Claude subscription";

const OFFER: Offer = { featured: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"], light: "claude-haiku-4-5" };

/** How long a look at whether the user has a Claude subscription token is trusted. */
const CHECK_TTL_MS = 30_000;

const RECORD: ProviderRecord = { id: CLAUDE, kind: "claude", vendor: null, machine: null, port: null, api: null, label: NAME, enabled: true };

const noClaude: FetchFunction = async () => new Response("This deploy has no cloud machine for Claude.", { status: 501 });

function endpoint({ boundary, vault, now }: SourceHost, signedIn: () => boolean): Endpoint {
  const { models, featured, light } = offered(CLAUDE_MODELS, OFFER);
  const breaker = new Breaker(NAME, now);
  const fetch = breaker.watch(boundary.claudeCloud ?? noClaude);

  const provider = createProvider({
    id: CLAUDE,
    name: NAME,
    baseUrl: "claude-code:",
    auth: {
      apiKey: {
        name: "Claude setup token",
        resolve: async () => {
          const creds = await vault.claudeToken();

          return creds ? { auth: { apiKey: creds.oauthToken }, source: "the Vault" } : undefined;
        }
      }
    },
    models,
    api: remoteClaudeApi(fetch)
  });

  return {
    provider,
    kind: "claude",
    name: NAME,
    needs: "Claude subscription in Settings › Subscriptions, on a deploy with a cloud machine",
    models,
    featured,
    ...(light && { light }),
    thinkingLevel: "medium",
    breaker,
    connected: () => signedIn() && boundary.claudeCloud !== undefined
  };
}

export const claude: Source = {
  kind: "claude",
  priority: 2,
  start: (host) => {
    let signedIn = false;
    let last: { at: number; done: Promise<void> } | undefined;

    const check = (): Promise<void> => {
      const done = host.vault.claudeToken().then(
        (creds) => {
          if ((creds !== null) === signedIn) return;
          signedIn = creds !== null;
          host.changed();
        },
        () => {}
      );

      last = { at: host.now(), done };

      return done;
    };

    return {
      check,
      place: () => (signedIn && host.boundary.claudeCloud !== undefined ? [RECORD] : []),
      build: () =>
        endpoint(host, () => {
          if (!last || host.now() - last.at >= CHECK_TTL_MS) void check();

          return signedIn;
        })
    };
  }
};
