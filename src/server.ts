import { DurableObject } from "cloudflare:workers";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import type { BrowserWorker } from "@cloudflare/playwright";
import { createRegistry, type Extension, Harness } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { Access, bypassed } from "./access";
import { ChatList, chatActivityExtension } from "./chats";
import { Automations, automationExtension } from "./automations";
import { browseExtension } from "./browse";
import { EXECUTOR_NOT_SET_UP, type ExecutorConfig, executorExtension } from "./executor";
import { download, type FileRow, FileStore } from "./files";
import { History } from "./history";
import { MachineHub, machineExtension, type TaskTokens } from "./machines";
import { Memory, memoryExtension } from "./memory";
import { agentModel, Models, type ModelsBoundary } from "./models";
import { preamble } from "./prompt";
import type { MachineFacts } from "./runner-protocol";
import { ownerRoute, tokenRoute } from "./runners";
import { type NotSetUp, Setup } from "./setup";
import { PiSessionSockets } from "./sockets";
import { Dreaming, DREAM_CRON } from "./dreaming";
import { type ReviewHost, Reviews, Skills, skillsExtension } from "./skills";
import { Soul, soulExtension } from "./soul";
import { Specialists, specialistExtension } from "./specialists";
import { type Spawn, subagentExtension, subagentProgressExtension } from "./subagents";
import { TaskFeed } from "./tasks";
import { Titler } from "./titles";
import { VENDORS, vendorNotSetUp } from "./providers/api-key";
import { VIBEPROXY_NOT_SET_UP } from "./providers/vibeproxy";
import type { Purpose } from "./settings";
import { createWorkspaceTools, JAVASCRIPT_BACKEND } from "./workspace";

export { Vault } from "./vault";

/** A pi context with no values that is never cancelled. */
const BACKGROUND = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "[Context ky background]"
});

/**
 * Everything ky reaches outside the Worker. The worker e2e tests and the local
 * stack (src/tests/stack.ts) put fakes here; nothing inside is replaced.
 */
export type Boundary = ModelsBoundary & {
  /** Browser Rendering, for browse. */
  readonly browser: BrowserWorker;
  /** When this deploy has Executor. */
  readonly executor?: ExecutorConfig;
  /** More tools for every agent, after ky's own. */
  readonly extensions: readonly Extension[];
};

/** What a boundary lacks: the api-key vendors without their secret, and the overlay's add-ons. */
export function notSetUp({ secrets, vibeProxy, executor }: Boundary): readonly NotSetUp[] {
  return [
    ...VENDORS.flatMap((vendor) => (secrets(vendor.secret) ? [] : [vendorNotSetUp(vendor)])),
    ...(vibeProxy ? [] : [VIBEPROXY_NOT_SET_UP]),
    ...(executor ? [] : [EXECUTOR_NOT_SET_UP])
  ];
}

