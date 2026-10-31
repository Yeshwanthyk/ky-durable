import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
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

function endpoint({ boundary, vault, now }: SourceHost, signedIn: () => boolean): Endpoint {
  const { models, featured, light } = offered(
    Object.values(OPENAI_CODEX_MODELS).map((model) => ({ ...model, provider: CHATGPT })),
    OFFER
  );

  const breaker = new Breaker(NAME, now);
  const fetch = breaker.watch(boundary.fetch);

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
