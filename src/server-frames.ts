/**
 * Server → client: every frame ky sends on the browser's socket, and every answer an ask gets back, as
 * schemas. The page checks each frame against ServerFrameSchema on receipt, and each answer against its
 * ask's schema, so nothing it shows is a cast; the worker tests, the CLI harness and Playwright decode
 * with them too (src/tests/frames.ts). Nested records the page only passes along (pi's events, task
 * rows, settings) are checked by the fields that tell them apart and typed by the server's own types.
 *
 * Only typebox and types, so Node loads it as it is, as the harness does.
 */
import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-durable";
import Type, { type Static, type TSchema } from "typebox";
import { BloubSpecSchema } from "./avatar-spec";
import type {
  AutomationInfo,
  ChatGptCode,
  ChatGptState,
  ChatRow,
  ClientMessage,
  FileRow,
  MachineInfo,
  MemoryItem,
  MemorySearch,
  MailView,
  PeerInvite,
  PeerView,
  SettingsView,
  SetupView,
  SkillRow,
  SkillVersion,
  SoulVersion,
  SpecialistView,
  SubscriptionView,
  TaskLogStep,
  TaskRow
} from "./protocol";

const Text = Type.String();

const Texts = Type.Array(Text);

const Event = Type.Unsafe<AgentEvent>(Type.Object({ type: Text }));

const Task = Type.Unsafe<TaskRow>(Type.Object({ id: Text, kind: Text, worker: Text, status: Text }));

const Machine = Type.Unsafe<MachineInfo>(Type.Object({ name: Text, online: Type.Boolean() }));

const File = Type.Unsafe<FileRow>(Type.Object({ id: Text, task: Text }));

const Chat = Type.Unsafe<ChatRow>(Type.Object({ session: Text, title: Text }));

const Skill = Type.Unsafe<SkillRow>(Type.Object({ name: Text, status: Text }));

const Automation = Type.Unsafe<AutomationInfo>(Type.Object({ id: Text, title: Text, status: Text }));

const Settings = Type.Unsafe<SettingsView>(Type.Object({ providers: Type.Array(Type.Object({ id: Text })), purposes: Type.Object({}) }));

const Setup = Type.Unsafe<SetupView>(
  Type.Object({
    repo: Type.Union([Text, Type.Null()]),
    url: Type.Union([Text, Type.Null()]),
    missing: Type.Array(Type.Object({ id: Text, name: Text, needs: Text }))
  })
);

const Specialist = Type.Unsafe<SpecialistView>(
  Type.Object({ id: Text, description: Text, brief: Type.Object({ body: Text, version: Type.Number() }) })
);

const Subscription = Type.Unsafe<SubscriptionView>(
  Type.Object({
    kind: Type.Union([Type.Literal("claude"), Type.Literal("chatgpt"), Type.Literal("github")]),
    connected: Type.Boolean(),
    expiresAt: Type.Union([Type.Number(), Type.Null()]),
    error: Type.Union([Text, Type.Null()]),
    repos: Type.Optional(Texts)
  })
);

const Json = Type.Unsafe<JsonValue>(Type.Any());

const MemoryItemSchema = Type.Unsafe<MemoryItem>(
  Type.Union([
    Type.Object({ kind: Type.Literal("memory"), id: Type.Number(), date: Text, text: Text }),
    Type.Object({ kind: Type.Literal("block"), block: Text, text: Type.Union([Text, Type.Null()]), from: Text, to: Text })
  ])
);

const Tools = Type.Array(Type.Object({ name: Text, description: Text }));

