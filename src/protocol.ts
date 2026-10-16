import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { PiSessionId } from "agents/harness/pi";
import type { Static } from "typebox";
import type { AvatarsView } from "./avatar-spec";
import type { AutomationAction, AutomationDraft, AutomationView } from "./automations/contract";
import type { ClientMessageSchema, SubscriptionKindSchema } from "./client-messages";
import type { ChatRow } from "./chats";
import type { FileRow } from "./files";
import type { MachineFacts, MachineLogin, MachineState } from "./machines/contract";
import type { SettingsView } from "./settings";
import type { SetupView } from "./setup";
import type { SkillRow, SpecialistView } from "./skills/contract";
import type { MemoryView, SoulView } from "./dreaming/contract";
import type { TaskRow } from "./automations/contract";

/** A machine's OS as people say it; `os` is Node's `process.platform`. */
export function osName(os: string): string {
  if (os === "darwin") return "macOS";

  if (os === "linux") return "Linux";

  if (os === "win32") return "Windows";

  return os;
}

export type MachineInfo = {
  readonly name: string;
  readonly online: boolean;
  readonly seenAt: number;
  /** Its tasks that are queued or working. */
  readonly active: number;
  /** Whether the user lets ky give it work. */
  readonly state: MachineState;
  /** What the user says it is for, such as "builds and long jobs". */
  readonly note: string;
  /** What its runner last said it is; null until a runner that says so connects. */
  readonly facts: MachineFacts | null;
  /** Whose login its tasks sign in with: its own, or ky's subscriptions whichever way it is signed in. */
  readonly login: MachineLogin;
  /** A sandbox's state; null for one of the user's computers. */
  readonly cloud: CloudState | null;
  /** What makes it a sandbox (src/sandboxes.ts); null for one of the user's computers. */
  readonly sandbox: SandboxInfo | null;
};

/** A live sandbox as a machine shows it: its id, its repos (owner/name), whether it is the default, and its idle minutes (null: the deploy's). */
export type SandboxInfo = {
  readonly id: string;
  readonly repos: readonly string[];
  readonly isDefault: boolean;
  readonly idleMinutes: number | null;
};

/** A sandbox's saved disk in R2: how big, and when it was saved. */
export type SavedDisk = { readonly size: number; readonly savedAt: number };

/** Settings' sandboxes: whether the deploy has containers, the cap, each live one's saved disk, and the kept disks of deleted ones. */
export type SandboxesView = {
  readonly enabled: boolean;
  readonly cap: number;
  readonly saves: Readonly<Record<string, SavedDisk | null>>;
  readonly kept: readonly { readonly id: string; readonly name: string; readonly repos: readonly string[]; readonly deletedAt: number; readonly save: SavedDisk | null }[];
};

/** The cloud machine: asleep with nothing to do, waking for work that waits for it, or running with its runner connected. */
export type CloudState = "asleep" | "waking" | "running";

export type SubscriptionKind = Static<typeof SubscriptionKindSchema>;

/** A mail, as Settings › Mail shows it. */
export type MailItem = {
  readonly id: string;
  readonly direction: "in" | "out";
  /** The sender of one that came in; the recipient of one ky wrote. */
  readonly party: string;
  readonly partyName: string;
  readonly subject: string;
  /** Its text's start; for one that came in, what its triage said, if it said anything. */
  readonly preview: string;
  readonly state: "new" | "triaged" | "kept" | "held" | "discarded" | "sending" | "sent" | "failed";
  /** Why one ky wrote failed. */
  readonly note: string;
  readonly at: number;
};

/** Settings › Mail: ky's address (null until set up), the mail waiting for the user, the newest, and who ky may write to. */
export type MailView = {
  readonly address: string | null;
  readonly held: readonly MailItem[];
  readonly recent: readonly MailItem[];
  readonly allowed: readonly string[];
};

/** A peer, another person's ky this one is paired with, as Settings › Peers shows it: never its token. */
export type PeerView = {
  readonly name: string;
  readonly address: string;
  /** on: it takes this ky's token; revoked: it unpaired, or was removed; unreachable: it didn't answer, as `detail` says. */
  readonly state: "on" | "revoked" | "unreachable";
  readonly detail?: string;
};

/** An invite for another person's ky: this ky's address and a code that works once, within 10 minutes. */
export type PeerInvite = { readonly address: string; readonly code: string };

/** Executor as Settings shows it: the URL ky reaches it at, or null when it isn't connected. Never its token. */
export type ExecutorView = { readonly url: string | null };

/** A subscription as Settings shows it: never its token. */
export type SubscriptionView = {
  readonly kind: SubscriptionKind;
  readonly connected: boolean;
  /** When the Claude token stops working, a year after `claude setup-token` made it. */
  readonly expiresAt: number | null;
  /** Why the last refresh failed. */
  readonly error: string | null;
  /** GitHub's: the repos (owner/name) the cloud machine may fetch and push to. */
  readonly repos?: readonly string[];
};

