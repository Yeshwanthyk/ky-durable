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
import { Guard } from "typebox/guard";
import { ClientMessageSchema, refusedFrame } from "./client-messages";
import { parseOr } from "./core/decode";
import {
  decodeReport,
  isPipeReport,
  type MachineChange,
  type MachineHub,
  type ObjectFrame,
  OUTDATED,
  PAIRING_HEADER,
  PROTOCOL,
  REPLACED,
  REVOKED,
  runnerOf,
  runnerPathMachine,
  runnerTag
} from "./machines/contract";
import type { RunnerPipe } from "./pipe";
import { checkInput, imagesOf } from "./images";
import type { AutomationAction, Automations } from "./automations/contract";
import type { ChatList } from "./chats";
import type { Avatars } from "./avatars";
import type { Memory, Presence, Soul } from "./dreaming/contract";
import { mentions, type Skills, type Specialists } from "./skills/contract";
import { BACKGROUND } from "./background";
import type { PiClientMessage, PiServerMessage, PiToolInfo } from "./protocol";
import type { FileStore } from "./files";
import type { Models } from "./models";
import type { Subscriptions } from "./subscriptions";
import { type MailDesk, mailApprove, mailDisallow, mailDiscard, mailView } from "./mail";
import { type GroupChats, type GroupDesk, type PeerDesk, peerInvite, peerList, peerPair, peerRemove } from "./peers/wiring";
import type { ExecutorLink } from "./executor";
import type { NotSetUp, Setup } from "./setup";
import type { TaskFeed } from "./automations/contract";

const SESSION_TAG_PREFIX = "pi-session:";

const SESSION_QUERY = "session";

/** Every browser socket, whatever session it follows. */
const UI_TAG = "ui";

/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

