import type { ChatGptCode, ChatGptState, SubscriptionKind, SubscriptionView } from "./protocol";
import type { Agent, RunCreds } from "./runner-protocol";
import { SUBSCRIPTION, type Vault } from "./vault";

/**
 * Settings › Subscriptions: the user's Claude and ChatGPT logins, which the
 * Vault keeps and tasks on machines run with (MachineHub hands them out).
 * What crosses to the browser is only whether each is set up, when the
 * Claude token runs out, and the last refresh error; never a token.
 */

const KINDS: readonly SubscriptionKind[] = ["claude", "chatgpt"];

/** What `claude setup-token` prints: a long-lived OAuth token. */
const CLAUDE_TOKEN = /^sk-ant-oat\d+-[\w-]+$/;

/** How long a `claude setup-token` token lasts, as Claude Code says when it makes one. */
const CLAUDE_TOKEN_TTL_MS = 365 * 24 * 60 * 60_000;

export class Subscriptions {
  readonly #vault: () => DurableObjectStub<Vault>;
  readonly #listeners = new Set<() => void>();

  constructor(vault: () => DurableObjectStub<Vault>) {
    this.#vault = vault;
  }

  onChange(listener: () => void): void {
    this.#listeners.add(listener);
  }

  async view(): Promise<SubscriptionView[]> {
    const secrets = (await this.#vault().status()).filter((secret) => secret.id === SUBSCRIPTION);

    return KINDS.map((kind) => {
      const secret = secrets.find((candidate) => candidate.kind === kind);
      // setClaude keeps it as a number.
      const expiresAt = secret?.meta?.expiresAt;

      return { kind, connected: secret !== undefined, expiresAt: expiresAt ? Number(expiresAt) : null, error: secret?.error ?? null };
    });
  }

  /**
   * Keep what `claude setup-token` printed; `{ refused }` when it isn't one.
   * Only its shape is checked: nothing ky runs calls Anthropic with it, and
   * only the `claude` CLI on a machine is ever handed it.
   */
  async setClaude(token: string): Promise<{ refused?: string }> {
    const trimmed = token.trim();

    if (!CLAUDE_TOKEN.test(trimmed)) return { refused: "That isn't a Claude subscription token. Paste what `claude setup-token` prints." };
    await this.#vault().put("claude", SUBSCRIPTION, { oauthToken: trimmed }, { expiresAt: Date.now() + CLAUDE_TOKEN_TTL_MS });
    this.#changed();

    return {};
  }

  /** Forget a subscription: tasks sign in with their machine's own login again. */
  async remove(kind: SubscriptionKind): Promise<void> {
    if (!KINDS.includes(kind)) throw new Error(`No subscription ${JSON.stringify(kind)}.`);
    await this.#vault().remove(kind, SUBSCRIPTION);
    this.#changed();
  }

  /** Start ChatGPT's sign-in; `{ refused }` when OpenAI didn't take it, saying why without a secret. */
  async chatgptLogin(): Promise<ChatGptCode | { refused: string }> {
    try {
      return await this.#vault().chatgptLogin();
    } catch (error) {
      return { refused: error instanceof Error ? error.message : String(error) };
    }
  }

  /** How the sign-in is going; Settings asks until it is done or failed. */
  async chatgptPoll(loginId: string): Promise<ChatGptState> {
    const state = await this.#vault().chatgptPoll(loginId);

    if (state === "done") this.#changed();

    return state;
  }

  /** What a task running as `agent` is handed when its machine doesn't use its own login: empty without a subscription. */
  async creds(agent: Agent): Promise<RunCreds> {
    const creds = await this.#vault().sessionCreds(agent);

    return creds ? { [agent]: creds } : {};
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
