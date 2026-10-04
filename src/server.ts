import { DurableObject } from "cloudflare:workers";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, getSupportedThinkingLevels, type Provider } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { authenticate, loginPage, login } from "./auth";
import { executorExtension } from "./executor";
import { MachineHub, machineExtension } from "./machines";
import { Memory, memoryExtension } from "./memory";
import { type ModelOption, type ProviderInfo, type Slot, type SlotSetting, Settings } from "./settings";
import { PiSessionSockets } from "./sockets";
import { subagentExtension } from "./subagents";
import { TaskFeed } from "./tasks";
import { VIBEPROXY_PROVIDER, vibeProxy } from "./vibeproxy";
import { createWorkspaceTools, JAVASCRIPT_BACKEND } from "./workspace";

const CLAUDE_MODEL = "claude-opus-5-5";

const OPENCODE_GO = "opencode-go";

/** A pi context with no values that is never cancelled. */
const BACKGROUND = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "[Context ky background]"
});

const PREAMBLE = `You are ky, the user's personal agent. You run in the cloud and are reachable from anywhere; the conversation and your memory persist across devices and restarts.

You are the primary agent: you talk to the user, decide, and delegate. Keep replies short and concrete.

- Small things you do yourself. You have a durable workspace at /workspace (read, write, edit, delete, ls, find, grep; exec runs JavaScript modules with git but no network).
- The user's apps and accounts are behind Executor. So is web search (Exa): use it for lookups, recommendations and reading pages before reaching for a machine.
- Research and other self-contained work that can run in parallel goes to cloud subagents.
- Anything that needs a real computer goes to a machine: driving a browser, logging in to sites, scripts, builds, local files.

When you delegate, give the worker the full context it needs, tell the user what you started, and carry on. Results come back to you as messages; then tell the user what matters in one or two lines.

Changing yourself: your own code is the GitHub repo Yeshwanthyk/ky-durable, with a working copy for you at ~/ky-work/ky-durable on the user's Mac. Changes go through a pull request the user merges; never deploy unmerged work.

When the user asks you to change how you work or look, run one machine task with the change and these steps:
1. cd ~/ky-work/ky-durable (gh repo clone Yeshwanthyk/ky-durable there if missing). git fetch, then git switch -c ky/<short-name> origin/main. pnpm install.
2. Make the change.
3. Run pnpm typecheck and pnpm test, and fix failures.
4. Commit with a clear message, git push -u origin HEAD, and open a pull request with gh pr create (what changed and why).
5. Report the PR URL and a short summary of the diff.
Then tell the user the PR is ready and to say "ship it" or merge it on GitHub.

When the user says to ship it or that they merged it, run one machine task:
1. cd ~/ky-work/ky-durable. If the PR is still open, gh pr merge <number> --squash --delete-branch.
2. git switch main, git pull, pnpm install, then pnpm typecheck and pnpm test.
3. pnpm run deploy. Open pages reload on their own.
4. Check that https://ky.yeshwanth-yk.workers.dev/login answers 200. If not, run npx wrangler rollback -m "ky self-edit rollback" -y and report it.
The deploy restarts you, which cuts off your current turn; the task's report still reaches you after. Never print or commit secrets.`;

