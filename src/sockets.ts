import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  AgentEventStream,
  RegistryReader,
  UserInput
} from "@earendil-works/pi-durable";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import {
  ROOT_SESSION,
  type PiHarness,
  type PiSessionId,
  type PiWhenBusy
} from "agents/harness/pi";
import Type, { type Static } from "typebox";
import { Guard } from "typebox/guard";
import { ClientMessageSchema, refusedFrame } from "./client-messages";
import { decodeOr, parseOr } from "./core/decode";
import { isRefusal } from "./core/refusal";
import {
  decodeReport,
  isPipeReport,
  type MachineChange,
  type MachineHub,
  type ObjectFrame,
  OUTDATED,
  PROTOCOL,
  REPLACED,
  REVOKED,
  runnerOf,
  runnerPathMachine,
  runnerTag
} from "./machines/contract";
import type { RunnerPipe } from "./machines/wiring";
import { checkInput, imagesOf, spokenText } from "./files/media";
import { withLateNote } from "./core/late";
import { CARD_ANSWER } from "./cards/contract";
import { AUTOMATION_SOURCE, type AutomationAction, type Automations, type TaskRow, type ZoneView } from "./automations/contract";
import type { ChatList } from "./chats/chats";
import type { Avatars, Setup } from "./avatars/wiring";
import { decodeVerdict, type DreamLedger, type Memory, type Presence, type Proactivity, type Recall, type Soul } from "./dreaming/contract";
import type { Verdicts } from "./dreaming/wiring";
import { mentions, type Skills, type Specialists } from "./skills/contract";
import { deleteSpecialist, type Leftovers } from "./skills/wiring";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { earlierAnswer, earlierPage } from "./earlier";
import type { PiClientMessage, PiServerMessage, PiToolInfo } from "./protocol";
import type { FileStore } from "./files/wiring";
import type { Models } from "./providers/wiring";
import type { Subscriptions } from "./subscriptions";
import { type MailDesk, mailApprove, mailDisallow, mailDiscard, mailView } from "./mail/wiring";
import type { Approvals } from "./approvals/approvals";
import type { ExecutorApprovals } from "./approvals/executor";
import { type GroupChats, type GroupDesk, type PeerDesk, peerInvite, peerList, peerPair, peerRemove } from "./peers/wiring";
import type { ExecutorLink } from "./executor/wiring";
import type { Missing as NotSetUp } from "./avatars/contract";
import type { Pushes } from "./push/wiring";
import { noticeIn, type Spend } from "./spend/wiring";
import type { TaskFeed } from "./automations/contract";
import { readHeader } from "./machines/contract";

const SESSION_TAG_PREFIX = "pi-session:";

const SESSION_QUERY = "session";

/** Every browser socket, whatever session it follows. */
const UI_TAG = "ui";

/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

/** The submit options a client set; ones it left out stay absent. */
type SubmitOptions = { whenBusy?: PiWhenBusy; operationId?: string };

/** How every automation run stands, as one string: it changes when a run starts, ends, or is charged. */
function runsKey(tasks: readonly TaskRow[]): string {
  return tasks
    .flatMap((task) => (task.source?.startsWith(AUTOMATION_SOURCE) ? `${task.id}:${task.status}:${task.finished_at}:${task.cost_usd}` : []))
    .join(",");
}

function sessionTag(session: PiSessionId): string {
  return `${SESSION_TAG_PREFIX}${session}`;
}

function sessionFromRequest(request: Request, fallback: PiSessionId): string {
  const session = new URL(request.url).searchParams.get(SESSION_QUERY);

  if (session === null || session === "") return fallback;

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(session)) {
    throw new Error(`Invalid pi session ${JSON.stringify(session)}`);
  }

  return session;
}

/** The machine a runner's socket names in its path, `/runner/<machine>`; undefined for a browser's socket. */
function runnerFromRequest(request: Request): string | undefined {
  return runnerPathMachine(new URL(request.url).pathname);
}

const PAIRING_TAG_PREFIX = "pairing:";

/** The tag of a runner socket whose pairing was not its machine's when it came: it gets a goodbye and nothing else. */
const REFUSED_TAG = "runner-refused";

/**
 * A browser connection's state, kept on the socket so it outlives hibernation: the time zone Cloudflare placed it
 * in, and whether the user is looking at its page now, as the page last said.
 */
const ConnectionState = Type.Object({ zone: Type.Optional(Type.String()), watching: Type.Optional(Type.Boolean()) });

type ConnectionState = Static<typeof ConnectionState>;

const stateOf = (connection: Connection): ConnectionState => decodeOr(ConnectionState, connection.state, {});

/** The time zone `connection` was placed in when it opened, if any. */
const zoneOf = (connection: Connection): string | null => stateOf(connection).zone ?? null;

/**
 * Whether the user is looking at ky on any of `connections`: a page that said it is shown and in focus. A page says
 * so as it opens and each time that changes, before iOS freezes it in the background; one that never said, an old
 * page's, counts as not looking, so at worst a reply pushes while it is open.
 */
export function watching(connections: Iterable<Connection>): boolean {
  for (const connection of connections) {
    if (connection.readyState === OPEN && stateOf(connection).watching === true) return true;
  }

  return false;
}