/** A ChatGPT sign-in as it starts: the code the user enters at `verificationUrl`, and the id to ask after it by. */
export type ChatGptCode = { readonly userCode: string; readonly verificationUrl: string; readonly loginId: string };

/** How a ChatGPT sign-in is going. */
export type ChatGptState = "pending" | "done" | { readonly error: string };

/** An automation as Activity shows it: its view, and the chat it reports to by name. */
export type { AutomationDraft };

export type AutomationInfo = AutomationView & { readonly chat_label: string };

/** Pause, resume, archive, unarchive, run or delete. */
export type { AutomationAction };

/**
 * This app's WebSocket protocol, served by `sockets.ts`. The harness knows
 * nothing about it: it is one way to put `session.events()` and
 * `session.submit()` on a socket.
 */

export type PiToolInfo = {
  readonly name: string;
  readonly description: string;
};

/** Client → server, checked by sockets.ts against its schema in client-messages.ts. */
export type PiClientMessage = Static<typeof ClientMessageSchema>;

/** Server → client. */
export type PiServerMessage =
  | {
      readonly type: "hello";
      readonly session: PiSessionId;
      readonly tools: readonly PiToolInfo[];
      /** The deploy serving this socket; a page from an older one reloads. */
      readonly version: string;
    }
  /**
   * pi's own agent events for the connection's session. The first batch of a
   * watch, and any batch after the server lost its watch, starts with a
   * `snapshot` event that replaces the client's state.
   */
  | {
      readonly type: "events";
      readonly session: PiSessionId;
      readonly events: readonly AgentEvent[];
    }
  /** The task feed, sent on connect and whenever it changes. */
  | {
      readonly type: "tasks";
      readonly tasks: readonly TaskRow[];
      readonly machines: readonly MachineInfo[];
      /** Files machine tasks shared, newest first. */
      readonly files: readonly FileRow[];
    }
  /**
   * Side chats, archived ones included, newest first, and when ky last answered
   * in the main chat (0 if never), and each group chat's specialists by session; sent on connect and on change.
   */
  | {
      readonly type: "chats";
      readonly chats: readonly ChatRow[];
      readonly main: number;
      /** Missing from a Worker from before group chats, while a deploy settles. */
      readonly groups?: Readonly<Record<string, readonly string[]>>;
    }
  /** Every skill, active ones first; sent on connect and on change. */
  | { readonly type: "skills"; readonly skills: readonly SkillRow[] }
  /** SOUL.md, ky's persona; sent on connect and on change. */
  | { readonly type: "soul"; readonly soul: SoulView }
  /** The bloubs ky and the specialists wear, by "ky" or specialist id; sent on connect and on change. */
  | { readonly type: "avatars"; readonly avatars: AvatarsView }
  /** The specialists and their briefs; sent on connect and on change. */
  | { readonly type: "specialists"; readonly specialists: readonly SpecialistView[] }
  | { readonly type: "memory"; readonly memory: MemoryView }
  /** The active, paused and archived automations, newest first; sent on connect and on change. */
  | { readonly type: "automations"; readonly automations: readonly AutomationInfo[]; readonly checkIns: boolean }
  /** Providers, their models, and each purpose's model; sent on connect and on change. */
  | { readonly type: "settings"; readonly settings: SettingsView }
  /** ky's repo and address, and what this deploy has no config for; sent on connect and on change. */
  | { readonly type: "setup"; readonly setup: SetupView }
  /** Whether each subscription is set up, never its token; sent on connect and on change. */
  | { readonly type: "subscriptions"; readonly subscriptions: readonly SubscriptionView[] }
  /** Whether Executor is connected, and where; sent on connect and on change. */
  | { readonly type: "executor"; readonly executor: ExecutorView }
  /** The tools ky has, as in hello; sent when they change, as when Executor is connected or removed. */
  | { readonly type: "tools"; readonly tools: readonly PiToolInfo[] }
  | { readonly type: "result"; readonly id: string; readonly result: JsonValue }
  | { readonly type: "error"; readonly id?: string; readonly message: string };

export type {
  PiClientMessage as ClientMessage,
  PiServerMessage as ServerMessage,
  PiToolInfo as ToolInfo
};

export type { TaskLogStep, TaskRow } from "./automations/contract";

export type { ChatRow } from "./chats";

export type { SkillChange, SkillRow, SkillVersion } from "./skills/contract";

export type { MemoryItem, MemoryRow, MemorySearch, MemoryView } from "./dreaming/contract";

export type { SoulChange, SoulVersion, SoulView } from "./dreaming/contract";

export type { SpecialistDraft, SpecialistView } from "./skills/contract";

export type { FileRow } from "./files";

export type { ModelChoice, ModelOption, ProviderInfo, Purpose, SettingsView, VendorOption } from "./settings";

export type { SetupView } from "./setup";

export type { PiSessionView as SessionView } from "./view";