/** The user's one agent, one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  readonly boundary = this.boundaryFor(this.env);
  /** When a provider that can go away comes or goes, the chats move to what main resolves to now. */
  readonly models = new Models(this.ctx.storage.sql, this.boundary, () => this.ctx.waitUntil(this.applyMain()));
  /** ky's repo and address, for self-edits. */
  readonly setup = new Setup(this.ctx.storage.sql);
  readonly workspace = new Workspace({
    // SAFETY: this is the storage DurableObjectStorageLike describes; the typings only disagree on sql.exec's row generic.
    storage: this.ctx.storage as DurableObjectStorageLike,
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
  readonly files = new FileStore(this.ctx.storage.sql);
  /** Its summaries are written on the background model, as notes come in. */
  readonly memory = new Memory(this.ctx.storage.sql, (system, messages) =>
    this.models.ask("background", system, messages, { timeoutMs: 120_000, maxTokens: 8_000 })
  );
  readonly skills = new Skills(this.ctx.storage.sql);
  /** SOUL.md, ky's persona. */
  readonly soul = new Soul(this.ctx.storage.sql);
  /** The user's standing bots, like @engineer. */
  readonly specialists = new Specialists(this.ctx.storage.sql);
  /** Skill reviews and dreams: background conversations that remember but may only tend skills and memory. */
  readonly reviews = new Reviews(this.ctx.storage.sql);
  readonly chats = new ChatList(this.ctx.storage.sql);
  /** Every message of the main chat and the side chats, searchable. */
  readonly history = new History(
    this.ctx.storage.sql,
    (session) => this.isChat(session),
    (session) => this.chats.list().find((chat) => chat.session === session)?.title || "untitled"
  );
  readonly titler = new Titler((system, text) => this.models.complete("background", system, text));
  readonly machines = new MachineHub(
    this.ctx.storage.sql,
    this.feed,
    (tag) => this.ctx.getWebSockets(tag),
    this.files,
    this.taskTokens()
  );
  /** Starts a subagent from outside a tool call; set once pi opens, which every run's commit waits for. */
  #spawn: Spawn | undefined;
  readonly automations = new Automations(this.ctx.storage.sql, {
    feed: this.feed,
    machines: this.machines,
    chats: this.chats,
    models: this.models,
    runtime: {
      spawn: (tx, owner, request) => this.#spawn!(tx, owner, request),
      commit: async (change) => (await this.harness.pi()).commit(change, BACKGROUND),
      // An outside commit does not wake pi, and in agents 0.26 onStart, which books a wake for every
      // session with live tasks, is the only way to. Replace it once PiHarness exposes a wake.
      wake: () => this.harness.onStart({ props: undefined }),
      // As the UI's Stop does.
      abort: async (session) => {
        await this.harness.session(session).abort();
      }
    },
    dream: { cron: DREAM_CRON, run: () => this.ctx.waitUntil(this.dreaming.run()) }
  });
  readonly registry = createRegistry();
  /** Where skill reviews and dreams run and report. */
  readonly #background: ReviewHost = {
    conversation: (session) => this.harness.conversation(session),
    feed: this.feed,
    later: (work) => this.ctx.waitUntil(work),
    context: BACKGROUND,
    model: () => agentModel(this.models.resolve("background").choice)
  };
  readonly dreaming = new Dreaming(this.ctx.storage.sql, {
    memory: this.memory,
    skills: this.skills,
    reviews: this.reviews,
    host: this.#background,
    create: async () => {
      const { id } = await this.harness.sessions.create();
      await this.#configure(id, "background");

      return id;
    }
  });
  /** Subagents browse; the main agent delegates it, since a page can take a minute. */
  readonly browse = browseExtension(this.boundary.browser);
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      // SOUL.md comes first, so the preamble's rules follow the persona and win over it.
      const soul = soulExtension(this.soul);
      this.registry.install(soul);
      this.registry.install({
        name: "playground",
        sections: [
          {
            key: "preamble",
            render: () => preamble({ executor: Boolean(this.boundary.executor), selfEdit: this.setup.selfEdit() }),
            tag: false
          }
        ],
        tools: createWorkspaceTools(this.workspace)
      });

      if (this.boundary.executor) this.registry.install(executorExtension(this.boundary.executor));
      this.registry.install(this.browse);

      for (const extension of this.boundary.extensions) this.registry.install(extension);

      const chat = (session: string) => this.isChat(session);
      this.registry.install(skillsExtension(this.skills, this.reviews, this.#background, chat));

      // Reviews and dreams remember too: a review fork keeps the memory its chat showed, and a dream wakes with it.
      const memory = memoryExtension(this.memory, this.history, (session) => chat(session) || this.reviews.has(session));
      const machines = machineExtension(this.machines, this.feed);
      const automations = automationExtension(this.automations, () => this.models.resolve("worker").choice);
      this.registry.install(memory);
      this.registry.install(machines);
      this.registry.install(automations);

      const specialists = specialistExtension(this.specialists, this.feed, chat, (feedId) => this.automations.wanted(feedId));
      this.registry.install(specialists.extension);
      this.registry.install(specialists.manage);

      const subagents = subagentExtension(
        this.feed,
        [soul, memory, machines, automations, specialists.manage],
        () => this.models.resolve("worker").choice,
        (feedId) => this.automations.wanted(feedId),
        {
          store: this.specialists,
          tools: specialists,
          // Specialists keep memory (to search it), machines, and the subagent tool (to ask a peer).
          remove: [soul, automations, specialists.manage],
          model: (own) => this.models.worker(own)
        }
      );

      this.#spawn = subagents.spawn;
      this.registry.install(subagents.extension);
      this.registry.install(subagentProgressExtension(this.feed));
      this.registry.install(chatActivityExtension(this.chats));

      return Harness.open(
        storage,
        {
          models: this.models.registry,
          registry: this.registry,
          settings: {
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
            // Reports from delegated work queue while the main agent is busy; place them all at once.
            steeringMode: "all",
            followUpMode: "all"
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    // Read on each new session, so they follow the main purpose.
    defaults: ((models: Models) => ({
      get model() {
        return models.resolve("main").model;
      },
      get thinkingLevel() {
        return models.resolve("main").choice.thinkingLevel;
      }
    }))(this.models)
  });

  readonly sockets = new PiSessionSockets(
    this.harness,
    this.registry,
    (tag) => this.ctx.getWebSockets(tag),
    this.feed,
    this.machines,
    this.files,
    this.models,
    this.chats,
    this.skills,
    this.soul,
    this.specialists,
    this.memory,
    this.automations,
    this.setup,
    notSetUp(this.boundary),
    () => this.newChat(),
    this.env.CF_VERSION_METADATA.id
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness)
    .use(this.automations.scheduler);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.machines.attach(this.harness, (task) => this.automations.wanted(task));
    this.#nameThings();
    this.models.settings.onChange((purpose) => {
      if (purpose === "main") this.ctx.waitUntil(this.applyMain());
    });
    this.memory.onChange(() => this.ctx.waitUntil(this.memory.compress()));
  }

  /** The main chat or a side chat, as against a subagent, a review or a dream. */
  isChat(session: string): boolean {
    return session === ROOT_SESSION || this.chats.has(session);
  }

  /** The hub's task tokens: the Vault's. Runs as a field initializer, so only ctx and env are set; tests wrap it. */
  taskTokens(): TaskTokens {
    const vault = () => this.env.Vault.getByName("owner");

    return {
      issue: (task) => vault().issue("task", task),
      revoke: (task) => vault().revoke("task", task),
      revokeAll: (tasks) => vault().revokeAll("task", tasks)
    };
  }

  /**
   * Production's boundary: Workers AI, the Worker's secrets, the internet, Browser Rendering, and VibeProxy's tunnel
   * and Executor when this deploy has their vars and secrets (wrangler.local.example.jsonc).
   */
  boundaryFor(env: Env): Boundary {
    const { VIBEPROXY: binding, VIBEPROXY_ORIGIN: origin, VIBEPROXY_KEY: key, EXECUTOR_URL: url, EXECUTOR_TOKEN: token } = env;

    return {
      ai: env.AI,
      secrets: (name) => env[name],
      fetch: (input, init) => fetch(input, init),
      vibeProxy: binding && origin && key ? { binding, origin, key } : undefined,
      browser: env.BROWSER,
      executor: url && token ? { url, token } : undefined,
      extensions: []
    };
  }

  async onStart(): Promise<void> {
    await this.sockets.reattach();
    // Reports a restart cut off between a task's turn ending and its conversation hearing of it,
    // posted once the start is over: a submit waits for the harness, which starts after this.
    this.ctx.waitUntil(this.machines.post());
    // Task tokens whose revoke a failure or a restart lost.
    this.ctx.waitUntil(this.machines.sweepTokens());
    await this.models.probe();
    await this.applyMain();
    await this.automations.recover();
    // Summaries a restart or a failed call left unwritten.
    this.ctx.waitUntil(this.memory.compress());
  }

  /** Record a file a machine task shared; null, or why it was refused. */
  async attachFile(file: Omit<FileRow, "created_at">): Promise<string | null> {
    const task = this.feed.get(file.task);

    if (!task || task.kind !== "machine") return `No machine task ${file.task}.`;
    this.files.record(file);

    return null;
  }

  /**
   * A runner paired as `machine`, with the pairing id its new token names;
   * a runner already connected under that name has an old token, so it goes.
   * Returns the pairing replaced, whose token the caller revokes.
   */
  pairMachine(machine: string, facts: MachineFacts, pairing: string): string | null {
    const previous = this.machines.paired(machine, facts, pairing);
    this.sockets.revokeRunner(machine, `${machine} was paired again, so this runner's token no longer works; pair it again.`);

    return previous;
  }

  /** Forget a machine the user removed; its pairing, whose token the caller revokes, or undefined if ky never knew it. */
  async removeMachine(machine: string): Promise<{ pairing: string | null } | undefined> {
    if (this.machines.machine(machine) === undefined) return undefined;
    this.sockets.revokeRunner(machine, `${machine} was removed from ky; pair it again to use it.`);

    return { pairing: await this.machines.remove(machine) };
  }

  /** A conversation keeps the model it was created with; move the main one and the side chats to the main slot. */
  async applyMain(): Promise<void> {
    for (const session of [ROOT_SESSION, ...this.chats.list().map((chat) => chat.session)]) {
      await this.#configure(session);
    }
  }

  /** Set a top-level conversation up like the main one, on `purpose`'s model. */
  async #configure(session: string, purpose: Purpose = "main"): Promise<void> {
    const conversation = await this.harness.conversation(session);
    await conversation.configure(
      {
        ...this.harness.agentDefaults(),
        ...agentModel(this.models.resolve(purpose).choice),
        extensions: { remove: [this.browse] }
      },
      BACKGROUND
    );
  }

  /** A side chat: a new top-level conversation set up like the main one, sharing its memory. */
  async newChat(): Promise<string> {
    const { id } = await this.harness.sessions.create();
    await this.#configure(id);
    this.chats.add(id);

    return id;
  }

  /** The background model renames chats and tasks once it answers, unless they were renamed first. */
  #nameThings(): void {
    const later = (work: () => Promise<void>) => this.ctx.waitUntil(work());

    this.chats.onNamed((session, text) =>
      later(async () => {
        const was = this.chats.list().find((chat) => chat.session === session)?.title;
        const title = await this.titler.title(text);

        if (was !== undefined && title) this.chats.retitle(session, was, title);
      })
    );
    this.feed.nameWith({
      title: (id, text) =>
        later(async () => {
          const was = this.feed.get(id)?.title;
          const title = await this.titler.title(text);

          if (title && was !== undefined && this.feed.get(id)?.title === was) this.feed.update(id, { title });
        }),
      summary: (id, text) =>
        later(async () => {
          const was = this.feed.get(id);
          const summary = await this.titler.summary(text);
          const now = this.feed.get(id);

          if (summary && was && now?.summary === was.summary && now.status === was.status) {
            this.feed.update(id, { summary });
          }
        })
    });
  }
}

/**
 * ky's Worker, with Access checked by `access`: production's fetches the team's keys, the stack's
 * (src/tests/stack.ts) a fake Access's.
 */
export function worker(access: Access) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);

      // What Access lets through signed out: runners and their tasks, which sign in with their own tokens
      // (src/runners.ts) and never with the user's, and the manifest and icons iOS fetches without a cookie.
      if (bypassed(url.pathname)) return tokenRoute(request, env, url) ?? env.ASSETS.fetch(request);

      const refused = await access.refuse(request, env);

      if (refused) return refused;

      const owner = ownerRoute(request, env, url);

      if (owner) return owner;

      const file = /^\/files\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];

      if (file && request.method === "GET") return download(request, env.FILES, file);

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
}

export default worker(new Access());
