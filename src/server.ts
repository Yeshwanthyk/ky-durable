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
import { authenticate, loginPage, login } from "./auth";
import { ChatList } from "./chats";
import { Automations, automationExtension } from "./automations";
import { browseExtension } from "./browse";
import { type ExecutorConfig, executorExtension } from "./executor";
import { download, type FileRow, FileStore, upload } from "./files";
import { MachineHub, machineExtension } from "./machines";
import { Memory, memoryExtension } from "./memory";
import { CLAUDE_MODEL, CLAUDE_SMALL, type Endpoint, kyDefaults, Models, opencodeGo } from "./models";
import { preamble } from "./prompt";
import { PiSessionSockets } from "./sockets";
import { Dreaming, DREAM_CRON } from "./dreaming";
import { type ReviewHost, Reviews, Skills, skillsExtension } from "./skills";
import { Soul, soulExtension } from "./soul";
import { type Spawn, subagentExtension, subagentProgressExtension } from "./subagents";
import { TaskFeed } from "./tasks";
import { Titler } from "./titles";
import { vibeProxy } from "./vibeproxy";
import { createWorkspaceTools, JAVASCRIPT_BACKEND } from "./workspace";

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
export type Boundary = {
  /** The cloud models: subagents, and the main agent while the Mac is away. Its first model is the default. */
  readonly cloud: Endpoint;
  /** The tunnel to VibeProxy on the user's Mac. */
  readonly vibeProxy: Pick<Fetcher, "fetch">;
  /** How long a VibeProxy probe's answer is reused; vibeproxy.ts's default when unset. */
  readonly probeTtlMs?: number;
  /** Browser Rendering, for browse. */
  readonly browser: BrowserWorker;
  readonly executor: ExecutorConfig;
  /** More tools for every agent, after ky's own. */
  readonly extensions: readonly Extension[];
};