/** The submit options a client set; ones it left out stay absent. */
type SubmitOptions = { whenBusy?: PiWhenBusy; operationId?: string };

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
  readonly #chats: ChatList;
  readonly #skills: Skills;
  readonly #soul: Soul;
  readonly #avatars: Avatars;
  readonly #specialists: Specialists;
  readonly #group: GroupDesk;
  readonly #groups: GroupChats;
  readonly #memory: Memory;
  readonly #automations: Automations;
  readonly #presence: Presence;
  readonly #setup: Setup;
  readonly #notSetUp: () => readonly NotSetUp[];
  readonly #version: string;
  /** Makes a side chat: a new top-level session set up like the main one. */
  readonly #newChat: () => Promise<PiSessionId>;

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
    chats: ChatList,
    skills: Skills,
    soul: Soul,
    avatars: Avatars,
    specialists: Specialists,
    group: GroupDesk,
    groups: GroupChats,
    memory: Memory,
    automations: Automations,
    presence: Presence,
    setup: Setup,
    /** What this deploy has no config for now, sent with the setup. */
    notSetUp: () => readonly NotSetUp[],
    newChat: () => Promise<PiSessionId>,
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
    this.#chats = chats;
    this.#skills = skills;
    this.#soul = soul;
    this.#avatars = avatars;
    this.#specialists = specialists;
    this.#group = group;
    this.#groups = groups;
    this.#memory = memory;
    this.#automations = automations;
    this.#presence = presence;
    this.#setup = setup;
    this.#notSetUp = notSetUp;
    this.#newChat = newChat;
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
    specialists.onChange(() => {
      const message = this.#specialistsMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
    });
    memory.onChange(() => {
      const message = this.#memoryMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
    });
    automations.onChange(() => {
      this.#broadcastAutomations().catch((error) => console.warn("automations not sent", error));
    });
    feed.onChange(() => this.broadcastTasks());
    hub.onChange(() => this.broadcastTasks());
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
    // A machine that shares VibeProxy sets it up.
    models.onChange(() => {
      broadcastSettings();
      broadcastSetup();
    });
    setup.onChange(broadcastSetup);
    subscriptions.onChange(() => {
      this.#broadcastSubscriptions().catch((error) => console.warn("subscriptions not sent", error));
    });
  }

  async #executorMessage(): Promise<PiServerMessage> {
    return { type: "executor", executor: await this.#executor.view() };
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

  #specialistsMessage(): PiServerMessage {
    return { type: "specialists", specialists: this.#specialists.views() };
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
    try {
      if (message.create) this.#specialists.create(message.specialist, message.draft, "user");
      else this.#specialists.set(message.specialist, message.draft);

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
        const pairing = ctx.request.headers.get(PAIRING_HEADER) ?? undefined;

        return this.#hub.pairedAs(machine, pairing) ? [runnerTag(machine), `${PAIRING_TAG_PREFIX}${pairing}`] : [REFUSED_TAG];
      },
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#onClose(connection),
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

    // A booking that fails must not keep the page from opening; the next connect tries again.
    if (Guard.IsString(zone) && zone) {
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

  async #onClose(connection: Connection) {
    if (connection.tags.includes(REFUSED_TAG)) return;
    const machine = runnerOf(connection.tags);

    if (machine) {
      this.#hub.seen(machine);
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

      if (task.kind === "machine") await this.#hub.stop(task);
      else if (task.session !== null) await this.#harness.session(task.session).abort();
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
    await this.#hub.onReport(machine, report);

    if (report.type !== "hello") return;
    this.broadcastTasks();
    // The ports it shares, and its coming online, may move a runner-local provider to it.
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

    if (chat) this.#chats.touch(session, textOf(message.input));

    // A leading @id is for that specialist, and a group chat's specialists may take up the rest: they reply
    // in the chat themselves. Only here, a user's message from the socket, is a message ever routed.
    if (chat || session === ROOT_SESSION) {
      // Only a message the user sends counts as being here: a tab that reconnects in the night does not.
      this.#presence.seen();
      const all = this.#specialists.list();
      const text = textOf(message.input);
      const unknown = all.length === 0 ? undefined : mentions(text).find((id) => !this.#specialists.has(id));

      if (unknown !== undefined) throw new Error(`No specialist @${unknown}. Specialists: ${all.map((each) => `@${each.id}`).join(", ")}`);

      const theirs = all.length === 0 ? undefined : await this.#group.submit(session, message.input, text, message.operationId ?? crypto.randomUUID());

      if (theirs !== undefined) return theirs;
    }

    // Pass only the options the client set.
    const options: SubmitOptions = {};

    if (message.whenBusy) options.whenBusy = message.whenBusy;

    if (message.operationId) options.operationId = message.operationId;

    return await this.#harness.session(session).submit(message.input, options);
  }

  /**
   * Withdraw a queued message. Unlike the harness's own withdraw, one pi has already placed is left
   * alone: the run it joined goes on, and the answer is false.
   */
  async #withdraw(session: PiSessionId, operationId: string): Promise<boolean> {
    const conversation = await this.#harness.conversation(session);
    const record = await (await this.#harness.storage()).submissionByRequest(conversation.id, operationId, BACKGROUND);

    if (record?.status !== "queued") return false;

    return (await (await this.#harness.pi()).abortSubmission(record.id, BACKGROUND, conversation.id)) === "aborted";
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
    const { tasks, submissions } = await pi.inspect(BACKGROUND);
    const queued = submissions.some((each) => each.conversationId === conversation.id && each.type === "input" && each.status === "queued");

    if (!queued) return false;

    for (const { record } of tasks) {
      if (record.kind === "pi.tool" && record.conversationId === conversation.id && !record.background && !record.abortRequested) {
        await pi.abortTask(record.id, BACKGROUND);
      }
    }

    return true;
  }

  /** What each action from Activity does to one automation, by id. */
  readonly #automationActions: AutomationActions = {
    pause: (id) => this.#automations.pause(id),
    resume: (id) => this.#automations.resume(id),
    archive: (id) => this.#automations.archive(id),
    unarchive: (id) => this.#automations.unarchive(id),
    run: (id) => this.#automations.run(id),
    delete: (id) => this.#automations.delete(id)
  };

  /** What each client message does, by its type. */
  readonly #handlers: Handlers = {
    submit: (message, _connection, session) => this.#submit(session, message),
    abort: (_message, _connection, session) => this.#harness.session(session).abort(),
    withdraw: (message, _connection, session) => this.#withdraw(session, message.operationId),
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
      this.#hub.configure(message.machine, change);

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
    "task-steps": (message) => this.#feed.log(message.task),
    "memory-search": (message) => this.#memory.search(message.query),
    "memory-zoom": (message) => this.#memory.children(message.block),
    "memory-forget": (message) => this.#memory.forget(message.block),
    "automation-save": (message) => this.#saveAutomation(message),
    automation: (message) => this.#automationActions[message.action](message.automation),
    "set-check-ins": async (message) => {
      await this.#automations.setCheckIns(message.on);

      return null;
    }
  };
}
