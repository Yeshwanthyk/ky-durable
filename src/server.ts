import { DurableObject } from "cloudflare:workers";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import type { BrowserWorker } from "@cloudflare/playwright";
import { ConversationBusy, createRegistry, type Extension, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { PING, PONG } from "./protocol";
import { bypassed } from "./access/contract";
import { Access } from "./access/wiring";
import { KY_AVATAR, type Missing as NotSetUp, preamble, type PromptConfig } from "./avatars/contract";
import { Avatars, avatarTools, seed, Setup } from "./avatars/wiring";
import type { ArchivedFile, End, Manifest, Restored } from "./archive";
import { backupRoute, Backups, type Page, type Plan } from "./backup";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { uiExtension } from "./cards/wiring";
import { ChatList, chatActivityExtension } from "./chats/chats";
import type { Opener } from "./chats/contract";
import { chatsExtension } from "./chats/tool";
import { AUTOMATION_SOURCE, CHECK_IN_TOOLS } from "./automations/contract";
import { Automations, automationTools, Deliveries, deliveryExtension, TaskFeed } from "./automations/wiring";
import type { Browsers } from "./browse/contract";
import { browseRoute, Browsing, cloudBrowsers } from "./browse/wiring";
import { ExecutorLink, executeOnce, executorExtension } from "./executor/wiring";
import type { FileRow } from "./files/contract";
import { download, saveImage } from "./files/files";
import { FileStore, retype, uploadMedia } from "./files/wiring";
import { History, startedByUser } from "./history/wiring";
import { lookPost } from "./core/transcript";
import type { SandboxNow } from "./cloud";
import { machineSubject, saveKey, type Sandbox, type SandboxChange, type SandboxDraft } from "./runners/contract";
import { ownerRoute, Sandboxes, tokenRoute } from "./runners/wiring";
import { sandboxRoute } from "./sandbox-routes";
import { LivingSites, publicSiteRoute, siteExtension, siteRoute } from "./sites/wiring";
import type { DataAnswer, DataCaller, DataOp, LinkMode, SiteLink, SiteVersion } from "./sites/contract";
import { meter, Spend, spendExtension } from "./spend/wiring";
import { type CloudHook, isMac, type MachineFacts, type TaskTokens } from "./machines/contract";
import { confine, MachineHub, machineTools, RunnerPipe } from "./machines/wiring";
import { Anticipations, dreamCron, DreamLedger, Dreaming, dreamingTools, Looks, Memory, Presence, Proactivity, Recall, Soul, Surfaced, Verdicts } from "./dreaming/wiring";
import { type ModelsBoundary, type Slot, SLOT_PROVIDER, slotModel } from "./providers/contract";
import { Models, notSetUp as modelsNotSetUp, vibeProxyFrom } from "./providers/wiring";
import { ASK_TTL_MS, PEER_TOOLS } from "./peers/contract";
import { deliver, GroupChats, GroupDesk, peerAnswer, PeerAsks, type PeerDesk, peerLimits, peerQuestion, peerRoute, Peers, peerTools, sweepPeers } from "./peers/wiring";
import { addressOf, type InboundMail, MAIL_BYTES, type MailBoundary, mailLimits } from "./mail/contract";
import { MailBox, type MailDesk, mailExtension, readMail, receive } from "./mail/wiring";
import { type Hook, type HookDelivery, Inbound, type Received, type SecretAsk } from "./inbound/inbound";
import type { HooksView } from "./inbound/shapes";
import { hookRoute, inboundRoute } from "./inbound/routes";
import { hookGuard, inboundTools } from "./inbound/tools";
import { replyPushExtension } from "./push/replies";
import { Pushes } from "./push/wiring";
import { Approvals } from "./approvals/approvals";
import { ExecutorApprovals } from "./approvals/executor";
import { Outside } from "./outside/outside";
import { BROWSER_TAG, PiSessionSockets, watching } from "./sockets";
import { Subscriptions } from "./subscriptions";
import { BACKGROUND_SOURCE, KY, REVIEW_ALLOWED, type ReviewHost, runInFeed, type Spawn } from "./skills/contract";
import { delegationTools, draftFromDemo, Reviews, Skills, skillTools, type SkillsWiring, Specialists } from "./skills/wiring";
import { Titler } from "./chats/titles";
import { createWorkspaceTools, JAVASCRIPT_BACKEND, pagedTools } from "./workspace";
import { guardrailsExtension, READ_MAX_BYTES } from "./guardrails";

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
  /** Kitesurf and ky's Chromium session; Browser Rendering's, through `browser`, unless set. */
  readonly browsers?: Browsers;
  /** How requests reach Executor, once the user connects it in Settings; global fetch unless set. */
  readonly executorFetch?: typeof fetch;
  /** Seed the starter skills, specialist and automations on the first start (src/seeds.ts). */
  readonly seeds: boolean;
  /** How requests reach other people's kys (src/peers/peers.ts); global fetch unless set. */
  readonly peerFetch?: typeof fetch;
  /** ky's own address and the binding it sends with (src/mail.ts); undefined until the deploy has both. */
  readonly mail?: MailBoundary | undefined;
  /** More tools for every agent, after ky's own. */
  readonly extensions: readonly Extension[];
};

