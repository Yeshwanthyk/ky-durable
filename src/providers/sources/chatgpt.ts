import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { Breaker } from "../breaker";
import type { ProviderRecord } from "../contract";
import type { Endpoint, Source, SourceHost } from "../endpoint";
import { type Offer, offered } from "../offer";
import { sending } from "../transport";

/**
 * The user's ChatGPT subscription, in ky's own chat: the login Settings › Subscriptions keeps in the
 * Vault for Codex tasks, sent to ChatGPT's Codex backend through pi's openai-codex-responses API.
 * The Vault alone refreshes the token (chatgptToken), so chat and Codex tasks never both rotate it.
 */

const CHATGPT = "chatgpt";

const NAME = "ChatGPT subscription";

const OFFER: Offer = { featured: ["gpt-6.1-sol", "gpt-6-luna"], light: "gpt-6-luna" };

/** How long a look at whether the user is signed in is trusted. */
const CHECK_TTL_MS = 30_000;

const RECORD: ProviderRecord = { id: CHATGPT, kind: "chatgpt", vendor: null, machine: null, port: null, api: null, label: NAME, enabled: true };

/**
 * chatgpt.com answers many requests from a Worker with its "Unable to load site" page, a 403 in HTML
 * naming a Cloudflare address, while the same request from ky's container goes through (Scotty found
 * the same). Each request goes from the Worker first, which needs no container; one turned away goes
 * again through `cloud`, and the first answer stands when there is no cloud machine or it fails too.
 */
function viaCloudWhenTurnedAway(direct: FetchFunction, cloud: FetchFunction | undefined): FetchFunction {
  if (!cloud) return direct;

  // pi sends the body as bytes or text, never a stream, so the same request can go twice.
  return async (input, init) => {
    const first = await direct(input, init);

    if (first.status !== 403 || !first.headers.get("content-type")?.includes("text/html")) return first;

    try {
      const again = await cloud(input, init);

      await first.body?.cancel();
      const said = again.ok ? "" : `: ${(await again.clone().text()).slice(0, 300)}`;

      console.log(`ChatGPT turned the Worker away; through the cloud machine it answered ${again.status}${said}`);

      return again;
    } catch (error) {
      console.warn(`ChatGPT turned the Worker away, and the cloud machine couldn't send it either: ${error instanceof Error ? error.message : String(error)}`);

      return first;
    }
  };
}

function endpoint({ boundary, vault, now }: SourceHost, signedIn: () => boolean): Endpoint {
  const { models, featured, light } = offered(
    Object.values(OPENAI_CODEX_MODELS).map((model) => ({ ...model, provider: CHATGPT })),
    OFFER
  );

  const breaker = new Breaker(NAME, now);
  const fetch = breaker.watch(viaCloudWhenTurnedAway(boundary.fetch, boundary.chatgptCloud));

  const provider = createProvider({
    id: CHATGPT,
    name: NAME,
    baseUrl: "https://chatgpt.com/backend-api",
    auth: {
      apiKey: {
        name: "ChatGPT sign-in",
        resolve: async () => {
          const creds = await vault.chatgptToken();

          return creds ? { auth: { apiKey: creds.accessToken }, source: "the Vault" } : undefined;
        }
      }
    },
    models,
    api: openAICodexResponsesApi()
  });

  return {
    // A Worker can't open a WebSocket with headers, so Codex streams over SSE.
    provider: sending(provider, () => ({ fetch, transport: "sse" })),
    kind: "chatgpt",
    name: NAME,
    needs: "ChatGPT signed in, in Settings › Subscriptions",
    models,
    featured,
    ...(light && { light }),
    thinkingLevel: "medium",
    breaker,
    connected: signedIn
  };
}

export const chatgpt: Source = {
  kind: "chatgpt",
  priority: 2,
  start: (host) => {
    let signedIn = false;
    let last: { at: number; done: Promise<void> } | undefined;

    const check = (): Promise<void> => {
      const done = host.vault.chatgptToken().then(
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
      // Its record is placed once the user signs in, and kept: whether it's usable is whether they still are.
      place: () => (signedIn ? [RECORD] : []),
      build: () =>
        endpoint(host, () => {
          if (!last || host.now() - last.at >= CHECK_TTL_MS) void check();

          return signedIn;
        })
    };
  }
};