/** The user's one agent, one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  readonly boundary = this.boundaryFor(this.env);
  /** Claude on the user's Mac. While the Mac is away, models.ts runs its turns on the fallback slot. */
  readonly claude = vibeProxy({
    binding: this.boundary.vibeProxy,
    origin: this.env.VIBEPROXY_ORIGIN,
    key: this.env.VIBEPROXY_KEY,
    modelIds: [CLAUDE_MODEL, CLAUDE_SMALL],
    probeTtlMs: this.boundary.probeTtlMs,
    onChange: () => this.ctx.waitUntil(this.applyMain())
  });
  readonly models = new Models(
    this.ctx.storage.sql,
    [this.claude, this.boundary.cloud],
    kyDefaults({ provider: this.boundary.cloud.provider.id, modelId: this.boundary.cloud.models[0]!.id })
  );
  readonly #preamble = preamble({ repo: this.env.KY_REPO, workCopy: this.env.KY_WORK_COPY, url: this.env.KY_URL });
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
  readonly memory = new Memory(this.ctx.storage.sql);
  readonly skills = new Skills(this.ctx.storage.sql);
  /** SOUL.md, ky's persona. */
  readonly soul = new Soul(this.ctx.storage.sql);
  /** Skill reviews and dreams: background conversations that remember but may only tend skills and memory. */
  readonly reviews = new Reviews(this.ctx.storage.sql);
  readonly chats = new ChatList(this.ctx.storage.sql);
  readonly titler = new Titler((system, text) => this.models.complete("titles", system, text));
  readonly machines = new MachineHub(
    this.ctx.storage.sql,
    this.feed,
    (tag) => this.ctx.getWebSockets(tag),
    this.files
  );
  /** Starts a subagent from outside a tool call; set once pi opens, which every run's commit waits for. */
  #spawn: Spawn | undefined;
  readonly automations = new Automations(this.ctx.storage.sql, {
    feed: this.feed,
    machines: this.machines,
    chats: this.chats,
    settings: this.models.settings,
    catalog: () => this.models.catalog(),
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
    context: BACKGROUND
  };
  readonly dreaming = new Dreaming(this.ctx.storage.sql, {
    memory: this.memory,
    skills: this.skills,
    reviews: this.reviews,
    host: this.#background,
    create: async () => {
      const { id } = await this.harness.sessions.create();
      await this.#configureMain(id);

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
        sections: [{ key: "preamble", render: () => this.#preamble, tag: false }],
        tools: createWorkspaceTools(this.workspace)
      });
      this.registry.install(executorExtension(this.boundary.executor));
      this.registry.install(this.browse);

      for (const extension of this.boundary.extensions) this.registry.install(extension);

      const chat = (session: string) => session === ROOT_SESSION || this.chats.has(session);
      this.registry.install(skillsExtension(this.skills, this.reviews, this.#background, chat));

      // Reviews and dreams remember too: a review fork keeps the memory its chat showed, and a dream wakes with it.
      const memory = memoryExtension(this.memory, (session) => chat(session) || this.reviews.has(session));
      const machines = machineExtension(this.machines, this.feed);
      const automations = automationExtension(this.automations, () => this.models.settings.get("subagents"));
      this.registry.install(memory);
      this.registry.install(machines);
      this.registry.install(automations);

      const subagents = subagentExtension(
        this.feed,
        [soul, memory, machines, automations],
        () => this.models.settings.get("subagents"),
        (feedId) => this.automations.wanted(feedId)
      );

      this.#spawn = subagents.spawn;
      this.registry.install(subagents.extension);
      this.registry.install(subagentProgressExtension(this.feed));

      return Harness.open(
        storage,
        {
          models: this.models.registry(),
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
    // Read on each new session, so they follow the main slot.
    defaults: ((models: Models) => ({
      get model() {
        const { provider, modelId } = models.settings.get("main");

        return models.model(provider, modelId);
      },
      get thinkingLevel() {
        return models.settings.get("main").thinkingLevel;
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
    this.automations,
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
    this.models.settings.onChange((slot) => {
      if (slot === "main") this.ctx.waitUntil(this.applyMain());
    });
  }

  /** Production's boundary: OpenCode Go, the Mac's tunnel, Browser Rendering and Executor. */
  boundaryFor(env: Env): Boundary {
    return {
      cloud: opencodeGo(env.OPENCODE_API_KEY, env.KY_MODEL),
      vibeProxy: env.VIBEPROXY,
      browser: env.BROWSER,
      executor: { url: env.EXECUTOR_URL, token: env.EXECUTOR_TOKEN },
      extensions: []
    };
  }

  async onStart(): Promise<void> {
    await this.sockets.reattach();
    // Reports a restart cut off between a task's turn ending and its conversation hearing of it,
    // posted once the start is over: a submit waits for the harness, which starts after this.
    this.ctx.waitUntil(this.machines.post());
    await this.claude.reachable();
    await this.applyMain();
    await this.automations.recover();
  }

  /** Record a file a machine task shared; null, or why it was refused. */
  async attachFile(file: Omit<FileRow, "created_at">): Promise<string | null> {
    const task = this.feed.get(file.task);

    if (!task || task.kind !== "machine") return `No machine task ${file.task}.`;
    this.files.record(file);

    return null;
  }

  /** A conversation keeps the model it was created with; move the main one and the side chats to the main slot. */
  async applyMain(): Promise<void> {
    for (const session of [ROOT_SESSION, ...this.chats.list().map((chat) => chat.session)]) {
      await this.#configureMain(session);
    }
  }

  async #configureMain(session: string): Promise<void> {
    const conversation = await this.harness.conversation(session);
    await conversation.configure(
      { ...this.harness.agentDefaults(), extensions: { remove: [this.browse] } },
      BACKGROUND
    );
  }

  /** A side chat: a new top-level conversation set up like the main one, sharing its memory. */
  async newChat(): Promise<string> {
    const { id } = await this.harness.sessions.create();
    await this.#configureMain(id);
    this.chats.add(id);

    return id;
  }

  /** The titles model renames chats and tasks once it answers, unless they were renamed first. */
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

    if (url.pathname === "/api/files") {
      return upload(request, env.FILES, (file) => env.PiAgent.getByName("me").attachFile(file));
    }

    const file = /^\/api\/files\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];

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
