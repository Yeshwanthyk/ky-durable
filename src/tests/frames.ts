import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AutomationInfo, ChatRow, FileRow, MachineInfo, PiServerMessage, SettingsView, SkillRow, TaskRow } from "../protocol";

/**
 * Decoders for what ky sends over the browser's socket, shared by the worker
 * e2e tests, the CLI harness and the Playwright suite. The runner's socket
 * decodes with src/runner-protocol.ts, as both its ends do. Each frame is checked
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

const Skill = Type.Unsafe<SkillRow>(Type.Object({ name: Type.String(), status: Type.String() }));

const Automation = Type.Unsafe<AutomationInfo>(
  Type.Object({ id: Type.String(), title: Type.String(), status: Type.String() })
);

const Settings = Type.Unsafe<SettingsView>(
  Type.Object({ providers: Type.Array(Type.Object({ id: Type.String() })), slots: Type.Object({}) })
);

const Json = Type.Unsafe<JsonValue>(Type.Any());

const MemoryItem = Type.Union([
  Type.Object({ kind: Type.Literal("memory"), id: Type.Number(), date: Type.String(), text: Type.String() }),
  Type.Object({
    kind: Type.Literal("block"),
    block: Type.String(),
    text: Type.Union([Type.String(), Type.Null()]),
    from: Type.String(),
    to: Type.String()
  })
]);

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
  Type.Object({ type: Type.Literal("skills"), skills: Type.Array(Skill) }),
  Type.Object({
    type: Type.Literal("soul"),
    soul: Type.Object({ body: Type.String(), version: Type.Number(), updated_at: Type.Number() })
  }),
  Type.Object({
    type: Type.Literal("memory"),
    memory: Type.Object({
      count: Type.Number(),
      newest: Type.Union([Type.String(), Type.Null()]),
      items: Type.Array(MemoryItem)
    })
  }),
  Type.Object({ type: Type.Literal("automations"), automations: Type.Array(Automation) }),
  Type.Object({ type: Type.Literal("settings"), settings: Settings }),
  Type.Object({ type: Type.Literal("result"), id: Type.String(), result: Json }),
  Type.Object({ type: Type.Literal("error"), id: Type.Optional(Type.String()), message: Type.String() })
]);

/** JSON text as a value, or undefined when it is not JSON. Check the value with a schema before use. */
export function parsed(data: string): JsonValue | undefined {
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

const NewChat = Type.Object({ session: Type.String() });

/** The session a `new-chat` command's result names; undefined if it names none. */
export function decodeNewChat(result: JsonValue): string | undefined {
  return Value.Check(NewChat, result) ? result.session : undefined;
}

const Versions = Type.Array(Type.Object({ id: Type.Number(), action: Type.String(), actor: Type.String() }));

/** The version ids a `skill-history` command's result lists, newest first. */
export function decodeSkillVersions(result: JsonValue): number[] {
  return Value.Check(Versions, result) ? result.map((each) => each.id) : [];
}