/** The user's one agent, one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  /** Claude on the user's Mac, falling back to the fallback slot when the Mac is away. */
  readonly claude = vibeProxy({
    binding: this.env.VIBEPROXY,
    key: this.env.VIBEPROXY_KEY,
    modelId: CLAUDE_MODEL,
    fallback: (context, options) => {
      const { provider, modelId, thinkingLevel } = this.settings.get("fallback");
      const reasoning = thinkingLevel === "off" ? undefined : thinkingLevel;

      return this.opencode.streamSimple(this.model(provider, modelId), context, {
        ...options,
        reasoning,
        apiKey: this.env.OPENCODE_API_KEY
      });
    },
    onChange: () => this.ctx.waitUntil(this.applyMain())
  });
  readonly opencode: Provider = opencodeGoProvider();
  readonly settings = new Settings(
    this.ctx.storage.sql,
    () => this.catalog(),
    () => this.defaultSettings()
  );
  readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    git: createGitClient(),
    backends: [
      new WorkerJavaScriptBackend({
        id: JAVASCRIPT_BACKEND,
        loader: this.env.LOADER,
        root: "/workspace",
        access: "read-write",
        allowGitNetwork: true
      })
    ]
  });
  readonly feed = new TaskFeed(this.ctx.storage.sql);
  readonly memory = new Memory(this.ctx.storage.sql);
  readonly machines = new MachineHub(this.ctx.storage.sql, this.feed, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install({
        name: "playground",
        sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
        tools: createWorkspaceTools(this.workspace)
      });
      this.registry.install(
        executorExtension({ url: this.env.EXECUTOR_URL, token: this.env.EXECUTOR_TOKEN })
      );
      const memory = memoryExtension(this.memory);
      const machines = machineExtension(this.machines, this.feed);
      this.registry.install(memory);
      this.registry.install(machines);
      this.registry.install(
        subagentExtension(this.feed, [memory, machines], () => this.settings.get("subagents"))
      );
      const models = createModels({
        authContext: {
          env: async (name) => (name === "OPENCODE_API_KEY" ? this.env.OPENCODE_API_KEY || undefined : undefined),
          fileExists: async () => false
        }
      });
      models.setProvider(this.claude.provider);
      models.setProvider(this.opencode);

      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          settings: {
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 }
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    // Read on each new session, so they follow the main slot.
    defaults: ((agent: PiAgent) => ({
      get model() {
        const { provider, modelId } = agent.settings.get("main");

        return agent.model(provider, modelId);
      },
      get thinkingLevel() {
        return agent.settings.get("main").thinkingLevel;
      }
    }))(this)
  });

  readonly sockets = new PiSessionSockets(
    this.harness,
    this.registry,
    (tag) => this.ctx.getWebSockets(tag),
    this.feed,
    this.machines,
    this.settings,
    this.env.CF_VERSION_METADATA.id
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.machines.attach(this.harness);
    this.settings.onChange((slot) => {
      if (slot === "main") this.ctx.waitUntil(this.applyMain());
    });
  }

  async onStart(): Promise<void> {
    await this.sockets.reattach();
    await this.claude.check();
    await this.applyMain();
  }

  /** A conversation keeps the model it was created with; move the main one to the main slot. */
  async applyMain(): Promise<void> {
    const main = await this.harness.conversation(ROOT_SESSION);
    await main.configure(this.harness.agentDefaults(), BACKGROUND);
  }

  model(provider: string, modelId: string): Model<Api> {
    if (provider === VIBEPROXY_PROVIDER) return this.claude.model;
    const model = this.opencode.getModels().find((each) => each.id === modelId);

    if (!model) throw new TypeError(`No OpenCode Go model "${modelId}" in pi-ai's catalog.`);

    return model;
  }

  catalog(): ProviderInfo[] {
    const option = (model: Model<Api>, name = model.name): ModelOption => ({
      modelId: model.id,
      name,
      levels: getSupportedThinkingLevels(model),
      ...(model.cost.input > 0 ? { cost: { input: model.cost.input, output: model.cost.output } } : {})
    });

    return [
      {
        id: VIBEPROXY_PROVIDER,
        name: "Claude via VibeProxy",
        connected: this.claude.connected(),
        needs: "the Mac online with VibeProxy",
        models: [option(this.claude.model)]
      },
      {
        id: OPENCODE_GO,
        name: "OpenCode Go",
        connected: Boolean(this.env.OPENCODE_API_KEY),
        needs: "the OPENCODE_API_KEY secret",
        models: [option(this.model(OPENCODE_GO, this.env.KY_MODEL))]
      }
    ];
  }

  defaultSettings(): Record<Slot, SlotSetting> {
    const cheap: SlotSetting = { provider: OPENCODE_GO, modelId: this.env.KY_MODEL, thinkingLevel: "high" };

    return {
      main: this.claude.connected()
        ? { provider: VIBEPROXY_PROVIDER, modelId: CLAUDE_MODEL, thinkingLevel: "medium" }
        : cheap,
      subagents: cheap,
      fallback: cheap
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/login") {
      return request.method === "POST" ? login(request, env) : loginPage();
    }

    if (!(await authenticate(request, env))) {
      if (request.headers.get("Upgrade") === "websocket" || url.pathname.startsWith("/api/")) {
        return new Response("Unauthorized", { status: 401 });
      }

      return Response.redirect(new URL("/login", url).toString(), 302);
    }

    try {
      return (
        (await routeAgentRequest(request, env)) ??
        env.ASSETS.fetch(request)
      );
    } catch (error) {
      console.error("ky request failed", error);

      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
