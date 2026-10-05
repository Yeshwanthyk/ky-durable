import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ChatRow, FileRow, MachineInfo, PiServerMessage, SettingsView, TaskRow } from "../protocol";

/**
 * Decoders for what ky sends over its sockets, shared by the worker e2e
 * tests, the CLI harness and the Playwright suite. Each frame is checked
 * against a typebox schema before it is used. Nested records the tests only
 * pass along (pi's events, task rows, settings) are checked by the fields
 * that tell them apart and typed by the server's own types.
 */

const Event = Type.Unsafe<AgentEvent>(Type.Object({ type: Type.String() }));

const Task = Type.Unsafe<TaskRow>(
  Type.Object({ id: Type.String(), kind: Type.String(), worker: Type.String(), status: Type.String() })
);

const Machine = Type.Unsafe<MachineInfo>(Type.Object({ name: Type.String(), online: Type.Boolean() }));

const File = Type.Unsafe<FileRow>(Type.Object({ id: Type.String(), task: Type.String() }));

const Chat = Type.Unsafe<ChatRow>(Type.Object({ session: Type.String(), title: Type.String() }));

const Settings = Type.Unsafe<SettingsView>(
  Type.Object({ providers: Type.Array(Type.Object({ id: Type.String() })), slots: Type.Object({}) })
);

const Json = Type.Unsafe<JsonValue>(Type.Any());

const ServerFrame = Type.Union([
  Type.Object({
    type: Type.Literal("hello"),
    session: Type.String(),
    tools: Type.Array(Type.Object({ name: Type.String(), description: Type.String() })),
    version: Type.String()
  }),
  Type.Object({ type: Type.Literal("events"), session: Type.String(), events: Type.Array(Event) }),
  Type.Object({
    type: Type.Literal("tasks"),
    tasks: Type.Array(Task),
    machines: Type.Array(Machine),
    files: Type.Array(File)
  }),
  Type.Object({ type: Type.Literal("chats"), chats: Type.Array(Chat) }),
  Type.Object({ type: Type.Literal("settings"), settings: Settings }),
  Type.Object({ type: Type.Literal("result"), id: Type.String(), result: Json }),
  Type.Object({ type: Type.Literal("error"), id: Type.Optional(Type.String()), message: Type.String() })
]);

const RunnerCommand = Type.Union([
  Type.Object({
    type: Type.Literal("run"),
    seq: Type.Number(),
    task: Type.String(),
    prompt: Type.String(),
    session: Type.Union([Type.String(), Type.Null()])
  }),
  Type.Object({ type: Type.Literal("stop"), seq: Type.Number(), task: Type.String() })
]);

export type RunnerCommand = Static<typeof RunnerCommand>;

function parsed(data: string): JsonValue | undefined {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** A frame for the browser's socket; undefined for anything else, like the agents SDK's own frames. */
export function decodeServerFrame(data: string): PiServerMessage | undefined {
  const value = parsed(data);

  return Value.Check(ServerFrame, value) ? value : undefined;
}

/** A command for a runner's socket; undefined for anything else. */
export function decodeRunnerCommand(data: string): RunnerCommand | undefined {
  const value = parsed(data);

  return Value.Check(RunnerCommand, value) ? value : undefined;
}

const RunnerReport = Type.Union([
  Type.Object({ type: Type.Literal("hello"), active: Type.Array(Type.String()) }),
  Type.Object({ type: Type.Literal("ack"), seq: Type.Number() }),
  Type.Object({ type: Type.Literal("session"), task: Type.String(), session: Type.String() }),
  Type.Object({ type: Type.Literal("progress"), task: Type.String(), text: Type.String() }),
  Type.Object({
    type: Type.Literal("result"),
    task: Type.String(),
    ok: Type.Boolean(),
    text: Type.String(),
    session: Type.Union([Type.String(), Type.Null()])
  })
]);

export type RunnerReport = Static<typeof RunnerReport>;

/** A report from a runner's socket; undefined for anything else. */
export function decodeRunnerReport(data: string): RunnerReport | undefined {
  const value = parsed(data);

  return Value.Check(RunnerReport, value) ? value : undefined;
}

const NewChat = Type.Object({ session: Type.String() });

/** The session a `new-chat` command's result names; undefined if it names none. */
export function decodeNewChat(result: JsonValue): string | undefined {
  return Value.Check(NewChat, result) ? result.session : undefined;
}
