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
import {
  RUNNER_QUERY,
  runnerOf,
  runnerTag,
  type MachineHub,
  type RunnerReport
} from "./machines";
import { checkInput, imagesOf } from "./images";
import type { ChatList } from "./chats";
import type { PiClientMessage, PiServerMessage } from "./protocol";
import type { FileStore } from "./files";
import type { Models } from "./models";
import type { TaskFeed } from "./tasks";

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

function runnerFromRequest(request: Request): string | undefined {
  const machine = new URL(request.url).searchParams.get(RUNNER_QUERY);

  if (machine === null || machine === "") return undefined;

  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(machine)) {
    throw new Error(`Invalid machine name ${JSON.stringify(machine)}`);
  }

  return machine;
}

function sessionOf(tags: readonly string[]): string | undefined {
  const tag = tags.find((candidate) =>
    candidate.startsWith(SESSION_TAG_PREFIX)
  );

  return tag?.slice(SESSION_TAG_PREFIX.length);
}

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
  readonly #chats: ChatList;
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
    chats: ChatList,
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
    this.#chats = chats;
    this.#newChat = newChat;
    this.#version = version;
    chats.onChange(() => {
      const message = this.#chatsMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
    });
    feed.onChange(() => this.broadcastTasks());
    files.onChange(() => this.broadcastTasks());
    models.settings.onChange(() => {
      const message = this.#settingsMessage();

      for (const socket of this.#getWebSockets(UI_TAG)) send(socket, message);
    });
  }

  #chatsMessage(): PiServerMessage {
    return { type: "chats", chats: this.#chats.list() };
  }

  #settingsMessage(): PiServerMessage {
    return { type: "settings", settings: this.#models.settings.view() };
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

        return machine
          ? [runnerTag(machine)]
          : [sessionTag(sessionFromRequest(ctx.request, ROOT_SESSION)), UI_TAG];
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

  async close(): Promise<void> {
    const watches = [...this.#watches.values()];
    this.#watches.clear();
    await Promise.all(watches.map((watch) => watch.stop()));
  }

  async #onConnect(connection: Connection, ctx: ConnectionContext) {
    const machine = runnerFromRequest(ctx.request);

    if (machine) {
      this.#hub.seen(machine);
      this.broadcastTasks();

      return;
    }

    const session = sessionFromRequest(ctx.request, ROOT_SESSION);

    send(connection, {
      type: "hello",
      session,
      version: this.#version,
      tools: this.#registry
        .snapshot()
        .tools()
        .map(({ tool }) => ({ name: tool.name, description: tool.description }))
    });
    send(connection, this.#tasksMessage());
    send(connection, this.#settingsMessage());
    send(connection, this.#chatsMessage());
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
    const machine = runnerOf(connection.tags);

    if (machine) {
      this.#hub.seen(machine);
      this.broadcastTasks();

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

  async #onMessage(connection: Connection, raw: WebSocketMessage) {
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return;
    const machine = runnerOf(connection.tags);

    if (machine) {
      let report: RunnerReport;

      try {
        // SAFETY: only an authenticated runner gets a runner socket, and it sends RunnerReports.
        report = JSON.parse(raw) as RunnerReport;
      } catch {
        return;
      }

      await this.#hub.onReport(machine, report);

      if (report.type === "hello") this.broadcastTasks();

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

  async #dispatch(
    connection: Connection,
    session: PiSessionId,
    message: PiClientMessage
  ): Promise<JsonValue> {
    const handle = this.#harness.session(session);

    switch (message.type) {
      case "submit": {
        // The main session and side chats run on the main slot; every other session is a subagent's.
        const chat = this.#chats.has(session);

        const slot = session === ROOT_SESSION || chat ? "main" : "subagents";

        const problem =
          checkInput(message.input) ??
          (imagesOf(message.input).length > 0 ? await this.#models.imageSupport(slot) : null);

        if (problem !== null) throw new Error(problem);

        if (chat) this.#chats.touch(session, textOf(message.input));

        // Pass only the options the client set.
        const options: SubmitOptions = {};

        if (message.whenBusy) options.whenBusy = message.whenBusy;

        if (message.operationId) options.operationId = message.operationId;

        return await handle.submit(message.input, options);
      }

      case "abort":
        return await handle.abort();
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
        const { provider, modelId, thinkingLevel } = this.#models.settings.set(message.slot, message.setting);

        return { provider, modelId, thinkingLevel };
      }

      case "new-chat":
        return { session: await this.#newChat() };
      case "stop-all":
        await this.#stopTasks(this.#feed.list().map((task) => task.id));

        return null;
      default:
        // SAFETY: the switch covers every known type, so `message` is `never` here; at runtime it is a parsed object.
        throw new Error(
          `Unknown pi message type ${JSON.stringify((message as { type: string }).type)}`
        );
    }
  }
}