export const ServerFrameSchema = Type.Union([
  Type.Object({ type: Type.Literal("hello"), session: Text, tools: Tools, version: Text }),
  Type.Object({ type: Type.Literal("events"), session: Text, events: Type.Array(Event) }),
  Type.Object({ type: Type.Literal("tasks"), tasks: Type.Array(Task), machines: Type.Array(Machine), files: Type.Array(File) }),
  Type.Object({ type: Type.Literal("chats"), chats: Type.Array(Chat), main: Type.Number(), groups: Type.Optional(Type.Record(Text, Texts)) }),
  Type.Object({ type: Type.Literal("skills"), skills: Type.Array(Skill) }),
  Type.Object({ type: Type.Literal("soul"), soul: Type.Object({ body: Text, version: Type.Number(), updated_at: Type.Number() }) }),
  Type.Object({ type: Type.Literal("specialists"), specialists: Type.Array(Specialist) }),
  Type.Object({ type: Type.Literal("avatars"), avatars: Type.Record(Text, BloubSpecSchema) }),
  Type.Object({
    type: Type.Literal("memory"),
    memory: Type.Object({ count: Type.Number(), newest: Type.Union([Text, Type.Null()]), items: Type.Array(MemoryItemSchema) })
  }),
  Type.Object({ type: Type.Literal("automations"), automations: Type.Array(Automation), checkIns: Type.Boolean() }),
  Type.Object({ type: Type.Literal("settings"), settings: Settings }),
  Type.Object({ type: Type.Literal("setup"), setup: Setup }),
  Type.Object({ type: Type.Literal("subscriptions"), subscriptions: Type.Array(Subscription) }),
  Type.Object({ type: Type.Literal("executor"), executor: Type.Object({ url: Type.Union([Text, Type.Null()]) }) }),
  Type.Object({ type: Type.Literal("tools"), tools: Tools }),
  Type.Object({ type: Type.Literal("result"), id: Text, result: Json }),
  Type.Object({ type: Type.Literal("error"), id: Type.Optional(Text), message: Text })
]);

export type ServerFrame = Static<typeof ServerFrameSchema>;

/** A mail as Settings › Mail lists it. */
const MailItemSchema = Type.Object({
  id: Text,
  direction: Text,
  party: Text,
  partyName: Text,
  subject: Text,
  preview: Text,
  state: Text,
  note: Text,
  at: Type.Number()
});

/** A save the server may refuse: `{ refused }` says why; anything else in it is what it saved. */
const Refusable = Type.Object({ refused: Type.Optional(Text) });

const Refused = Type.Object({ refused: Text });

const Versions = Type.Array(Type.Object({ id: Type.Number(), action: Text, actor: Text, body: Text, created_at: Type.Number() }));

/** What the server answers each ask with, by the ask's message type. */
export const ANSWERS = {
  withdraw: Type.Boolean(),
  "set-repo": Refusable,
  "add-key": Refusable,
  "set-claude": Refusable,
  "set-github": Refusable,
  "set-executor": Refusable,
  "specialist-save": Refusable,
  "automation-save": Refusable,
  "peer-pair": Refusable,
  "peer-remove": Refusable,
  "new-chat": Type.Object({ session: Text }),
  "skill-history": Type.Unsafe<readonly SkillVersion[]>(Versions),
  "soul-history": Type.Unsafe<readonly SoulVersion[]>(Versions),
  "specialist-history": Type.Unsafe<readonly SoulVersion[]>(Versions),
  "memory-search": Type.Unsafe<MemorySearch>(
    Type.Object({ matches: Type.Array(Type.Object({ id: Type.Number(), date: Text, text: Text })), total: Type.Number(), regex: Type.Boolean() })
  ),
  "memory-zoom": Type.Array(MemoryItemSchema),
  "task-steps": Type.Unsafe<readonly TaskLogStep[]>(Type.Array(Type.Object({ seq: Type.Number(), text: Text }))),
  "github-repos": Type.Union([Type.Object({ repos: Texts }), Refused]),
  "chatgpt-login": Type.Union([Type.Unsafe<ChatGptCode>(Type.Object({ userCode: Text, verificationUrl: Text, loginId: Text })), Refused]),
  "chatgpt-poll": Type.Unsafe<ChatGptState>(Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Object({ error: Text })])),
  "peer-list": Type.Unsafe<PeerView[]>(Type.Array(Type.Object({ name: Text, address: Text, state: Text }))),
  "peer-invite": Type.Union([Type.Unsafe<PeerInvite>(Type.Object({ address: Text, code: Text })), Refused]),
  "mail-view": Type.Unsafe<MailView>(
    Type.Object({
      address: Type.Union([Text, Type.Null()]),
      held: Type.Array(MailItemSchema),
      recent: Type.Array(MailItemSchema),
      allowed: Texts
    })
  ),
  "mail-approve": Refusable,
  "mail-discard": Refusable,
  "mail-disallow": Refusable
} satisfies { readonly [Type in ClientMessage["type"]]?: TSchema };

/** A message type the page asks with: one whose answer it waits for. */
export type Ask = keyof typeof ANSWERS;

/** What an ask of `Type` is answered with. */
export type Answer<Type extends Ask> = Static<(typeof ANSWERS)[Type]>;
