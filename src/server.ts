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
import type { ArchivedFile, End, Manifest, Restored } from "./archive";
import { backupRoute, Backups, type Page, type Plan } from "./backup";
import { BACKGROUND } from "./background";
import { ChatList, chatActivityExtension } from "./chats";
import { Automations, automationTools, TaskFeed } from "./automations/wiring";
import { browseExtension } from "./browse";
import { ExecutorLink, executorExtension } from "./executor";
import { download, type FileRow, FileStore } from "./files";
import { History } from "./history";
import type { SandboxNow } from "./cloud";
import { saveKey, type Sandbox, type SandboxChange, type SandboxDraft, Sandboxes } from "./sandboxes";
import { sandboxRoute } from "./sandbox-routes";
import { type CloudHook, type MachineFacts, type TaskTokens } from "./machines/contract";
import { MachineHub, machineTools } from "./machines/wiring";
import { DREAM_CRON, Dreaming, dreamingTools, Memory, Soul } from "./dreaming/wiring";
import { agentModel, Models, type ModelsBoundary } from "./models";
import { preamble, type PromptConfig } from "./prompt";
import { machineSubject, ownerRoute, tokenRoute } from "./runners";
import { ASK_TTL_MS } from "./peers/contract";
import { deliver, peerAnswer, PeerAsks, type PeerDesk, peerQuestion, peerRoute, Peers, sweepPeers } from "./peers/peers";
import { type NotSetUp, Setup } from "./setup";
import { PiSessionSockets } from "./sockets";
import { Subscriptions } from "./subscriptions";
import { type ReviewHost, runInFeed, type Spawn } from "./skills/contract";
import { delegationTools, Reviews, Skills, skillTools, type SkillsWiring, Specialists } from "./skills/wiring";
import { seed } from "./seeds";
import { GroupChats, GroupDesk } from "./peers/group";
import { peerTools } from "./peers/wiring";
import { Titler } from "./titles";
import { RunnerPipe } from "./pipe";
import { VIBEPROXY_NOT_SET_UP, VIBEPROXY_PORT, VIBEPROXY_PROVIDER } from "./providers/vibeproxy";
import type { Purpose } from "./settings";
import { createWorkspaceTools, JAVASCRIPT_BACKEND } from "./workspace";

import type { Vault } from "./vault";

export { Vault } from "./vault";

export { CloudMachine } from "./cloud";

export { GithubProxy } from "./github";

/**
 * Everything ky reaches outside the Worker. The worker e2e tests and the local
 * stack (src/tests/stack.ts) put fakes here; nothing inside is replaced.
 */
export type Boundary = ModelsBoundary & {
  /** Browser Rendering, for browse. */
  readonly browser: BrowserWorker;
  /** How requests reach Executor, once the user connects it in Settings; global fetch unless set. */
  readonly executorFetch?: typeof fetch;
  /** Seed the starter skills, specialist and automations on the first start (src/seeds.ts). */
  readonly seeds: boolean;
  /** How requests reach other people's kys (src/peers/peers.ts); global fetch unless set. */
  readonly peerFetch?: typeof fetch;
  /** More tools for every agent, after ky's own. */
  readonly extensions: readonly Extension[];
};

/** What a deploy lacks: VibeProxy unless a paired machine shares it (one of `providers`). Executor is connected in Settings instead. */
export function notSetUp({ vibeProxy }: Boundary, providers: readonly string[] = []): readonly NotSetUp[] {
  return vibeProxy.tunnel || providers.includes(VIBEPROXY_PROVIDER) ? [] : [VIBEPROXY_NOT_SET_UP];
}