/** The tag every browser socket carries, whatever session it follows. */
export const BROWSER_TAG = UI_TAG;

function pairingOf(tags: readonly string[]): string | undefined {
  return tags.find((tag) => tag.startsWith(PAIRING_TAG_PREFIX))?.slice(PAIRING_TAG_PREFIX.length);
}

function sessionOf(tags: readonly string[]): string | undefined {
  const tag = tags.find((candidate) =>
    candidate.startsWith(SESSION_TAG_PREFIX)
  );

  return tag?.slice(SESSION_TAG_PREFIX.length);
}

/** Each client message, by its type. */
type ClientMessages = { [Message in PiClientMessage as Message["type"]]: Message };

/** What answers one type of message: its result, sent back by the message's id. */
type Handler<Type extends keyof ClientMessages> = (message: ClientMessages[Type], connection: Connection, session: PiSessionId) => JsonValue | Promise<JsonValue>;

/** Exactly one handler for each type of client message: one missing, or one extra, doesn't compile. */
type Handlers = { readonly [Type in keyof ClientMessages]: Handler<Type> };

/** One handler per action on an automation, so a new action can't go unhandled. */
type AutomationActions = { readonly [Action in AutomationAction]: (id: string) => Promise<string> | string };


function textOf(input: UserInput): string {
  if (!Array.isArray(input)) return String(input);

  return input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") || "Image";
}

