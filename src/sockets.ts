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
import type { Automations } from "./automations/automations";
import type { ChatList } from "./chats";
import type { Memory, Soul } from "./dreaming/contract";
import { mentions, type Skills, type Specialists } from "./skills/contract";
import type { GroupChats, GroupDesk } from "./peers/group";
import { BACKGROUND } from "./background";
import type { PiClientMessage, PiServerMessage, PiToolInfo } from "./protocol";
import type { FileStore } from "./files";
import type { Models } from "./models";
import type { Subscriptions } from "./subscriptions";
import { type PeerDesk, peerInvite, peerList, peerPair, peerRemove } from "./peers/peers";
import type { ExecutorLink } from "./executor";
import type { NotSetUp, Setup } from "./setup";
import type { TaskFeed } from "./automations/tasks";

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

type SpecialistCommand = Extract<PiClientMessage, { type: "specialist-save" | "specialist-brief" | "specialist-history" }>;

const isSpecialistCommand = (message: PiClientMessage): message is SpecialistCommand => message.type.startsWith("specialist-");

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
  readonly #feed: TaskFeed;
  readonly #hub: MachineHub;
  readonly #files: FileStore;
  readonly #models: Models;
  readonly #subscriptions: Subscriptions;
  readonly #peers: PeerDesk;
  readonly #pipe: RunnerPipe;
  readonly #executor: ExecutorLink;
  readonly #chats: ChatList;
  readonly #skills: Skills;
  readonly #soul: Soul;
  readonly #specialists: Specialists;
  readonly #group: GroupDesk;
  readonly #groups: GroupChats;
  readonly #memory: Memory;
  readonly #automations: Automations;
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
    pipe: RunnerPipe,
    executor: ExecutorLink,
    chats: ChatList,
    skills: Skills,
    soul: Soul,
    specialists: Specialists,
    group: GroupDesk,
    groups: GroupChats,
    memory: Memory,
    automations: Automations,
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
    this.#pipe = pipe;
    this.#executor = executor;
    this.#chats = chats;
    this.#skills = skills;
    this.#soul = soul;
    this.#specialists = specialists;
    this.#group = group;
    this.#groups = groups;
    this.#memory = memory;
    this.#automations = automations;
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

  #memoryMessage(): PiServerMessage {
    return { type: "memory", memory: this.#memory.view() };
  }

  /** The active and paused automations, each with the chat it reports to by name. */
  async #automationsMessage(): Promise<PiServerMessage> {
    const views = await this.#automations.list(false);

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
  async #saveAutomation(message: Extract<PiClientMessage, { type: "automation-save" }>): Promise<{ refused?: string }> {
    const saved =
      message.automation === undefined
        ? await this.#automations.create(message.draft, "user")
        : await this.#automations.update(message.automation, message.draft);

    return "refused" in saved ? { refused: saved.refused } : {};
  }

  /** The panel's specialist commands; a save that is refused says why, as an automation's does. */
  #specialist(message: SpecialistCommand): JsonValue {
    const id = message.specialist;

    if (message.type === "specialist-save") {
      try {
        if (message.create) this.#specialists.create(id, message.draft, "user");
        else this.#specialists.set(id, message.draft);

        return {};
      } catch (error) {
        return { refused: error instanceof Error ? error.message : String(error) };
      }
    }

    if (!this.#specialists.has(id)) throw new Error(`No specialist @${id}`);

    return message.type === "specialist-brief" ? this.#specialists.brief(id).apply(message.change, "user") : this.#specialists.brief(id).history();
  }

  /** Pause, resume, archive, run or delete an automation as the user; the result says what happened. */
  async #automation(message: Extract<PiClientMessage, { type: "automation" }>): Promise<string> {
    switch (message.action) {
      case "pause":
        return await this.#automations.pause(message.automation);
      case "resume":
        return await this.#automations.resume(message.automation);
      case "archive":
        return await this.#automations.archive(message.automation);
      case "run":
        return await this.#automations.run(message.automation);
      case "delete":
        return await this.#automations.delete(message.automation);
      default:
        throw new Error(`Unknown automation action ${JSON.stringify(message.action)}`);
    }
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

    if (Guard.IsString(zone) && zone) this.#automations.setZone(zone);
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

    let message: PiClientMessage;

    try {
      // SAFETY: only an authenticated client gets a socket; #dispatch throws on a type it does not know.
      message = JSON.parse(raw) as PiClientMessage;
    } catch {
      send(connection, { type: "error", message: "Malformed JSON" });

      return;
    }

    const session = sessionOf(connection.tags) ?? ROOT_SESSION;

    try {
      const result = await this.#dispatch(connection, session, message);

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

  /** The user's message to a machine task, such as their comments on its changes. */
  #sendTask(id: string, text: string): void {
    const task = this.#feed.get(id);

    if (task?.kind !== "machine") throw new Error(`No machine task ${id}`);

    if (text.trim() === "") throw new Error("Write a message first");

    this.#hub.send(task, text);
  }

  /** A message for the session's agent, checked first: the purpose that runs it must read its images. */
  async #submit(session: PiSessionId, message: Extract<PiClientMessage, { type: "submit" }>): Promise<JsonValue> {
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

  async #dispatch(
    connection: Connection,
    session: PiSessionId,
    message: PiClientMessage
  ): Promise<JsonValue> {
    if (isSpecialistCommand(message)) return this.#specialist(message);
    const handle = this.#harness.session(session);

    switch (message.type) {
      case "submit":
        return await this.#submit(session, message);
      case "abort":
        return await handle.abort();
      case "withdraw":
        return await this.#withdraw(session, message.operationId);
      case "reset":
        await handle.reset(message.handoff);

        return null;
      case "resync":
        await this.#watch(connection, session);

        return null;
      case "stop-task":
        await this.#stopTasks([message.task]);

        return null;
      case "set-model": {
        const { provider, modelId, thinkingLevel } = this.#models.settings.set(message.purpose, message.choice);

        return { provider, modelId, thinkingLevel };
      }

      case "add-key":
        return await this.#models.addKey(message.vendor, message.key);
      case "remove-key":
        await this.#models.removeKey(message.provider);

        return null;
      case "set-machine": {
        const change: MachineChange = {};

        if (message.state !== undefined) change.state = message.state;

        if (message.note !== undefined) change.note = message.note;

        if (message.login !== undefined) change.login = message.login;
        this.#hub.configure(message.machine, change);

        return null;
      }

      case "set-claude":
        return await this.#subscriptions.setClaude(message.token);
      case "github-repos":
        return await this.#subscriptions.githubRepos(message.token);
      case "set-github":
        return await this.#subscriptions.setGithub(message.token, message.repos);
      case "remove-subscription":
        await this.#subscriptions.remove(message.kind);

        return null;
      case "set-executor":
        return await this.#executor.connect(message.url, message.token);
      case "remove-executor":
        await this.#executor.disconnect();

        return null;
      case "chatgpt-login":
        return await this.#subscriptions.chatgptLogin();
      case "chatgpt-poll":
        return await this.#subscriptions.chatgptPoll(message.login);
      case "set-repo":
        // The page that sets the repo is ky as the user reaches it. Its socket's URL survives hibernation.
        return this.#setup.setRepo(message.repo, connection.uri);
      case "peer-list":
        return await peerList(this.#peers);
      case "peer-invite":
        return await peerInvite(this.#peers, message.name);
      case "peer-pair":
        return await peerPair(this.#peers, message.name, message.address, message.code);
      case "peer-remove":
        return await peerRemove(this.#peers, message.name);
      case "new-chat":
        return { session: await this.#newChat() };
      case "chat-members":
        if (message.session !== ROOT_SESSION && !this.#chats.has(message.session)) throw new Error(`No chat ${message.session}`);

        this.#groups.setMembers(message.session, message.members);

        return null;
      case "archive-chat":
        if (!this.#chats.has(message.session)) throw new Error(`No side chat ${message.session}`);

        this.#chats.archive(message.session, message.archived === true);

        return null;
      case "rename-chat":
        if (!this.#chats.has(message.session)) throw new Error(`No side chat ${message.session}`);

        this.#chats.rename(message.session, message.title);

        return null;
      case "skill-change":
        return this.#skills.apply(message.change, "user");
      case "skill-history":
        return this.#skills.history(message.name);
      case "soul-change":
        return this.#soul.apply(message.change, "user");
      case "soul-history":
        return this.#soul.history();
      case "memory-search":
        return this.#memory.search(message.query);
      case "memory-zoom":
        return this.#memory.children(message.block);
      case "memory-forget":
        return this.#memory.forget(message.block);
      case "automation":
        return await this.#automation(message);
      case "automation-save":
        return await this.#saveAutomation(message);
      case "set-check-ins":
        await this.#automations.setCheckIns(message.on);

        return null;
      case "stop-all":
        await this.#stopTasks(this.#feed.list().map((task) => task.id));

        return null;
      case "send-task":
        this.#sendTask(message.task, message.message);

        return null;

      default:
        // SAFETY: the switch covers every known type, so `message` is `never` here; at runtime it is a parsed object.
        throw new Error(
          `Unknown pi message type ${JSON.stringify((message as { type: string }).type)}`
        );
    }
  }
}