/** The user's one agent, one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  readonly boundary = this.boundaryFor(this.env);
  readonly feed = new TaskFeed(this.ctx.storage.sql);
  readonly files = new FileStore(this.ctx.storage.sql);
  /** ky's sandboxes, its own machines in Cloudflare (src/sandboxes.ts). */
  readonly sandboxes = new Sandboxes(this.ctx.storage.sql);
  /** The user's Claude and ChatGPT logins, in the Vault, for Settings and the runs that are handed them. */
  readonly subscriptions = new Subscriptions(() => this.env.Vault.getByName("owner"));
  readonly machines = new MachineHub(
    this.ctx.storage.sql,
    this.feed,
    (tag) => this.ctx.getWebSockets(tag),
    this.files,
    this.taskTokens(),
    (agent) => this.subscriptions.creds(agent),
    this.sandboxes
  );
  /** Requests to ports on the user's machines, over their runners' sockets. */
  readonly pipe = new RunnerPipe((tag) => this.ctx.getWebSockets(tag));
  readonly models = new Models(this.ctx.storage.sql, this.boundary, this.env.Vault.getByName("owner"), this.machines, this.pipe);
  /** Other people's kys this one is paired with (src/peers/peers.ts). */
  readonly peers = new Peers(this.ctx.storage.sql);
  /** The questions this ky and its peers ask each other. */
  readonly peerAsks = new PeerAsks(this.ctx.storage.sql);
  /** ky's repo and address, for self-edits. */
  readonly setup = new Setup(this.ctx.storage.sql);
  /** What the peer tool and Settings › Peers work with. */
  readonly peerDesk: PeerDesk = {
    peers: this.peers,
    asks: this.peerAsks,
    vault: () => this.peerVault(),
    fetch: this.boundary.peerFetch ?? ((input, init) => fetch(input, init)),
    origin: () => this.setup.origin(),
    tell: async (session, content, requestId) => {
      const conversation = await this.harness.conversation(session ?? ROOT_SESSION);
      await conversation.submit({ type: "input", content, whenBusy: "steer", requestId }, BACKGROUND);
    },
    sweepAt: (at) => this.ctx.waitUntil(this.automations.sweepPeersAt(at))
  };
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
  /** Its summaries are written on the background model, as notes come in. */
  readonly memory = new Memory(this.ctx.storage.sql, (system, messages) =>
    this.models.ask("background", system, messages, { timeoutMs: 120_000, maxTokens: 8_000 })
  );
  readonly skills = new Skills(this.ctx.storage.sql);
  /** SOUL.md, ky's persona. */
  readonly soul = new Soul(this.ctx.storage.sql);
  /** The user's standing bots, like @engineer. */
  readonly specialists = new Specialists(this.ctx.storage.sql);
  /** Which specialists are in which chats, and their seats there. */
  readonly groups = new GroupChats(this.ctx.storage.sql, this.specialists);
  /** Skill reviews and dreams: background conversations that remember but may only tend skills and memory. */
  readonly reviews = new Reviews(this.ctx.storage.sql);
  readonly chats = new ChatList(this.ctx.storage.sql);
  /** Every message of the main chat and the side chats, searchable. */
  readonly history = new History(
    this.ctx.storage.sql,
    (session) => this.isChat(session),
    (session) => this.chats.list().find((chat) => chat.session === session)?.title || "untitled"
  );
  /** Its SQLite, dumped for a backup and swapped whole by a restore. */
  readonly backups = new Backups(this.ctx.storage);
  readonly titler = new Titler((system, text) => this.models.complete("background", system, text));
  /** @-mentions and group chats: who answers a user's message, and the specialists' own replies. Routing is on the background model. */
  readonly group = new GroupDesk({
    store: this.groups,
    specialists: this.specialists,
    feed: this.feed,
    conversation: (session) => this.harness.conversation(session),
    complete: (system, text) => this.models.complete("background", system, text),
    answered: (session) => this.chats.answered(session),
    context: BACKGROUND
  });
  /** The user's Executor, connected in Settings and kept in the Vault; its tools are installed while it is. */
  readonly executor = new ExecutorLink(() => this.env.Vault.getByName("owner"), this.ctx.id.name ?? "me", this.boundary.executorFetch);
  /** Bumped by every connect and disconnect, so an install read before one never lands after it. */
  #executorGeneration = 0;
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
    dream: { cron: DREAM_CRON, run: () => this.ctx.waitUntil(this.dreaming.run()) },
    peers: () => this.sweepPeers()
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
    },
    checkIns: async () => ({
      ...this.automations.checkIns(),
      waiting: (await this.automations.list(false))
        .filter((each) => each.created_by === "dream" && each.status === "active")
        .map((each) => `- ${new Date(each.at ?? 0).toISOString()} "${each.title}"`)
    })
  });
  /** Subagents browse; the main agent delegates it, since a page can take a minute. */
  readonly browse = browseExtension(this.boundary.browser);
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const chat = (session: string) => this.isChat(session);

      // Each domain makes its tools in its folder's wiring.ts; they are installed here, in this order.
      const { soul, memory } = dreamingTools({ soul: this.soul, memory: this.memory, history: this.history, reviews: this.reviews, chat });

      const skilling: SkillsWiring = {
        skills: this.skills,
        reviews: this.reviews,
        specialists: this.specialists,
        feed: this.feed,
        models: this.models,
        automations: this.automations,
        background: this.#background,
        chat
      };

      // SOUL.md comes first, so the preamble's rules follow the persona and win over it.
      this.registry.install(soul);
      this.registry.install({
        name: "playground",
        sections: [
          {
            key: "preamble",
            render: () =>
              preamble({
                executor: this.registry.snapshot().extension("executor") !== undefined,
                cloud: this.machines.cloudOn(),
                ...this.#selfEditing()
              }),
            tag: false
          }
        ],
        tools: createWorkspaceTools(this.workspace)
      });

      await this.#installExecutor();
      this.registry.install(this.browse);

      for (const extension of this.boundary.extensions) this.registry.install(extension);

      this.registry.install(skillTools(skilling));

      const { machines } = machineTools({ machines: this.machines, feed: this.feed });
      const { automations, checkInGuard } = automationTools({ automations: this.automations, models: this.models, reviews: this.reviews });

      this.registry.install(memory);
      this.registry.install(machines);
      this.registry.install(automations);

      const { specialists, subagents, spawn, progress } = delegationTools(skilling, { soul, memory, machines, automations });
      this.registry.install(specialists.extension);
      this.registry.install(specialists.manage);

      this.#spawn = spawn;
      this.registry.install(subagents);

      // A seat in a chat cannot ask or start other agents: replies never lead to more replies.
      const { seat, peer } = peerTools({ group: this.group, peerDesk: this.peerDesk, models: this.models, chat }, [soul, automations, specialists.manage, subagents]);
      this.registry.install(seat);
      this.registry.install(progress);
      this.registry.install(checkInGuard);
      this.registry.install(chatActivityExtension(this.chats));
      this.registry.install(peer);

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
    this.subscriptions,
    this.peerDesk,
    this.pipe,
    this.executor,
    this.chats,
    this.skills,
    this.soul,
    this.specialists,
    this.group,
    this.groups,
    this.memory,
    this.automations,
    this.setup,
    () => notSetUp(this.boundary, this.models.catalog().map((provider) => provider.id)),
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
    this.machines.cloud = this.cloudHook();

    // Before anything asks: the pair route asks whether a name is a sandbox's.
    if (this.machines.cloud) this.sandboxes.migrate();
    this.#nameThings();
    this.models.settings.onChange((purpose) => {
      if (purpose === "main") this.ctx.waitUntil(this.applyMain());
    });
    // When the providers change, the chats move to what main resolves to now.
    this.models.onChange(() => this.ctx.waitUntil(this.applyMain()));
    this.memory.onChange(() => this.ctx.waitUntil(this.memory.compress()));
    this.executor.onChange(async () => {
      await this.#installExecutor();
      await this.sockets.broadcastExecutor().catch((error) => console.warn("executor not sent", error));
    });
  }

  /** Install Executor's tools on the connection the Vault has now, or remove them without one. */
  async #installExecutor(): Promise<void> {
    const generation = ++this.#executorGeneration;
    const config = await this.executor.config();

    // A connect or disconnect since has its own install.
    if (generation !== this.#executorGeneration) return;

    const installed = this.registry.snapshot().extension("executor");

    if (config) this.registry.install(executorExtension(config));
    else if (installed) this.registry.uninstall(installed);
  }

  /** The main chat or a side chat, as against a subagent, a review or a dream. */
  isChat(session: string): boolean {
    return session === ROOT_SESSION || this.chats.has(session);
  }

  /** The sandboxes, on a deploy `ky deploy` gave containers (KY_CLOUD); tests replace their containers. */
  cloudHook(): CloudHook | undefined {
    if (!this.env.KY_CLOUD) return undefined;

    return {
      wake: (machine) => {
        const id = this.sandboxes.named(machine)?.id;

        if (id) this.ctx.waitUntil(this.env.CloudMachine.getByName(id).wake(id, this.setup.origin() ?? undefined));
      }
    };
  }

  /** Whether the sandbox `id` has work: an open task or a command waiting. Its alarm keeps it awake while it has. */
  cloudBusy(id: string): boolean {
    const sandbox = this.sandboxes.get(id);

    return sandbox !== undefined && sandbox.deletedAt === null && this.machines.busy(sandbox.name);
  }

  /** What the sandbox `id`'s alarm needs: the name it pairs as, its idle minutes, whether it has work; null once deleted. */
  sandboxNow(id: string): SandboxNow {
    const sandbox = this.sandboxes.get(id);

    if (!sandbox || sandbox.deletedAt !== null) return null;

    return { name: sandbox.name, idleMinutes: sandbox.idleMinutes, busy: this.machines.busy(sandbox.name) };
  }

  /** Whether `name` is a live sandbox's, which no runner may pair as or unpair. */
  isSandbox(name: string): boolean {
    return this.sandboxes.named(name) !== undefined;
  }

  /**
   * The repos the sandbox `id` may reach on GitHub: its own, `all` the picked ones, or none (null)
   * once it is deleted. For the github.internal handler, which knows the calling sandbox's id.
   */
  reposFor(id: string): readonly string[] | "all" | null {
    return this.sandboxes.reposFor(id);
  }

  /** The live sandboxes and the kept disks, for Settings. */
  sandboxList() {
    return { live: this.sandboxes.live(), kept: this.sandboxes.kept() };
  }

  /** A new sandbox, listed at once; it starts when a task wakes it. Throws why not. */
  createSandbox(draft: SandboxDraft): Sandbox {
    if (!this.machines.cloud) throw new Error("This deploy has no containers: `ky deploy` adds them on Workers Paid.");
    const sandbox = this.sandboxes.create(draft, (name) => this.machines.machine(name) !== undefined);

    this.machines.listSandboxes();

    return sandbox;
  }

  /** Change a live sandbox's repos, idle minutes, or make it the default. Throws why not. */
  changeSandbox(id: string, change: SandboxChange): Sandbox {
    const sandbox = this.sandboxes.change(id, change);

    this.machines.changed();

    return sandbox;
  }

  /**
   * Delete a live sandbox, keeping its disk: from here it is no machine, its tasks end, and its
   * runner is refused. Returns its name and pairing, whose token the caller revokes before it has
   * the container save and stop.
   */
  async deleteSandbox(id: string): Promise<{ name: string; pairing: string | null }> {
    // First, before any await: from here no start pairs as it, and no wake starts it.
    const { name } = this.sandboxes.delete(id);
    const removed = await this.removeMachine(name);

    return { name, pairing: removed?.pairing ?? null };
  }

  /** Forget a kept disk's row; the caller stops its container, if one still runs, and deletes its save. */
  forgetKeptDisk(id: string): void {
    this.sandboxes.forget(id);
  }

  /** ky's repo and address for the preamble, once Settings has the repo, and the sandbox its tasks go to. */
  #selfEditing(): Pick<PromptConfig, "selfEdit" | "selfEditOn"> {
    const selfEdit = this.setup.selfEdit();

    return selfEdit ? { selfEdit, selfEditOn: this.machines.sandboxFor(selfEdit.repo) } : {};
  }

  /** ky's own repo, owner/name, as Settings has it: the only one GitHub tools merge in or roll back (src/github-tools.ts). */
  selfEditRepo(): string | null {
    return this.setup.view().repo;
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
   * Production's boundary: Workers AI, the internet, Browser Rendering, and VibeProxy's tunnel
   * when this deploy has its vars and secret (wrangler.local.example.jsonc).
   */
  boundaryFor(env: Env): Boundary {
    const { VIBEPROXY: binding, VIBEPROXY_ORIGIN: origin, VIBEPROXY_KEY: key } = env;

    return {
      ai: env.AI,
      fetch: (input, init) => fetch(input, init),
      vibeProxy: { port: VIBEPROXY_PORT, key: key || undefined, tunnel: binding && origin && key ? { binding, origin } : undefined },
      browser: env.BROWSER,
      extensions: [],
      seeds: true
    };
  }

  async onStart(): Promise<void> {
    if (this.machines.cloud) {
      const { stale, clashes } = this.machines.listSandboxes();

      // Cloud machines a restore left listed with no sandbox now.
      for (const machine of stale) this.ctx.waitUntil(this.#removeStale(machine));

      if (clashes.length > 0) console.warn(`the sandboxes ${clashes.join(", ")} share a paired computer's name, which keeps it: rename the computer, or delete the sandbox and add it again`);
      this.ctx.waitUntil(this.#dropLostDisks());
    }

    await this.sockets.reattach();
    // Reports a restart cut off between a task's turn ending and its conversation hearing of it,
    // posted once the start is over: a submit waits for the harness, which starts after this.
    this.ctx.waitUntil(this.machines.post());
    // Task tokens whose revoke a failure or a restart lost.
    this.ctx.waitUntil(this.machines.sweepTokens());
    await this.applyMain();
    await this.automations.recover();

    if (this.boundary.seeds) await seed(this.setup, this.skills, this.specialists, this.automations);
    // Summaries a restart or a failed call left unwritten.
    this.ctx.waitUntil(this.memory.compress());
    // Asked last and not awaited: a runner's answer over the pipe is a socket message, which waits for this start to
    // end. Awaited here, the probe timed out and its "down" was kept for 30s. A provider that answers moves main to it.
    this.ctx.waitUntil(this.models.probe());
  }

  /** Forget a cloud machine that is no sandbox, as after a restore, and revoke its token. */
  async #removeStale(machine: string): Promise<void> {
    const removed = await this.removeMachine(machine);

    if (removed?.pairing) await this.env.Vault.getByName("owner").revoke("machine", machineSubject(machine, removed.pairing));
  }

  /**
   * Kept disks whose save is gone, as a restore into another deploy brings them: nothing to keep.
   * One whose container still runs, or whose first save is under way, is left for now.
   */
  async #dropLostDisks(): Promise<void> {
    for (const kept of this.sandboxes.kept()) {
      if (await this.env.FILES.head(saveKey(kept.id))) continue;

      if (await this.env.CloudMachine.getByName(kept.id).settled()) this.sandboxes.forget(kept.id);
    }
  }

  /** What a backup holds, for its manifest (src/backup.ts). */
  backupPlan(): Plan {
    return this.backups.plan();
  }

  /** The next part of a table's rows, for a backup. */
  backupRows(table: string, after: SqlStorageValue[] | null): Page {
    return this.backups.rows(table, after);
  }

  /** Start a restore; throws why it can't. */
  restoreBegin(manifest: Manifest, end: End, force: boolean): void {
    this.backups.begin(manifest, end, force);
  }

  /** The upload at `key` the restore expects. */
  restoreFile(key: string): ArchivedFile | undefined {
    return this.backups.file(key);
  }

  restoreFiles(): ArchivedFile[] {
    return this.backups.files();
  }

  /** Keep a part of a table's rows aside for the restore; how many. */
  restoreRows(table: string, text: string): number {
    return this.backups.stage(table, text);
  }

  /**
   * Swap the restored tables in, at `origin`, the address it was restored at, and set right what
   * belonged to the old deploy: bookings, unfinished tasks, the address, and chat search. Then
   * `restart`, which the Worker calls next, starts the agent over on them.
   */
  async restoreFinish(origin: string, force: boolean): Promise<Restored> {
    const files = this.backups.files().length;

    // The automations the restore replaces; the restart books the restored ones (Automations.recover).
    for (const job of await this.automations.scheduler.list()) {
      if (job.callback === "automation") await this.automations.scheduler.cancel(job.id);
    }

    // This deploy's sandboxes: their containers and saves stay, so those the backup lacks are kept disks.
    const sandboxes = this.sandboxes.all();

    const { rows, leftOut } = this.backups.finish(force, () => {
      const sql = this.ctx.storage.sql;
      this.sandboxes.keep(sandboxes);
      this.sandboxes.seeded();
      sql.exec("UPDATE ky_automations SET schedule_id = NULL");
      sql.exec("UPDATE ky_tasks SET status = 'stopped', finished_at = coalesce(finished_at, ?) WHERE status IN ('queued', 'working')", Date.now());
      this.setup.moved(origin);
      this.history.rebuild();
    });

    const { summary } = this.backups.plan();
    const uploadBytes = (await this.env.FILES.list({ prefix: "files/" })).objects.reduce((total, object) => total + object.size, 0);

    return { summary: { ...summary, uploads: files, uploadBytes }, rows, files, leftOut };
  }

  /** Start the object over, dropping all it holds in memory; this call never returns. */
  restart(): void {
    this.ctx.abort("ky was restored from a backup");
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
  pairMachine(machine: string, facts: MachineFacts, pairing: string, sandbox?: string): string | null {
    const named = this.sandboxes.named(machine);

    // A sandbox's container pairs as its own name only while it lives; nothing else pairs as one.
    if (sandbox !== undefined ? named?.id !== sandbox : named !== undefined) {
      throw new Error(sandbox !== undefined ? `The sandbox ${sandbox} is not ${machine} now.` : `${machine} is one of ky's sandboxes.`);
    }

    const previous = this.machines.paired(machine, facts, pairing);
    this.sockets.revokeRunner(machine, `${machine} was paired again, so this runner's token no longer works; pair it again.`);

    return previous;
  }

  /** The Vault the peer tool keeps tokens in: the one the peer routes check (src/peers/peers.ts). Tests give each test ky its own. */
  protected peerVault(): DurableObjectStub<Vault> {
    return this.env.Vault.getByName("owner");
  }

  /** Another ky paired with an invite for `name`; false when the name is taken. */
  peerJoined(name: string, address: string): boolean {
    return this.peers.add(name, address);
  }

  /** Forget a peer whose pairing failed after it joined. */
  peerLeft(name: string): void {
    this.peers.remove(name);
  }

  /** A peer asks a question: it is answered in the background, in a peer conversation. Why not, if refused. */
  peerAsked(name: string, id: string, question: string): string | undefined {
    const taken = this.peerAsks.received(name, id, question);

    if (taken === "new") {
      this.ctx.waitUntil(this.#answerPeer(name, id, question));
      this.peerDesk.sweepAt(Date.now() + ASK_TTL_MS);
    }

    return taken === "new" || taken === "known" ? undefined : taken;
  }

  /** Answer a peer's question in a conversation of its own on the background model, shown in Activity, and send the answer back. */
  async #answerPeer(name: string, id: string, question: string): Promise<void> {
    const { id: session } = await this.harness.sessions.create();
    this.peerAsks.answering(name, id, session);
    await this.#configure(session, "background");

    const said = await runInFeed(this.#background, await this.harness.conversation(session), {
      id: crypto.randomUUID(),
      worker: name,
      title: `${name} asks`,
      content: peerQuestion(name, question)
    });

    const answer = said || "This ky couldn't answer that just now.";

    // A question the conversation escalated waits on the user's reply instead.
    if (this.peerAsks.answered("in", name, id, answer, ["open"])) await deliver(this.peerDesk, name, id, answer);
  }

  /** A peer answers a question this ky asked: tell the conversation that asked. False for no such open question. */
  async peerAnswered(name: string, id: string, answer: string): Promise<boolean> {
    const ask = this.peerAsks.answered("out", name, id, answer);

    if (!ask) return false;
    await this.peerDesk.tell(ask.session, peerAnswer(name, ask.question, answer), `peer-answer:${name}:${id}`);

    return true;
  }

  /** Expire the questions unanswered for a day, and send the answers that didn't arrive; the Scheduler runs it. */
  sweepPeers(now = Date.now()): Promise<void> {
    return sweepPeers(this.peerDesk, now);
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

/** What Access lets through signed out: the routes that take their own tokens, then the public files. */
function signedOut(request: Request, env: Env, url: URL): Promise<Response> {
  return tokenRoute(request, env, url) ?? peerRoute(request, env, url) ?? env.ASSETS.fetch(request);
}

/**
 * ky's Worker, with Access checked by `access`: production's fetches the team's keys, the stack's
 * (src/tests/stack.ts) a fake Access's.
 */
export function worker(access: Access) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);

      // What Access lets through signed out: runners and their tasks, and other kys, which sign in with their
      // own tokens (src/runners.ts, src/peers/peers.ts) and never with the user's, and the manifest and icons iOS fetches without a cookie.
      if (bypassed(url.pathname)) return signedOut(request, env, url);

      const refused = await access.refuse(request, env);

      if (refused) return refused;

      const owner = ownerRoute(request, env, url) ?? sandboxRoute(request, env, url) ?? backupRoute(request, env, url);

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