/** `{}` once `work` is done, or `{ refused }` with why it threw. */
function refusable(work: () => void): JsonValue {
  try {
    work();

    return {};
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

function send(socket: WebSocket, message: PiServerMessage): void {
  if (socket.readyState !== OPEN) return;

  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket closed between the state check and the send.
  }
}

/** Tell a runner why its socket closes for good, then close it with `code`; its runner exits on these codes. */
function goodbye(socket: WebSocket, frame: Extract<ObjectFrame, { type: "goodbye" }>, code: number, reason: string): void {
  try {
    socket.send(JSON.stringify(frame));
    socket.close(code, reason);
  } catch {
    // Already closing.
  }
}

/**
 * App glue: this app's session protocol over the `WebSockets` capability,
 * built only on the harness's public API.
 *
 * Each socket follows one session, picked by `?session=`, through its own
 * `session.events()` stream: a `snapshot`, then one batch of pi's agent
 * events per commit. Commands on the socket call `session.submit()`,
 * `abort()`, and `reset()`. Watches live in memory, so the host calls
 * `reattach()` from its `onStart` to give sockets that outlived the last
 * isolate a new watch and a fresh snapshot.
 */
export class PiSessionSockets {
  readonly #harness: PiHarness;
  readonly #registry: RegistryReader;
  readonly #getWebSockets: (tag?: string) => WebSocket[];
  readonly #watches = new Map<WebSocket, AgentEventStream>();
  /** A steer waiting for the run's next tools to stop, by session; in memory, as the click that asked for it. */
  readonly #steering = new Map<PiSessionId, AgentEventStream>();
  readonly #feed: TaskFeed;
  readonly #hub: MachineHub;
  readonly #files: FileStore;
  readonly #models: Models;
  readonly #subscriptions: Subscriptions;
  readonly #peers: PeerDesk;
  readonly #mail: MailDesk;
  readonly #pipe: RunnerPipe;
  readonly #executor: ExecutorLink;
  readonly #approvals: Approvals;
  readonly #executorApprovals: ExecutorApprovals;
  readonly #chats: ChatList;
  readonly #skills: Skills;
  readonly #soul: Soul;
  readonly #avatars: Avatars;
  readonly #specialists: Specialists;
  readonly #group: GroupDesk;
  readonly #groups: GroupChats;
  readonly #memory: Memory;
  readonly #ledger: DreamLedger;
  readonly #automations: Automations;
  readonly #presence: Presence;
  readonly #proactivity: Proactivity;
  readonly #verdicts: Verdicts;
  /** This device's notifications, from Settings › Proactivity. */
  readonly #pushes: Pushes;
  /** Turn-start recall, for the chips under the user's messages. */
  readonly #recall: Recall;
  readonly #setup: Setup;
  readonly #spend: Spend;
  readonly #notSetUp: () => readonly NotSetUp[];
  readonly #version: string;
  /** Makes a side chat: a new top-level session set up like the main one. */
  readonly #newChat: () => Promise<PiSessionId>;
  /** The Vault and the browser, for what a deleted specialist leaves. */
  readonly #leftovers: Pick<Leftovers, "kept" | "browser">;

  constructor(
    harness: PiHarness,
    /** The registry pi was opened with, for the tool list sent on connect. */
    registry: RegistryReader,
    getWebSockets: (tag?: string) => WebSocket[],
    feed: TaskFeed,
    hub: MachineHub,
    files: FileStore,
    models: Models,
    subscriptions: Subscriptions,
    peers: PeerDesk,
    mail: MailDesk,
    pipe: RunnerPipe,
    executor: ExecutorLink,
    /** The approvals waiting on the user, and Executor's tool policies. */
    approvals: { readonly store: Approvals; readonly executor: ExecutorApprovals },
    chats: ChatList,
    skills: Skills,
    soul: Soul,
    avatars: Avatars,
    specialists: Specialists,
    group: GroupDesk,
    groups: GroupChats,
    memory: Memory,
    ledger: DreamLedger,
    automations: Automations,
    presence: Presence,
    proactivity: Proactivity,
    verdicts: Verdicts,
    pushes: Pushes,
    recall: Recall,
    setup: Setup,
    spend: Spend,
    /** What this deploy has no config for now, sent with the setup. */
    notSetUp: () => readonly NotSetUp[],
    newChat: () => Promise<PiSessionId>,
    leftovers: Pick<Leftovers, "kept" | "browser">,
    /** The deploy's version id, sent in each hello. */
    version: string
  ) {
    this.#harness = harness;
    this.#registry = registry;
    this.#getWebSockets = getWebSockets;
    this.#feed = feed;
    this.#hub = hub;
    this.#files = files;
    this.#models = models;
    this.#subscriptions = subscriptions;
    this.#peers = peers;
    this.#mail = mail;
    this.#pipe = pipe;
    this.#executor = executor;
    this.#approvals = approvals.store;
    this.#executorApprovals = approvals.executor;
    this.#chats = chats;
    this.#skills = skills;
    this.#soul = soul;
    this.#avatars = avatars;
    this.#specialists = specialists;
    this.#group = group;
    this.#groups = groups;
    this.#memory = memory;
    this.#ledger = ledger;
    this.#automations = automations;
    this.#presence = presence;
    this.#proactivity = proactivity;
    this.#verdicts = verdicts;
    this.#pushes = pushes;
    this.#recall = recall;
    this.#setup = setup;
    this.#spend = spend;
    this.#notSetUp = notSetUp;
    this.#newChat = newChat;
    this.#leftovers = leftovers;
    this.#version = version;
    chats.onChange(() => {
      const message = this.#chatsMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
      // An automation names the chat it reports to by its title.
      this.#broadcastAutomations().catch((error) => console.warn("automations not sent", error));
    });
    groups.onChange(() => {
      const message = this.#chatsMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
    });
    skills.onChange(() => {
      const message = this.#skillsMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
    });
    soul.onChange(() => {
      const message = this.#soulMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
    });
    avatars.onChange(() => {
      const message = this.#avatarsMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
    });
    specialists.onChange(() => this.#broadcastSpecialists());
    approvals.store.onChange(() => this.#broadcastApprovals());
    approvals.executor.onPolicies(() => {
      this.#broadcastExecutorView().catch((error) => console.warn("executor not sent", error));
    });
    // A block made for a message shows as a chip under it, in the browsers following that chat.
    recall.onShown((session, recalled) => {
      for (const socket of this.#getWebSockets(sessionTag(session))) send(socket, { type: "recalled", session, recalls: [recalled] });
    });
    memory.onChange(() => {
      const message = this.#memoryMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
    });
    automations.onChange(() => {
      this.#broadcastAutomations().catch((error) => console.warn("automations not sent", error));
    });
    feed.onChange((tasks) => {
      this.broadcastTasks();
      // A routine's view carries its runs: send it again when one starts or ends, not on each step.
      const runs = runsKey(tasks);

      if (runs === this.#runsKey) return;
      this.#runsKey = runs;
      this.#broadcastAutomations().catch((error) => console.warn("automations not sent", error));
    });
    // A sandbox or a Mac coming or going changes what a specialist's settings offer.
    hub.onChange(() => {
      this.broadcastTasks();
      this.#broadcastSpecialists();
    });
    files.onChange(() => this.broadcastTasks());

    const broadcastSettings = () => {
      const message = this.#settingsMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
    };

    const broadcastSetup = () => {
      const message = this.#setupMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
    };

    models.settings.onChange(broadcastSettings);
    // A model source coming or going changes what Settings lists as set up.
    models.onChange(() => {
      broadcastSettings();
      broadcastSetup();
    });
    setup.onChange(broadcastSetup);
    subscriptions.onChange(() => {
      this.#broadcastSubscriptions().catch((error) => console.warn("subscriptions not sent", error));
      // A sign-in or sign-out can change what the model sources place, ChatGPT's above all.
      models.refresh().catch((error) => console.warn("models not refreshed", error));
    });
  }

  #approvalsMessage(): PiServerMessage {
    return { type: "approvals", approvals: this.#approvals.cards() };
  }

  #broadcastApprovals(): void {
    const message = this.#approvalsMessage();

    for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
  }

  async #executorMessage(): Promise<PiServerMessage> {
    return { type: "executor", executor: { ...(await this.#executor.view()), policies: this.#executorApprovals.policies() } };
  }

  async #broadcastExecutorView(): Promise<void> {
    const message = await this.#executorMessage();

    for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
  }

  /** Send Executor's state and the tools it brought or took away; the agent calls it once they are installed. */
  async broadcastExecutor(): Promise<void> {
    const message = await this.#executorMessage();

    for (const socket of this.#getWebSockets(UI_TAG)) {
      send(socket, message);
      send(socket, { type: "tools", tools: this.#tools() });
    }
  }

  #tools(): PiToolInfo[] {
    return this.#registry
      .snapshot()
      .tools()
      .map(({ tool }) => ({ name: tool.name, description: tool.description }));
  }

  async #subscriptionsMessage(): Promise<PiServerMessage> {
    return { type: "subscriptions", subscriptions: await this.#subscriptions.view() };
  }

  async #broadcastSubscriptions(): Promise<void> {
    const message = await this.#subscriptionsMessage();

    for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
  }

  #skillsMessage(): PiServerMessage {
    return { type: "skills", skills: this.#skills.all() };
  }

  #broadcastSpecialists(): void {
    const message = this.#specialistsMessage();

    for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
  }

  #specialistsMessage(): PiServerMessage {
    return { type: "specialists", specialists: this.#specialists.views(), access: this.#specialists.access() };
  }

  #soulMessage(): PiServerMessage {
    return { type: "soul", soul: this.#soul.view() };
  }

  #avatarsMessage(): PiServerMessage {
    return { type: "avatars", avatars: this.#avatars.all() };
  }

  #memoryMessage(): PiServerMessage {
    return { type: "memory", memory: this.#memory.view() };
  }

  /** The active, paused and archived automations, each with the chat it reports to by name. */
  async #automationsMessage(): Promise<PiServerMessage> {
    const views = (await this.#automations.list()).filter((view) => view.status !== "done");

    return {
      type: "automations",
      automations: views.map((view) => ({ ...view, chat_label: this.#chatTitle(view.chat) })),
      checkIns: this.#automations.checkIns().on
    };
  }

  /** "main", or a side chat's title as the sidebar shows it. */
  #chatTitle(session: string): string {
    if (session === ROOT_SESSION) return "main";

    return this.#chats.list().find((chat) => chat.session === session)?.title || "a side chat";
  }

  async #broadcastAutomations(): Promise<void> {
    const message = await this.#automationsMessage();

    for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
  }

  /** Create or change an automation as the user; `{ refused }` says why it was not saved. */
  async #saveAutomation(message: ClientMessages["automation-save"]): Promise<{ refused?: string }> {
    const saved =
      message.automation === undefined
        ? await this.#automations.create(message.draft, "user")
        : await this.#automations.update(message.automation, message.draft);

    return "refused" in saved ? { refused: saved.refused } : {};
  }

  /** Create or change a specialist as the user; a save that is refused says why, as an automation's does. */
  #saveSpecialist(message: ClientMessages["specialist-save"]): JsonValue {
    return refusable(() =>
      message.create ? this.#specialists.create(message.specialist, message.draft, "user") : this.#specialists.set(message.specialist, message.draft)
    );
  }

  /** The user deletes a specialist; refused when there is none. */
  async #deleteSpecialist(id: string): Promise<JsonValue> {
    const left = { tasks: () => this.#feed.list(), stop: (ids: readonly string[]) => this.#stopTasks(ids), workflows: this.#automations, ...this.#leftovers };

    try {
      await deleteSpecialist(this.#specialists, id, left);

      return {};
    } catch (error) {
      return { refused: error instanceof Error ? error.message : String(error) };
    }
  }

  /** A specialist's brief, to change or read the history of; one that doesn't exist is an error. */
  #brief(specialist: string) {
    if (!this.#specialists.has(specialist)) throw new Error(`No specialist @${specialist}`);

    return this.#specialists.brief(specialist);
  }

  #chatsMessage(): PiServerMessage {
    return { type: "chats", chats: this.#chats.list(), main: this.#chats.mainUpdatedAt(), groups: this.#groups.all() };
  }

  #settingsMessage(): PiServerMessage {
    return { type: "settings", settings: this.#models.view() };
  }

  #setupMessage(): PiServerMessage {
    return { type: "setup", setup: { ...this.#setup.view(), missing: this.#notSetUp() } };
  }

  /** Send the task feed to every UI socket. */
  broadcastTasks(): void {
    const message = this.#tasksMessage();

    for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
  }

  /** Settings › Proactivity's time zone, as `connection` sees it. */
  #zoneView(connection: Connection): ZoneView {
    return { ...this.#automations.checkIns(), detected: zoneOf(connection) };
  }

  #tasksMessage(): PiServerMessage {
    return {
      type: "tasks",
      tasks: this.#feed.list(),
      machines: this.#hub.machines(),
      files: this.#files.list()
    };
  }

  options(): WebSocketsOptions {
    return {
      getConnectionTags: (_connection, ctx) => {
        const machine = runnerFromRequest(ctx.request);

        if (!machine) return [sessionTag(sessionFromRequest(ctx.request, ROOT_SESSION)), UI_TAG];
        // The Worker names the pairing the token was minted for; a removed or re-paired machine has another, or none.
        const pairing = readHeader(ctx.request.headers, "pairing") ?? undefined;

        return this.#hub.pairedAs(machine, pairing) ? [runnerTag(machine), `${PAIRING_TAG_PREFIX}${pairing}`] : [REFUSED_TAG];
      },
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection, code) => this.#onClose(connection, code),
        onError: (connection) => this.#unwatch(connection)
      }
    };
  }

  /** Give every hibernated socket a new watch after the object restarts. */
  async reattach(): Promise<void> {
    if (this.#getWebSockets().length === 0) return;

    // Sockets are found by tag, not tags by socket, so walk the sessions
    // and look up each one's tag.
    for (const { id } of await this.#harness.sessions.list()) {
      for (const socket of this.#getWebSockets(sessionTag(id))) {
        await this.#watch(socket, id);
      }
    }
  }

  async #onConnect(connection: Connection, ctx: ConnectionContext) {
    if (connection.tags.includes(REFUSED_TAG)) {
      goodbye(connection, { type: "goodbye", reason: "This machine is not paired with ky; pair it again." }, REVOKED, "Removed from ky; pair again.");

      return;
    }

    // A runner is online once it says hello.
    if (runnerFromRequest(ctx.request)) return;

    const session = sessionFromRequest(ctx.request, ROOT_SESSION);

    this.#setup.opened(ctx.request.url);
    // Cloudflare places the browser's connection in a time zone; check-ins are booked for the user's morning.
    const zone = ctx.request.cf?.timezone;

    // A booking that fails must not keep the page from opening; the object's next start books it again.
    if (Guard.IsString(zone) && zone) {
      // Kept on the connection: picking Automatic follows it at once.
      connection.setState({ zone });

      try {
        await this.#automations.setZone(zone);
      } catch (error) {
        console.warn("booking the dream in the user's zone failed", error);
      }
    }

    send(connection, {
      type: "hello",
      session,
      version: this.#version,
      tools: this.#tools()
    });
    send(connection, this.#tasksMessage());
    send(connection, this.#settingsMessage());
    send(connection, this.#setupMessage());
    send(connection, await this.#subscriptionsMessage());
    send(connection, await this.#executorMessage());
    send(connection, this.#approvalsMessage());
    send(connection, this.#chatsMessage());
    send(connection, this.#skillsMessage());
    send(connection, this.#soulMessage());
    send(connection, this.#specialistsMessage());
    send(connection, this.#avatarsMessage());
    send(connection, this.#memoryMessage());
    send(connection, await this.#automationsMessage());
    await this.#watch(connection, session);
  }

  async #watch(socket: WebSocket, session: PiSessionId): Promise<void> {
    await this.#unwatch(socket);
    const stream = await this.#harness.session(session).events();
    this.#watches.set(socket, stream);
    send(socket, { type: "events", session, events: [stream.snapshot] });
    const recalls = this.#recall.shown(session);

    if (recalls.length > 0) send(socket, { type: "recalled", session, recalls });
    stream.start(async (events) => {
      if (socket.readyState !== OPEN) {
        void this.#unwatch(socket);

        return;
      }

      send(socket, { type: "events", session, events });
    });
  }

  async #unwatch(socket: WebSocket): Promise<void> {
    const watch = this.#watches.get(socket);

    if (!watch) return;
    this.#watches.delete(socket);
    await watch.stop();
  }

  async #onClose(connection: Connection, code?: number) {
    if (connection.tags.includes(REFUSED_TAG)) return;
    const machine = runnerOf(connection.tags);

    if (machine) {
      this.#hub.seen(machine, code);
      this.#pipe.dropped(machine);
      this.broadcastTasks();
      await this.#models.refresh();

      return;
    }

    await this.#unwatch(connection);
  }

  /** Stop delegated work from the task list: one task, or all that are live. */
  async #stopTasks(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const task = this.#feed.get(id);

      if (!task || (task.status !== "queued" && task.status !== "working")) continue;

      if (task.kind === "machine") {
        await this.#hub.stop(task);
        continue;
      }

      if (task.session !== null) await this.#harness.session(task.session).abort();

      // A cloud task nothing is waiting on any more, as after a restart, would stay live: end it here.
      if (this.#feed.get(id)?.status === "working") this.#feed.update(id, { status: "stopped", summary: "Stopped" });
    }
  }

  /** The runner that said hello on `connection` is the machine's only one: close its other sockets. */
  #replaceRunner(connection: Connection, machine: string): void {
    // Agents tags each socket with its connection id.
    const own = new Set(this.#getWebSockets(connection.id));

    for (const socket of this.#getWebSockets(runnerTag(machine))) {
      if (own.has(socket) || socket.readyState !== OPEN) continue;

      try {
        socket.close(REPLACED, "Another ky-runner connected with this name.");
      } catch {
        // Already closing.
      }
    }
  }

  /** Close the machine's runner sockets for good: its token no longer works, and `reason` says what to do. */
  revokeRunner(machine: string, reason: string): void {
    for (const socket of this.#getWebSockets(runnerTag(machine))) {
      if (socket.readyState === OPEN) goodbye(socket, { type: "goodbye", reason }, REVOKED, "Removed from ky; pair again.");
    }
  }

  /** A frame on a runner's socket. */
  async #onReport(connection: Connection, machine: string, raw: string): Promise<void> {
    const decoded = decodeReport(raw);

    if (decoded.kind === "malformed") {
      // A broken runner: it must be fixed, not half-understood.
      connection.close(1008, "Malformed ky-runner report.");

      return;
    }

    if (decoded.kind === "outdated") {
      // A runner of another version: tell it which one ky speaks, so it can say to update it.
      const reason = `ky speaks runner protocol ${PROTOCOL} and this runner speaks ${decoded.protocol}; update ky-runner.`;
      goodbye(connection, { type: "goodbye", reason, expected: PROTOCOL }, OUTDATED, "Outdated ky-runner; update it.");
      // The user sees which side is behind, not only offline.
      this.#hub.refused(machine, decoded.protocol);

      return;
    }

    const { report } = decoded;

    // The machine was removed or paired again since this socket came: its pairing is over.
    if (!this.#hub.pairedAs(machine, pairingOf(connection.tags))) {
      goodbye(connection, { type: "goodbye", reason: "This machine is not paired with ky; pair it again." }, REVOKED, "Removed from ky; pair again.");

      return;
    }

    if (isPipeReport(report)) {
      this.#pipe.onReport(report);

      return;
    }

    if (report.type === "hello") this.#replaceRunner(connection, machine);
    await this.#hub.onReport(machine, report, connection.id);

    if (report.type !== "hello") return;
    this.broadcastTasks();
    // What it shares, and its coming online, can change what the model sources place.
    await this.#models.refresh();
  }

  async #onMessage(connection: Connection, raw: WebSocketMessage) {
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw) || connection.tags.includes(REFUSED_TAG)) return;
    const machine = runnerOf(connection.tags);

    if (machine) {
      await this.#onReport(connection, machine, raw);

      return;
    }

    const message = parseOr(ClientMessageSchema, raw, undefined);

    if (message === undefined) {
      send(connection, refusedFrame(raw));

      return;
    }

    const session = sessionOf(connection.tags) ?? ROOT_SESSION;

    try {
      const result = await this.#handle(message.type, message, connection, session);

      if (message.id !== undefined) {
        send(connection, { type: "result", id: message.id, result });
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);

      send(
        connection,
        message.id === undefined
          ? { type: "error", message: text }
          : { type: "error", id: message.id, message: text }
      );
    }
  }

  /** Answer a message with its type's handler. */
  #handle<Type extends keyof ClientMessages>(type: Type, message: ClientMessages[Type], connection: Connection, session: PiSessionId): JsonValue | Promise<JsonValue> {
    return this.#handlers[type](message, connection, session);
  }

  /** The user's message to a machine task, such as their comments on its changes. */
  #sendTask(id: string, text: string): void {
    const task = this.#feed.get(id);

    if (task?.kind !== "machine") throw new Error(`No machine task ${id}`);

    if (text.trim() === "") throw new Error("Write a message first");

    this.#hub.send(task, text);
  }

  /** A message for the session's agent, checked first: the purpose that runs it must read its images. */
  async #submit(session: PiSessionId, message: ClientMessages["submit"]): Promise<JsonValue> {
    // The main session and side chats run on the main purpose; every other session is the worker's.
    const chat = this.#chats.has(session);

    const purpose = session === ROOT_SESSION || chat ? "main" : "worker";

    // A submit with images waits for the purpose's provider probe: cached for 30s, up to 3s when stale.
    const problem =
      checkInput(message.input) ??
      (imagesOf(message.input).length > 0 ? await this.#models.imageSupport(purpose) : null);

    if (problem !== null) throw new Error(problem);

    if (chat) this.#chats.touch(session, spokenText(textOf(message.input)));

    // A message the page kept offline for long reaches the model with a note saying so; the thread drops the note.
    const input = withLateNote(message.input, message.waited);

    // A leading @id is for that specialist, and a group chat's specialists may take up the rest: they reply
    // in the chat themselves. Only here, a user's message from the socket, is a message ever routed.
    if (chat || session === ROOT_SESSION) {
      // Only a message the user sends counts as being here: a tab that reconnects in the night does not.
      this.#presence.seen();
      await noticeIn(this.#spend, await this.#harness.conversation(session));
      const all = this.#specialists.list();
      const text = textOf(message.input);
      const unknown = all.length === 0 ? undefined : mentions(text).find((id) => !this.#specialists.has(id));

      if (unknown !== undefined) throw new Error(`No specialist @${unknown}. Specialists: ${all.map((each) => `@${each.id}`).join(", ")}`);

      const theirs = all.length === 0 ? undefined : await this.#group.submit(session, input, text, message.operationId ?? crypto.randomUUID());

      if (theirs !== undefined) return await this.#keepAnswer(session, message, theirs);
    }

    // Pass only the options the client set.
    const options: SubmitOptions = {};

    if (message.whenBusy) options.whenBusy = message.whenBusy;

    if (message.operationId) options.operationId = message.operationId;

    return await this.#keepAnswer(session, message, await this.#harness.session(session).submit(input, options));
  }

  /**
   * A message that answers a card keeps what was chosen beside it, once the message is taken, so the card reads its
   * answer back from the record rather than the words. By the message's operation id, so a resend keeps it once.
   */
  async #keepAnswer(session: PiSessionId, message: ClientMessages["submit"], taken: JsonValue): Promise<JsonValue> {
    if (message.card === undefined) return taken;
    const conversation = await this.#harness.conversation(session);
    const requestId = `${message.operationId ?? message.id}:card`;

    await conversation.submit({ type: "write", entry: { kind: CARD_ANSWER, data: message.card }, requestId }, BACKGROUND_CONTEXT);

    return taken;
  }

  /**
   * Withdraw a queued message. Unlike the harness's own withdraw, one pi has already placed is left
   * alone: the run it joined goes on, and the answer is false.
   */
  async #withdraw(session: PiSessionId, operationId: string): Promise<boolean> {
    const conversation = await this.#harness.conversation(session);
    const record = await (await this.#harness.storage()).submissionByRequest(conversation.id, operationId, BACKGROUND_CONTEXT);

    if (record?.status !== "queued") return false;

    return (await (await this.#harness.pi()).abortSubmission(record.id, BACKGROUND_CONTEXT, conversation.id)) === "aborted";
  }

  /**
   * Steer now: abort the tool calls the run is waiting on, so pi's boundary after the round places
   * what is queued and the run goes on with it. Unlike `abort()`, nothing queued is withdrawn and
   * the run is not ended; aborting its generation instead would end it and leave the queue behind.
   * While the model is still writing there is nothing to stop yet, so the steer waits on the
   * session's events and stops each tool as it starts, until the queue goes in or the run ends.
   */
  async #steerNow(session: PiSessionId): Promise<null> {
    if (this.#steering.has(session)) return null;
    const stream = await this.#harness.session(session).events();

    if (!stream.snapshot.run || stream.snapshot.inbox.length === 0) {
      await stream.stop();

      return null;
    }

    this.#steering.set(session, stream);

    const done = async () => {
      if (this.#steering.get(session) !== stream) return;
      this.#steering.delete(session);
      await stream.stop();
    };

    stream.start(async (events) => {
      if (events.some((event) => event.type === "run_end" || (event.type === "inbox_update" && event.items.length === 0))) await done();
      else if (events.some((event) => event.type === "tool_execution_start")) await this.#stopRound(session);
    });

    // Watching first, so a tool that starts while this looks is stopped by the watch.
    if (!(await this.#stopRound(session))) await done();

    return null;
  }

  /** Abort the tool calls in flight in the session's run, while anything is queued; false once nothing is. */
  async #stopRound(session: PiSessionId): Promise<boolean> {
    const conversation = await this.#harness.conversation(session);
    const pi = await this.#harness.pi();
    const { tasks, submissions } = await pi.inspect(BACKGROUND_CONTEXT);
    const queued = submissions.some((each) => each.conversationId === conversation.id && each.type === "input" && each.status === "queued");

    if (!queued) return false;

    for (const { record } of tasks) {
      if (record.kind === "pi.tool" && record.conversationId === conversation.id && !record.background && !record.abortRequested) {
        await pi.abortTask(record.id, BACKGROUND_CONTEXT);
      }
    }

    return true;
  }

  /** What each action from Activity does to one automation, by id. */
  /** The automation runs' states when automations were last sent, so a step alone sends nothing. */
  #runsKey = "";

  readonly #automationActions: AutomationActions = {
    pause: (id) => this.#automations.pause(id),
    resume: (id) => this.#automations.resume(id),
    archive: (id) => this.#automations.archive(id),
    unarchive: (id) => this.#automations.unarchive(id),
    run: (id) => this.#automations.run(id),
    stop: (id) => this.#automations.stop(id),
    delete: (id) => this.#automations.delete(id)
  };

  /** What each client message does, by its type. */
  readonly #handlers: Handlers = {
    submit: (message, _connection, session) => this.#submit(session, message),
    abort: (_message, _connection, session) => this.#harness.session(session).abort(),
    withdraw: (message, _connection, session) => this.#withdraw(session, message.operationId),
    earlier: async (message, _connection, session) => earlierAnswer(await earlierPage(await this.#harness.conversation(session), message.before, BACKGROUND_CONTEXT)),
    "steer-now": (_message, _connection, session) => this.#steerNow(session),
    reset: async (message, _connection, session) => {
      await this.#harness.session(session).reset(message.handoff);

      return null;
    },
    resync: async (_message, connection, session) => {
      await this.#watch(connection, session);

      return null;
    },
    "stop-task": async (message) => {
      await this.#stopTasks([message.task]);

      return null;
    },
    "stop-all": async () => {
      await this.#stopTasks(this.#feed.list().map((task) => task.id));

      return null;
    },
    "send-task": (message) => {
      this.#sendTask(message.task, message.message);

      return null;
    },
    "set-machine": (message) => {
      const change: MachineChange = {};

      if (message.state !== undefined) change.state = message.state;

      if (message.note !== undefined) change.note = message.note;

      if (message.login !== undefined) change.login = message.login;
      const changed = this.#hub.change(message.machine, change);

      if (isRefusal(changed)) throw new Error(changed.refused);

      return null;
    },
    "set-model": (message) => {
      const { provider, modelId, thinkingLevel } = this.#models.settings.set(message.purpose, message.choice);

      return { provider, modelId, thinkingLevel };
    },
    "add-key": (message) => this.#models.addKey(message.vendor, message.key),
    "remove-key": async (message) => {
      await this.#models.removeKey(message.provider);

      return null;
    },
    // The page that sets the repo is ky as the user reaches it. Its socket's URL survives hibernation.
    "set-repo": (message, connection) => this.#setup.setRepo(message.repo, connection.uri),
    "set-claude": (message) => this.#subscriptions.setClaude(message.token),
    "github-repos": (message) => this.#subscriptions.githubRepos(message.token),
    "set-github": (message) => this.#subscriptions.setGithub(message.token, message.repos),
    "remove-subscription": async (message) => {
      await this.#subscriptions.remove(message.kind);

      return null;
    },
    "set-executor": (message) => this.#executor.connect(message.url, message.token),
    "remove-executor": async () => {
      await this.#executor.disconnect();

      return null;
    },
    "chatgpt-login": () => this.#subscriptions.chatgptLogin(),
    "chatgpt-poll": (message) => this.#subscriptions.chatgptPoll(message.login),
    "peer-list": () => peerList(this.#peers),
    "peer-invite": (message) => peerInvite(this.#peers, message.name),
    "peer-pair": (message) => peerPair(this.#peers, message.name, message.address, message.code),
    "peer-remove": (message) => peerRemove(this.#peers, message.name),
    "mail-view": () => mailView(this.#mail),
    "mail-approve": (message) => mailApprove(this.#mail, message.mail),
    "mail-discard": (message) => mailDiscard(this.#mail, message.mail),
    // Only the user's own socket decides an approval: no tool reaches here.
    "approval-decide": (message) => this.#approvals.onDecision(message.approval, message.action),
    "set-tool-policy": (message) => {
      this.#executorApprovals.setPolicy(message.tool, message.policy);

      return null;
    },
    "mail-disallow": (message) => mailDisallow(this.#mail, message.address),
    "new-chat": async () => ({ session: await this.#newChat() }),
    "archive-chat": (message) => {
      if (!this.#chats.has(message.session)) throw new Error(`No side chat ${message.session}`);

      this.#chats.archive(message.session, message.archived);

      return null;
    },
    "rename-chat": (message) => {
      if (!this.#chats.has(message.session)) throw new Error(`No side chat ${message.session}`);

      this.#chats.rename(message.session, message.title);

      return null;
    },
    "chat-members": (message) => {
      if (message.session !== ROOT_SESSION && !this.#chats.has(message.session)) throw new Error(`No chat ${message.session}`);

      this.#groups.setMembers(message.session, message.members);

      return null;
    },
    "skill-change": (message) => this.#skills.apply(message.change, "user"),
    "skill-history": (message) => this.#skills.history(message.name),
    "soul-change": (message) => this.#soul.apply(message.change, "user"),
    "soul-history": () => this.#soul.history(),
    "specialist-save": (message) => this.#saveSpecialist(message),
    "specialist-brief": (message) => this.#brief(message.specialist).apply(message.change, "user"),
    "specialist-history": (message) => this.#brief(message.specialist).history(),
    "specialist-access": (message) => refusable(() => this.#specialists.changeAccess(message.specialist, message.change)),
    "specialist-delete": (message) => this.#deleteSpecialist(message.specialist),
    "task-steps": (message) => this.#feed.log(message.task),
    "memory-search": (message) => this.#memory.search(message.query),
    "memory-zoom": (message) => this.#memory.children(message.block),
    "memory-forget": (message) => this.#memory.forget(message.block),
    "dream-ledger": () => this.#ledger.lastNight(),
    "dream-undo": (message) => this.#ledger.undo(message.entry),
    "automation-save": (message) => this.#saveAutomation(message),
    automation: (message) => this.#automationActions[message.action](message.automation),
    "post-verdict": (message) => this.#verdicts.judge(decodeVerdict(message.verdict)),
    "post-verdicts": () => this.#verdicts.view(),
    proactivity: () => this.#proactivity.view(),
    "set-proactivity": (message) => this.#proactivity.set(message.level),
    "set-looks": (message) => this.#proactivity.setLooks(message.looks),
    "set-right-away": (message) => this.#proactivity.setRightAway(message.most),
    spend: () => this.#spend.view(),
    "set-spend-cap": (message) => this.#spend.setCap(message.usd),
    "push-key": () => this.#pushes.key(),
    "push-subscribe": (message) => {
      this.#pushes.subscribe(message);

      return null;
    },
    "push-unsubscribe": (message) => {
      this.#pushes.unsubscribe(message.endpoint);

      return null;
    },
    watching: (message, connection) => {
      connection.setState({ ...stateOf(connection), watching: message.watching });

      return null;
    },
    "set-check-ins": async (message) => {
      await this.#automations.setCheckIns(message.on);

      return null;
    },
    zone: (_message, connection) => this.#zoneView(connection),
    "set-zone": async (message, connection) => {
      await (message.zone === null ? this.#automations.unpinZone(zoneOf(connection)) : this.#automations.pinZone(message.zone));

      return this.#zoneView(connection);
    }
  };
}