/** What a deploy lacks, as each model source says, given the providers ky has. Executor is connected in Settings instead. */
export function notSetUp(boundary: Boundary, providers: readonly string[] = []): readonly NotSetUp[] {
  return modelsNotSetUp(boundary, providers);
}

/** The user's one agent, one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  readonly boundary = this.boundaryFor(this.env);
  readonly feed = new TaskFeed(this.ctx.storage.sql);
  /** What the models cost, by day in the user's zone, and the daily cap that holds unasked work (src/spend). */
  readonly spend: Spend = new Spend(this.ctx.storage, () => this.automations.checkIns().zone);
  readonly files = new FileStore(this.ctx.storage);
  /** ky's sandboxes, its own machines in Cloudflare (src/sandboxes.ts). */
  readonly sandboxes = new Sandboxes(this.ctx.storage);
  /** The user's Claude and ChatGPT logins, in the Vault, for Settings and the runs that are handed them. */
  readonly subscriptions = new Subscriptions(() => this.env.Vault.getByName("owner"));
  readonly machines = new MachineHub(
    this.ctx.storage,
    this.feed,
    (tag) => this.ctx.getWebSockets(tag),
    this.files,
    this.taskTokens(),
    (agent) => this.subscriptions.creds(agent),
    this.sandboxes
  );
  /** Requests to ports on the user's machines, over their runners' sockets. */
  readonly pipe = new RunnerPipe((tag) => this.ctx.getWebSockets(tag));
  readonly models = new Models(this.ctx.storage, this.boundary, this.env.Vault.getByName("owner"), this.machines, this.pipe);
  /** Other people's kys this one is paired with (src/peers/peers.ts). */
  readonly peers = new Peers(this.ctx.storage.sql);
  /** Which conversations read outside content (src/outside), for what one conversation tells another. */
  readonly outside = new Outside(this.ctx.storage);
  /** The questions this ky and its peers ask each other. */
  readonly peerAsks = new PeerAsks(this.ctx.storage.sql, peerLimits(this.env));
  /** ky's repo and address, for self-edits. */
  readonly setup = new Setup(this.ctx.storage);
  /** What the peer tool and Settings › Peers work with. */
  readonly peerDesk: PeerDesk = {
    peers: this.peers,
    asks: this.peerAsks,
    vault: () => this.peerVault(),
    fetch: this.boundary.peerFetch ?? ((input, init) => fetch(input, init)),
    origin: () => this.setup.origin(),
    tell: async (session, content, requestId) => {
      const conversation = await this.harness.conversation(session ?? ROOT_SESSION);
      await conversation.submit({ type: "input", content, whenBusy: "steer", requestId }, BACKGROUND_CONTEXT);
    },
    carry: (from, to) => this.outside.carry(from, to ?? ROOT_SESSION),
    sweepAt: (at) => this.ctx.waitUntil(this.automations.sweepPeersAt(at))
  };
  /** ky's own mail (src/mail.ts). */
  readonly mailBox = new MailBox(this.ctx.storage);
  /** What the mail tool, the email handler and Settings › Mail work with. */
  readonly mailDesk: MailDesk = {
    box: this.mailBox,
    boundary: this.boundary.mail,
    limits: mailLimits(this.env),
    owners: () => (this.env.ACCESS_EMAILS ?? "").split(",").map(addressOf).filter((address) => address !== ""),
    tell: (session, content, requestId) => this.peerDesk.tell(session, content, requestId),
    triage: (mail, content, started) => this.#triageMail(mail.id, mail.party, content, started)
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
  /** Its summaries are written on the background model, as notes come in; its days are the user's. */
  readonly memory = new Memory(
    this.ctx.storage,
    (system, messages) => this.models.ask("background", system, messages, { timeoutMs: 120_000, maxTokens: 8_000 }),
    () => this.automations.checkIns().zone
  );
  readonly skills = new Skills(this.ctx.storage);
  /** SOUL.md, ky's persona. */
  readonly soul = new Soul(this.ctx.storage);
  /** The user's standing bots, like @engineer. */
  readonly specialists = new Specialists(this.ctx.storage, {
    sandboxes: () => this.sandboxes.live(),
    macs: () => this.machines.machines().flatMap((machine) => (isMac(machine) ? [machine.name] : [])),
    open: (name) => this.createSandbox({ name, isDefault: false })
  });
  /** The bloubs ky and the specialists wear. */
  readonly avatars = new Avatars(this.ctx.storage);
  /** Which specialists are in which chats, and their seats there. */
  readonly groups = new GroupChats(this.ctx.storage.sql, this.specialists);
  /** Skill reviews and dreams: background conversations that remember but may only tend skills and memory. */
  readonly reviews = new Reviews(this.ctx.storage);
  /** Every change a dream makes, so the user can undo it; it also guards what a dream may change. */
  readonly ledger = new DreamLedger(this.ctx.storage, { skills: this.skills, memory: this.memory, reviews: this.reviews });
  readonly chats = new ChatList(this.ctx.storage);
  /** Every message of the main chat and the side chats, searchable. */
  readonly history = new History(
    this.ctx.storage,
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
    context: BACKGROUND_CONTEXT
  });
  /** The user's Executor, connected in Settings and kept in the Vault; its tools are installed while it is. */
  readonly executor = new ExecutorLink(() => this.env.Vault.getByName("owner"), this.ctx.id.name ?? "me", this.boundary.executorFetch);
  /** Bumped by every connect and disconnect, so an install read before one never lands after it. */
  #executorGeneration = 0;
  /** Starts a subagent from outside a tool call; set once pi opens, which every run's commit waits for. */
  #spawn: Spawn | undefined;
  readonly automations = new Automations(this.ctx.storage, {
    feed: this.feed,
    machines: this.machines,
    chats: this.chats,
    models: this.models,
    runtime: {
      spawn: (tx, owner, request) => this.#spawn!(tx, owner, request),
      commit: async (change) => (await this.harness.pi()).commit(change, BACKGROUND_CONTEXT),
      // An outside commit does not wake pi, and in agents 0.26 onStart, which books a wake for every
      // session with live tasks, is the only way to. Replace it once PiHarness exposes a wake.
      wake: () => this.harness.onStart({ props: undefined }),
      // As the UI's Stop does.
      abort: async (session) => {
        await this.harness.session(session).abort();
      },
      deliver: (item): Promise<void> => this.deliveries.deliver(item)
    },
    gate: async (code, signal) => {
      const config = await this.executor.config();

      return config ? executeOnce(config, code, signal) : { text: "Executor is not connected.", error: true };
    },
    dream: { cron: dreamCron, run: () => this.ctx.waitUntil(this.dreaming.run()) },
    looks: { booked: (zone) => this.looks.booked(zone), run: (time) => this.ctx.waitUntil(this.looks.run(time)) },
    peers: () => this.sweepPeers(),
    approvals: () => this.approvals.sweep(),
    sites: () => this.sites.flush(),
    unwatched: (id) => {
      if (this.anticipations.open().some((row) => row.id === id)) this.anticipations.close(id, "dismissed", "user", "watch deleted by the user");
    },
    allows: (work) => this.spend.allows(work),
    pin: (id, profile) => this.specialists.pin(id, profile),
    owners: (owner) => (owner === KY || this.specialists.has(owner) ? { profile: this.specialists.profile(owner), model: this.specialists.get(owner)?.model ?? null } : undefined)
  });
  readonly registry = createRegistry();
  /** Where skill reviews and dreams run and report. */
  readonly #background: ReviewHost = {
    conversation: (session) => this.harness.conversation(session),
    feed: this.feed,
    later: (work) => this.ctx.waitUntil(work),
    context: BACKGROUND_CONTEXT,
    model: () => slotModel("background"),
    allows: (work) => this.spend.allows(work)
  };
  /** When the user was last here; the dream waits until they are away. */
  readonly presence = new Presence(this.ctx.storage);
  /** What the user will need soon; a done one becomes a memory. */
  readonly anticipations = new Anticipations(this.ctx.storage, this.memory, (session) => this.isChat(session));
  /** What ky put in front of the user unasked, and what they did with it. */
  readonly surfaced = new Surfaced(this.ctx.storage);
  /** The user's 👍 or 👎 on each unasked post. */
  readonly verdicts = new Verdicts(this.ctx.storage);
  /** How proactive ky is, from Settings › Proactivity. */
  readonly proactivity = new Proactivity(this.ctx.storage);
  /** What ky already knows about a message the user sends in a chat, recalled before it answers. */
  readonly recall = new Recall({
    storage: this.ctx.storage,
    memory: this.memory,
    history: this.history,
    anticipations: this.anticipations,
    surfaced: this.surfaced,
    proactivity: this.proactivity,
    skills: () => this.skills.list(),
    chat: (session) => this.isChat(session),
    delivered: (requestId) => this.deliveries.delivered(requestId)
  });
  /** What ky posts unasked, as notifications on the user's devices. */
  readonly pushes = new Pushes(this.ctx.storage, {
    vault: () => this.env.Vault.getByName("owner"),
    zone: () => this.automations.checkIns().zone,
    most: () => this.proactivity.rightAway(),
    // A side chat by its name; the main chat, and one not named yet, as ky.
    title: (session) => this.chats.list().find((chat) => chat.session === session)?.title || "ky",
    origin: () => this.setup.origin()
  });
  /** What ky asks the user before it acts for them; only their tap decides (src/approvals/approvals.ts). */
  readonly approvals = new Approvals(this.ctx.storage, {
    // A card in the user's own turn pushes too once they have left ky: they sent it and went.
    present: (session) => this.userHere(session) && this.watched(),
    home: (session) => this.cardChat(session),
    notify: (chat, text) => this.ctx.waitUntil(this.pushes.notify(chat, text)),
    defer: (work) => this.ctx.waitUntil(work),
    later: (at) => this.ctx.waitUntil(this.automations.sweepApprovalsAt(at))
  });
  /** Executor's pauses for approval, taken from the model and asked of the user; and each app tool's policy. */
  readonly executorApprovals = new ExecutorApprovals(this.ctx.storage, this.approvals, {
    config: () => this.executor.config(),
    present: (session) => this.userHere(session),
    unattended: (session) => this.unattended(session),
    tell: (session, content, requestId) => this.peerDesk.tell(session, content, requestId),
    ownPolicy: (session, tool) => {
      const { owner, tools } = this.specialists.profileOf(session);

      return Object.hasOwn(tools, tool) ? { owner, policy: tools[tool] ?? "ask" } : undefined;
    }
  });
  /** How an automation's report reaches the user: in full, in its chat, between turns. */
  readonly deliveries: Deliveries = new Deliveries(this.ctx.storage.sql, {
    surfaced: this.surfaced,
    notify: (session, text) => this.pushes.notify(session, text),
    submit: async (session, content, requestId) => {
      const conversation = await this.harness.conversation(session);

      try {
        await conversation.submit({ type: "input", content, whenBusy: "reject", requestId }, BACKGROUND_CONTEXT);
      } catch (error) {
        if (error instanceof ConversationBusy) return false;
        throw error;
      }

      return true;
    },
    post: async (session, text, requestId, cards, item) => {
      const conversation = await this.harness.conversation(session);
      // A write waits for no run, so a busy chat is turned away here, as submit's whenBusy does.
      const busy = await conversation.commit(async (tx) => (await tx.doc(LiveDoc, conversation.id)).run !== undefined, BACKGROUND_CONTEXT);

      if (busy) return false;
      await conversation.submit({ type: "write", entry: lookPost(text, Date.now(), cards, item), requestId }, BACKGROUND_CONTEXT);

      return true;
    },
    idle: async (session) => (await this.harness.conversation(session)).waitForIdle(BACKGROUND_CONTEXT),
    later: (work) => this.ctx.waitUntil(work)
  });
  /** Webhooks, and the credentials ky asked for (src/inbound/inbound.ts). */
  readonly inbound = new Inbound(this.ctx.storage, {
    vault: () => this.env.Vault.getByName("owner"),
    asker: this.approvals,
    chat: (session) => this.isChat(session),
    owner: (session) => this.specialists.profileOf(session).owner,
    home: (session) => this.cardChat(session),
    unattended: (session) => this.unattended(session),
    // After the turn running there, so outside data never lands in the middle of the user's own turn.
    tell: async (session, content, requestId) => {
      const conversation = await this.harness.conversation(session);
      await conversation.submit({ type: "input", content, whenBusy: "followUp", requestId }, BACKGROUND_CONTEXT);
    }
  });
  /** Living sites' data, share links and versions; edits through a link are told as the inbound tells a webhook (src/sites/living.ts). */
  readonly sites: LivingSites = new LivingSites(this.ctx.storage, {
    bucket: this.env.FILES,
    chat: (session) => this.isChat(session),
    tell: (session, content, key) => this.inbound.tellOutside(session, content, key),
    flushAt: (at): Promise<void> => this.automations.flushSitesAt(at)
  });
  readonly dreaming = new Dreaming(this.ctx.storage, {
    history: this.history,
    anticipations: this.anticipations,
    presence: this.presence,
    later: (at) => this.automations.dreamAt(at),
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
    }),
    surfaced: this.surfaced,
    verdicts: this.verdicts
  });
  /** ky's looks over the user's day, at their look times while Proactivity is on. */
  readonly looks: Looks = new Looks(this.ctx.storage, {
    history: this.history,
    anticipations: this.anticipations,
    reviews: this.reviews,
    host: this.#background,
    // A look may read the web as a check-in does, so it keeps browse.
    create: async () => {
      const { id } = await this.harness.sessions.create();
      await this.#configure(id, "background", { browse: true });

      return id;
    },
    surfaced: this.surfaced,
    proactivity: this.proactivity,
    zone: () => this.automations.checkIns().zone,
    deliver: (item, now) => this.deliveries.deliver(item, now),
    automations: this.automations,
    verdicts: this.verdicts
  });
  /** ky's browser: subagents browse, the main agent delegates it, since a page can take a minute; a chat hands it to the user. */
  readonly browsing = new Browsing(this.ctx.storage, {
    browsers: this.boundary.browsers ?? cloudBrowsers(this.boundary.browser),
    vault: () => this.env.Vault.getByName("owner"),
    save: (bytes, type) => saveImage(this.env.FILES, bytes, type),
    workspace: this.workspace,
    reads: (conversation) => this.mayCall(String(conversation), "read"),
    chat: (session) => this.isChat(session),
    owner: (session) => this.specialists.profileOf(session).owner,
    owners: () => this.owners(),
    asker: this.approvals,
    unattended: (session) => this.unattended(session),
    tell: (session, content, requestId) => this.inbound.desk.tell(session, content, requestId),
    draft: (session, demo) => draftFromDemo(this.skills, this.reviews, this.#background, session, demo),
    later: (work) => this.ctx.waitUntil(work)
  });
  readonly browse = this.browsing.extension;
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const chat = (session: string) => this.isChat(session);

      // Each domain makes its tools in its folder's wiring.ts; they are installed here, in this order.
      const { soul, memory, episodes, recall } = dreamingTools({
        soul: this.soul,
        memory: this.memory,
        anticipations: this.anticipations,
        recall: this.recall,
        history: this.history,
        reviews: this.reviews,
        chat,
        storage: this.ctx.storage,
        background: this.#background,
        busyAfter: () => this.skills.reviewAfter,
        proactivity: this.proactivity
      });

      const skilling: SkillsWiring = {
        skills: this.skills,
        reviews: this.reviews,
        specialists: this.specialists,
        feed: this.feed,
        models: this.models,
        automations: this.automations,
        background: this.#background,
        chat,
        peer: (session) => this.peerAsks.peerConversation(session),
        deliver: (item) => this.deliveries.deliver(item),
        carry: (from, to) => this.outside.carry(from, to)
      };

      const workspaceTools = createWorkspaceTools(this.workspace, { read: { maxBytes: READ_MAX_BYTES } });

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
        tools: workspaceTools
      });
      // First of all the tool hooks, and the first block wins: a call a webhook's run may not make is asked of the user
      // (src/inbound/tools.ts), never told as a repeat to change approach on, as the guardrails below would.
      this.registry.install(hookGuard(this.inbound));
      // Before every other tool hook: a blocked call then starts no progress step, and those after see the preview.
      this.registry.install(
        guardrailsExtension({
          sql: this.ctx.storage.sql,
          workspace: this.workspace,
          unspilled: pagedTools(workspaceTools),
          readsFiles: (conversation) => this.mayCall(String(conversation), "read")
        })
      );

      await this.#installExecutor();
      this.registry.install(this.browse);
      this.registry.install(this.browsing.handoffExtension);

      for (const extension of this.boundary.extensions) this.registry.install(extension);

      this.registry.install(skillTools(skilling));

      const { machines } = machineTools({ machines: this.machines, feed: this.feed, owners: this.specialists });
      const { automations, checkInGuard } = automationTools({ automations: this.automations, models: this.models, reviews: this.reviews, specialists: this.specialists });

      this.registry.install(memory);
      this.registry.install(recall);
      this.registry.install(episodes);
      this.registry.install(machines);
      this.registry.install(automations);

      // Cards and sites are for a chat with the user: the tools refuse elsewhere, and subagents and seats go without them.
      const ui = uiExtension(chat);
      this.registry.install(ui);
      const site = siteExtension(chat, this.sites, this.workspace, () => this.setup.origin());
      this.registry.install(site);

      // A chat opens side chats and steers them; one it opened runs none, so control goes one way.
      const chats = chatsExtension({
        chats: this.chats,
        openedFor: (request) => this.chats.openedFor(request),
        openedBy: (session) => this.chats.openedBy(session),
        open: (opener) => this.newChat(opener),
        steer: async (session, content, requestId) => {
          await (await this.harness.conversation(session)).submit({ type: "input", content, whenBusy: "steer", requestId }, BACKGROUND_CONTEXT);
        },
        busy: async (session) => {
          const conversation = await this.harness.conversation(session);

          return conversation.commit(async (tx) => (await tx.doc(LiveDoc, conversation.id)).run !== undefined, BACKGROUND_CONTEXT);
        },
        latest: (session) => this.history.latest(session),
        chat
      });

      this.registry.install(chats);

      const { specialists, subagents, spawn, progress } = delegationTools(skilling, { soul, memory, machines, automations, ui, chats, site });
      this.registry.install(specialists.extension);
      this.registry.install(specialists.manage);
      this.registry.install(avatarTools(this.avatars, () => [KY_AVATAR, ...this.specialists.list().map((row) => row.id)]));

      this.#spawn = spawn;
      this.registry.install(subagents);

      // A seat in a chat cannot ask or start other agents: replies never lead to more replies.
      const mail = mailExtension(this.mailDesk, chat);
      const { seat, peer } = peerTools({ group: this.group, peerDesk: this.peerDesk, models: this.models, chat }, [soul, automations, specialists.manage, subagents, mail, ui, chats, site]);
      this.registry.install(seat);
      this.registry.install(progress);
      this.registry.install(checkInGuard);
      this.registry.install(chatActivityExtension(this.chats));
      this.registry.install(deliveryExtension(this.deliveries));
      this.registry.install(
        replyPushExtension({
          asked: (session) => this.userHere(session),
          watched: () => this.watched(),
          notify: (session, text) => this.ctx.waitUntil(this.pushes.notify(session, text, true))
        })
      );
      this.registry.install(peer);
      this.registry.install(mail);
      this.registry.install(inboundTools(this.inbound));
      this.registry.install(spendExtension(this.spend, { chat, review: (session) => this.reviews.kind(session), task: (session) => this.feed.working(session) }));

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
    // Read on each new session: it follows the main slot, and runs at the level main's model has at each call.
    defaults: ((models: Models) => ({
      get model() {
        return models.registry.getModel(SLOT_PROVIDER, "main") ?? models.resolve("main").model;
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
    this.mailDesk,
    this.pipe,
    this.executor,
    { store: this.approvals, executor: this.executorApprovals },
    this.chats,
    this.skills,
    this.soul,
    this.avatars,
    this.specialists,
    this.group,
    this.groups,
    this.memory,
    this.ledger,
    this.automations,
    this.presence,
    this.proactivity,
    this.verdicts,
    this.pushes,
    this.recall,
    this.setup,
    this.spend,
    () => notSetUp(this.boundary, this.models.catalog().map((provider) => provider.id)),
    () => this.newChat(),
    {
      kept: { status: () => this.env.Vault.getByName("owner").status(), remove: (kind, id) => this.env.Vault.getByName("owner").remove(kind, id) },
      browser: (owner) => this.browsing.forget(owner)
    },
    this.env.CF_VERSION_METADATA.id
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness)
    .use(this.automations.scheduler);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The page's liveness check (src/connection.ts): the runtime answers it without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.machines.attach(this.harness, (task) => this.automations.wanted(task));
    this.machines.cloud = this.cloudHook();
    this.machines.recheckAt = (at) => this.ctx.waitUntil(this.automations.recheckMachinesAt(at));
    this.machines.adopt = (task, parent) => this.specialists.adopt(task, parent);
    // A Mac the user takes from a specialist, or unpairs, stops that specialist's work on it.
    this.specialists.onChange(() => this.ctx.waitUntil(confine(this.machines, this.feed, this.specialists)));
    this.proactivity.onChange(() => this.ctx.waitUntil(this.automations.bookLooks()));
    // A closed watch anticipation, or Proactivity off, retires its watch.
    this.proactivity.onChange(() => this.ctx.waitUntil(this.looks.retire()));
    this.anticipations.onClose(() => this.ctx.waitUntil(this.looks.retire()));

    // Before anything asks: the pair route asks whether a name is a sandbox's.
    if (this.machines.cloud) this.sandboxes.migrate();
    this.specialists.migrate();
    this.ctx.waitUntil(retype(this.files, this.env.FILES).catch((error) => console.warn("files not retyped", error)));
    this.#nameThings();
    meter(this.spend, { answers: (listener) => this.models.onAnswer(listener), spent: (listener) => this.feed.onSpend(listener) });
    this.memory.onChange(() => this.ctx.waitUntil(this.memory.compress()));
    // Each kind of approval and who decides it.
    this.approvals.handle("executor", this.executorApprovals);
    this.approvals.handle("webhook-action", this.inbound.handlers["webhook-action"]);
    this.approvals.handle("secret-request", this.inbound.handlers["secret-request"]);
    this.approvals.handle("browser-handoff", this.browsing.handler);
    this.approvals.handle("browse-steps", this.browsing.stepsHandler);
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

    if (config) this.registry.install(executorExtension(config, this.executorApprovals, (url) => this.executor.retarget(url)));
    else if (installed) this.registry.uninstall(installed);
  }

  /**
   * Whether the run in `session` may call `tool`, by the allow-lists the blocking hooks hold runs to: a check-in's
   * (src/automations), a review's of its kind (src/skills) and a peer's question's (src/peers; its `peer escalate`, which
   * turns on the arguments, aside). Any other run may call any tool. The spill (src/guardrails.ts) asks it of `read`,
   * so a result goes to a file only where it can be read back.
   */
  mayCall(session: string, tool: string): boolean {
    const kind = this.reviews.kind(session);

    return (
      (!this.automations.checkInRun(session) || CHECK_IN_TOOLS.includes(tool)) &&
      (kind === undefined || REVIEW_ALLOWED[kind].includes(tool)) &&
      (!this.peerAsks.peerConversation(session) || PEER_TOOLS.some((name) => name === tool))
    );
  }

  /** The main chat or a side chat, as against a subagent, a review or a dream. */
  isChat(session: string): boolean {
    return session === ROOT_SESSION || this.chats.has(session);
  }

  /** The chat a card from `session` shows in: itself; or for a subagent's, a routine's or a specialist's, the chat its task reports to; a peer's conversation works for the main chat. */
  cardChat(session: string): string {
    return this.isChat(session) && !this.#archived(session) ? session : this.feed.working(session)?.chat || ROOT_SESSION;
  }

  /**
   * Whether the user is in the turn running in `session`: their own message started it (src/history.ts
   * startedByUser), in the main chat or a side chat of theirs in the list. A turn a report, a mail, a peer's
   * question or another chat started has nobody there to approve anything. Nor does a run that works on a webhook's
   * data (src/inbound/inbound.ts guarded), even once the user steers it: their message doesn't make the post theirs.
   * A specialist's turn is never the user's: its Allow asks too.
   */
  userHere(session: string): boolean {
    return (
      this.isChat(session) &&
      !this.#archived(session) &&
      this.chats.openedBy(session) === null &&
      startedByUser(this.ctx.storage.sql, session) &&
      !this.inbound.guarded(session)
    );
  }

  /**
   * Whether nobody can answer a card for the turn in `session`: an automation's run, or a background one (a look, a
   * dream, a review, a mail's triage), or a subagent one of those started. A chat always has the user; a peer's
   * question leaves its card in main for the user's tap (src/peers).
   */
  unattended(session: string, depth = 0): boolean {
    const asked = this.isChat(session) || this.peerAsks.peerConversation(session) || depth > 4;
    const task = asked ? undefined : this.feed.working(session);

    if (!task) return false;

    if (task.source === BACKGROUND_SOURCE || task.source.startsWith(AUTOMATION_SOURCE)) return true;

    return task.chat !== null && task.chat !== session && this.unattended(task.chat, depth + 1);
  }

  /** Whether the user is looking at ky now, on any device: a page of it shown and in focus (src/sockets.ts watching). */
  watched(): boolean {
    return watching(this.webSockets.getConnections(BROWSER_TAG));
  }

  #archived(session: string): boolean {
    return (this.chats.list().find((chat) => chat.session === session)?.archived_at ?? null) !== null;
  }

  /** The sandboxes, on a deploy `ky deploy` gave containers (KY_CLOUD); tests replace their containers. */
  cloudHook(): CloudHook | undefined {
    if (!this.env.KY_CLOUD) return undefined;

    return {
      wake: (machine) => {
        const id = this.sandboxes.named(machine)?.id;

        if (id) this.ctx.waitUntil(this.env.CloudMachine.getByName(id).wake(id, this.setup.origin() ?? undefined));
      },
      turnEnded: (machine) => {
        const id = this.sandboxes.named(machine)?.id;

        if (id) this.ctx.waitUntil(this.env.CloudMachine.getByName(id).turnEnded());
      }
    };
  }

  /** Whether the sandbox `id` has work: an open task or a command waiting. Its alarm keeps it awake while it has. */
  cloudBusy(id: string): boolean {
    const sandbox = this.sandboxes.get(id);

    return sandbox !== undefined && sandbox.deletedAt === null && this.machines.busy(sandbox.name);
  }

  /**
   * What the sandbox `id`'s alarm needs: the name it pairs as, its idle minutes, whether it has work,
   * how many of its turns have ended (it snapshots its disk when that passes its last save); null once deleted.
   */
  sandboxNow(id: string): SandboxNow {
    const sandbox = this.sandboxes.get(id);

    if (!sandbox || sandbox.deletedAt !== null) return null;

    return { name: sandbox.name, idleMinutes: sandbox.idleMinutes, busy: this.machines.busy(sandbox.name), turnsEnded: this.machines.turnsEnded(sandbox.name) };
  }

  /** Why the sandbox `id` is unwell, as its CloudMachine saw (its saves keep failing); null once that is over. */
  sandboxTrouble(id: string, reason: string | null): void {
    const sandbox = this.sandboxes.get(id);

    if (sandbox) this.machines.trouble(sandbox.name, reason);
  }

  /** The sandbox `id` didn't start by its deadline, as `text` says: its waiting tasks fail with that. */
  async sandboxStartFailed(id: string, text: string): Promise<void> {
    const sandbox = this.sandboxes.get(id);

    if (sandbox) await this.machines.startFailed(sandbox.name, text);
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
   * Production's boundary: Workers AI, the internet, Browser Rendering, and the model sources' own
   * bindings when this deploy has them (wrangler.local.example.jsonc).
   */
  boundaryFor(env: Env): Boundary {
    const { EMAIL: email, KY_MAIL_ADDRESS: address } = env;

    return {
      ai: env.AI,
      fetch: (input, init) => fetch(input, init),
      mail: email && address ? { address: addressOf(address), send: (message) => email.send(message) } : undefined,
      vibeProxy: vibeProxyFrom(env),
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

    // Reviews, dreams, peer answers and mail triage the last instance was waiting on in memory.
    this.feed.cutOff(BACKGROUND_SOURCE);
    await this.sockets.reattach();
    // Reports a restart cut off between a task's turn ending and its conversation hearing of it,
    // posted once the start is over: a submit waits for the harness, which starts after this.
    this.ctx.waitUntil(this.machines.post());
    // Task tokens whose revoke a failure or a restart lost.
    this.ctx.waitUntil(this.machines.sweepTokens());
    await this.applyMain();
    await this.automations.recover();
    // Reports a restart left waiting for their chat's turn to end.
    this.deliveries.recover();
    // Taps a restart cut off before they were carried out: their cards come back, told once the start is over.
    this.approvals.recover();

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
      this.files.restored();
      sql.exec("UPDATE ky_automations SET schedule_id = NULL");
      sql.exec("UPDATE ky_tasks SET status = 'stopped', finished_at = coalesce(finished_at, ?) WHERE status IN ('queued', 'working')", Date.now());
      this.setup.moved(origin);
      this.history.rebuild();
    });

    this.ctx.waitUntil(retype(this.files, this.env.FILES).catch((error) => console.warn("files not retyped", error)));
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
    this.outside.mark(session, "peer");
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
    this.outside.mark(ask.session, "peer");
    await this.peerDesk.tell(ask.session, peerAnswer(name, ask.question, answer), `peer-answer:${name}:${id}`);

    return true;
  }

  /** A mail came to ky's address: kept before this returns, then triaged in the background. */
  mailReceived(mail: InboundMail): void {
    this.ctx.waitUntil(receive(this.mailDesk, mail));
  }

  /** Read a mail in a triage conversation of its own on the background model, shown in Activity: what it said. */
  async #triageMail(id: string, sender: string, content: string, started: (session: string) => void): Promise<string | undefined> {
    const { id: session } = await this.harness.sessions.create();
    started(session);
    await this.#configure(session, "background");

    return runInFeed(this.#background, await this.harness.conversation(session), { id: crypto.randomUUID(), worker: "mail", title: `Mail from ${sender}`, content: `${content}\n\n(mail ${id})` });
  }

  /** Settings › Webhooks: the hooks, and the chats a hook can post to. */
  inboundHooks(): HooksView {
    const chats = this.chats.list().filter((chat) => chat.archived_at === null);

    return { hooks: this.inbound.hooks(), chats: [{ session: ROOT_SESSION, title: "ky" }, ...chats.map(({ session, title }) => ({ session, title: title || "New chat" }))] };
  }

  inboundHook(id: string): Hook | null {
    return this.inbound.hook(id) ?? null;
  }

  addHook(id: string, session: string, label: string, signed: boolean): Hook | { refused: string } {
    return this.inbound.addHook(id, session, label, signed);
  }

  removeHook(id: string): boolean {
    return this.inbound.removeHook(id);
  }

  /** A post to a hook, its token, size and signature checked by the Worker (src/inbound/routes.ts). */
  hookReceived(id: string, delivery: HookDelivery): Promise<Received> {
    return this.inbound.received(id, delivery);
  }

  /** A living site's data, read or written by the owner or through a link, as the Worker took it (src/sites/routes.ts). */
  siteData(site: string, caller: DataCaller, op: DataOp): Promise<DataAnswer> {
    return this.sites.data(site, caller, op);
  }

  siteVersion(site: string): SiteVersion {
    return this.sites.version(site);
  }

  siteOwnerKey(site: string): Promise<string | null> {
    return this.sites.ownerKey(site);
  }

  siteLinks(site: string): Promise<{ links: ReadonlyArray<SiteLink> } | { refused: string }> {
    return this.sites.links(site);
  }

  siteShare(site: string, label: string, mode: LinkMode): Promise<SiteLink | { refused: string }> {
    return this.sites.share(site, label, mode);
  }

  siteRevoke(site: string, token: string): Promise<{ revoked: true } | { refused: string }> {
    return this.sites.revoke(site, token);
  }

  /** The credential ky asked a chat for, which the Worker saves what the user typed as; null when it isn't asking. */
  secretAsk(session: string, name: string): SecretAsk | null {
    return this.inbound.askFor(session, name) ?? null;
  }

  /** The Vault holds the credential the chat asked for: tell it so. */
  secretSaved(session: string, name: string): Promise<boolean> {
    return this.inbound.saved(session, name);
  }

  /** The credentials ky is asking a chat for, for its masked fields. */
  secretAsks(session: string): SecretAsk[] {
    return this.inbound.asks(session);
  }

  /** A saved browser login was removed: end the browser session that still holds it (src/browse/routes.ts). */
  browserForgot(owner: string): Promise<void> {
    return this.browsing.forget(owner);
  }

  /** Settings › Browser logins › Move to: `from`'s login for `site` becomes `to`'s (src/browse/routes.ts). */
  browserMoved(from: string, site: string, to: string) {
    return this.browsing.move(from, site, to);
  }

  /** Who can hold a browser login or an API key: ky and each specialist. */
  owners(): string[] {
    return [KY, ...this.specialists.list().map((row) => row.id)];
  }

  /** Expire the questions unanswered for a day, and send the answers that didn't arrive; the Scheduler runs it. */
  sweepPeers(now = Date.now()): Promise<void> {
    return sweepPeers(this.peerDesk, now);
  }

  /** Forget a machine the user removed; its pairing, whose token the caller revokes, or undefined if ky never knew it. */
  async removeMachine(machine: string): Promise<{ pairing: string | null } | undefined> {
    if (this.machines.machine(machine) === undefined) return undefined;
    this.sockets.revokeRunner(machine, `${machine} was removed from ky; pair it again to use it.`);
    this.specialists.dropMac(machine);

    return { pairing: await this.machines.remove(machine) };
  }

  /**
   * Put the main conversation and the side chats on the main slot. Each follows main from then on, so this changes
   * only a chat from before slots, which held main's model as it was, and on each later start writes nothing.
   */
  async applyMain(): Promise<void> {
    for (const session of [ROOT_SESSION, ...this.chats.list().map((chat) => chat.session)]) {
      await this.#configure(session);
    }
  }

  /** Set a top-level conversation up like the main one, following `slot`; without browse unless `browse`. */
  async #configure(session: string, slot: Slot = "main", { browse = false } = {}): Promise<void> {
    const conversation = await this.harness.conversation(session);
    await conversation.configure(
      {
        ...this.harness.agentDefaults(),
        ...slotModel(slot),
        extensions: { remove: browse ? [] : [this.browse] }
      },
      BACKGROUND_CONTEXT
    );
  }

  /** A side chat: a new top-level conversation set up like the main one, sharing its memory; the user's, or one `opener` opened with the chats tool. */
  async newChat(opener?: Opener): Promise<string> {
    const { id } = await this.harness.sessions.create();
    await this.#configure(id);
    this.chats.add(id, opener);

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

/** What Access lets through signed out: the routes that take their own tokens, webhooks, the public sites, then the public files. */
function signedOut(request: Request, env: Env, url: URL): Promise<Response> {
  return (
    tokenRoute(request, env, url) ??
    peerRoute(request, env, url) ??
    hookRoute(request, env, url) ??
    publicSiteRoute(request, env, url) ??
    env.ASSETS.fetch(request)
  );
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
      // own tokens (src/runners.ts, src/peers/peers.ts) and never with the user's, webhooks, whose URL holds their token
      // (src/inbound/routes.ts), and the manifest and icons iOS fetches without a cookie.
      if (bypassed(url.pathname)) return signedOut(request, env, url);

      const refused = await access.refuse(request, env);

      if (refused) return refused;

      const owner =
        ownerRoute(request, env, url) ??
        sandboxRoute(request, env, url) ??
        backupRoute(request, env, url) ??
        siteRoute(request, env, url) ??
        inboundRoute(request, env, url) ??
        browseRoute(request, env, url);

      if (owner) return owner;

      const file = /^\/files\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];

      if (file && request.method === "GET") return download(request, env.FILES, file);

      if (url.pathname === "/api/media") return uploadMedia(request, env.FILES);

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
    },

    /** Mail to ky's address, sent here by an Email Routing rule (src/mail.ts). */
    async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
      if (message.rawSize > MAIL_BYTES) return message.setReject("This mail is too large for ky.");
      const mail = await readMail(message.raw, { from: message.from, to: message.to });

      await env.PiAgent.getByName("me").mailReceived(mail);
    }
  } satisfies ExportedHandler<Env>;
}

export default worker(new Access());
