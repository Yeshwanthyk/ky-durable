import type { FetchFunction, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import type { AgentChange } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";
import type { VibeProxyBoundary } from "./sources/vibeproxy";

export const PROVIDER_TABLES = Object.freeze({ providers: "ky_providers" } as const);

export const ProviderKind = Schema.Literals(["workers-ai", "api-key", "runner-local", "chatgpt"]);

export type ProviderKind = typeof ProviderKind.Type;

const ProviderRecord = Schema.Struct({
  id: Schema.String,
  kind: ProviderKind,
  vendor: Schema.NullOr(Schema.String),
  machine: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
  api: Schema.NullOr(Schema.String),
  label: Schema.String,
  enabled: Schema.Boolean
});

export type ProviderRecord = typeof ProviderRecord.Type;

export const CONTEXT_WINDOW = 136_000;

export type AskLimits = { readonly timeoutMs: number; readonly maxTokens: number };

export type ModelNeed = { readonly images?: boolean };

export type ProviderKey = { readonly apiKey: string; readonly headers?: Readonly<Record<string, string>> };

export type KeyVault = {
  auth(providerId: string): Promise<ProviderKey | null>;
  put(kind: "provider", id: string, value: ProviderKey): Promise<void>;
  remove(kind: "provider", id: string): Promise<void>;
  /** The ChatGPT login's access token, refreshed by the Vault when it's close to running out; null when signed out. */
  chatgptToken(): Promise<{ readonly accessToken: string } | null>;
};

export type ModelsBoundary = {
  readonly ai: AiBinding;
  readonly fetch: FetchFunction;
  readonly vibeProxy: VibeProxyBoundary;
  readonly probeTtlMs?: number;
};

export const CLAUDE_TOKEN_HERE =
  "That's a Claude subscription token. It goes in Settings › Subscriptions, where tasks on your machines use it. Here, paste an Anthropic API key (sk-ant-api…).";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export const VERIFICATION_URL = "https://auth.openai.com/codex/device";

export const DEVICE_CODE_TTL_MS = 15 * 60_000;

export type ChatGptLogin = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  expiresAt: number;
};

export type Device = { deviceAuthId: string; userCode: string; intervalMs: number };

type Choice = { readonly provider: string; readonly modelId: string; readonly thinkingLevel: ModelThinkingLevel };

export function agentModel({ provider, modelId, thinkingLevel }: Choice): AgentChange {
  return { model: { provider, modelId }, thinkingLevel };
}

export function parseModel(text: string, thinkingLevel: ModelThinkingLevel): Choice {
  const [provider = "", ...rest] = text.trim().split("/");

  return { provider: provider.trim(), modelId: rest.join("/").trim(), thinkingLevel };
}

export class NoVendor extends Schema.TaggedError<NoVendor>()("NoVendor", { vendorId: Schema.String }) implements Refusable {
  get refusal(): string {
    return `ky has no vendor "${this.vendorId}".`;
  }
}

export class NoKey extends Schema.TaggedError<NoKey>()("NoKey", { vendor: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Paste your ${this.vendor} API key.`;
  }
}

export class SubscriptionToken extends Schema.TaggedError<SubscriptionToken>()("SubscriptionToken", {}) implements Refusable {
  get refusal(): string {
    return CLAUDE_TOKEN_HERE;
  }
}

export class KeyRefused extends Schema.TaggedError<KeyRefused>()("KeyRefused", { vendor: Schema.String, reason: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.vendor} refused the key: ${this.reason}`;
  }
}

export class TestUnfinished extends Schema.TaggedError<TestUnfinished>()("TestUnfinished", { vendor: Schema.String, reason: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.vendor} didn't finish the test call (${this.reason}). Try again.`;
  }
}

export class NoKeyToRemove extends Schema.TaggedError<NoKeyToRemove>()("NoKeyToRemove", { providerId: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.providerId} has no API key to remove.`;
  }
}

export class NoProvider extends Schema.TaggedError<NoProvider>()("NoProvider", {}) implements Refusable {
  get refusal(): string {
    return "No model provider is enabled.";
  }
}

export class ModelFailed extends Schema.TaggedError<ModelFailed>()("ModelFailed", { message: Schema.String }) implements Refusable {
  get refusal(): string {
    return this.message;
  }
}

export class ChatGptRefused extends Schema.TaggedError<ChatGptRefused>()("ChatGptRefused", { step: Schema.String, status: Schema.Number, code: Schema.optional(Schema.String) }) implements Refusable {
  get refusal(): string {
    return `ChatGPT ${this.step} failed: ${this.status}${this.code ? ` ${this.code}` : ""}.`;
  }
}

export class ChatGptUnreadable extends Schema.TaggedError<ChatGptUnreadable>()("ChatGptUnreadable", { step: Schema.String, what: Schema.Literals(["an answer", "a token"]) }) implements Refusable {
  get refusal(): string {
    return `ChatGPT ${this.step} failed: ${this.what} ky can't read.`;
  }
}

export class ChatGptNoAccount extends Schema.TaggedError<ChatGptNoAccount>()("ChatGptNoAccount", { step: Schema.String }) implements Refusable {
  get refusal(): string {
    return `ChatGPT ${this.step} failed: the tokens name no account or expiry.`;
  }
}

export class Unreached extends Schema.TaggedError<Unreached>()("Unreached", { message: Schema.String }) implements Refusable {
  get refusal(): string {
    return this.message;
  }
}
