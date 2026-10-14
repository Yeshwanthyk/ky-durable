import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import type { PiSessionId, PiWhenBusy } from "agents/harness/pi";
import type { AutomationAction, AutomationDraft, AutomationView } from "./automations/contract";
import type { ChatRow } from "./chats";
import type { FileRow } from "./files";
import type { MachineFacts, MachineLogin, MachineState } from "./machines/contract";
import type { ModelChoice, Purpose, SettingsView } from "./settings";
import type { SetupView } from "./setup";
import type { SkillChange, SkillRow, SpecialistDraft, SpecialistView } from "./skills/contract";
import type { MemoryView, SoulChange, SoulView } from "./dreaming/contract";
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

export type SubscriptionKind = "claude" | "chatgpt" | "github";

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

/** Client → server. Commands with an `id` get a `result` or `error` back. */
export type PiClientMessage =
  | {
      readonly type: "submit";
      readonly id?: string;
      readonly input: UserInput;
      readonly whenBusy?: PiWhenBusy;
      readonly operationId?: string;
    }
  | { readonly type: "abort"; readonly id?: string }
  /** Take back a message still queued behind the run; answers false once pi has placed it. */
  | { readonly type: "withdraw"; readonly id?: string; readonly operationId: string }
  | { readonly type: "reset"; readonly id?: string; readonly handoff?: string }
  /** Ask for a fresh snapshot. */
  | { readonly type: "resync"; readonly id?: string }
  /** Stop a subagent's current work or a machine task; queued machine runs are withdrawn. */
  | { readonly type: "stop-task"; readonly id?: string; readonly task: string }
  | { readonly type: "stop-all"; readonly id?: string }
  /** Send a machine task a message: it steers a working task, or resumes a finished one. */
  | { readonly type: "send-task"; readonly id?: string; readonly task: string; readonly message: string }
  /** Set whether ky may give a machine work, or what it is for. */
  | {
      readonly type: "set-machine";
      readonly id?: string;
      readonly machine: string;
      readonly state?: MachineState;
      readonly note?: string;
      readonly login?: MachineLogin;
    }
  /**
   * Set ky's GitHub repo, owner/name, for self-edits, and this page's origin as ky's address; an empty repo
   * clears it. The result is `{ refused }` when it cannot be saved.
   */
  | { readonly type: "set-repo"; readonly id?: string; readonly repo: string }
  /**
   * Keep the Claude subscription: what `claude setup-token` prints. The result is `{ refused }` when it isn't one.
   * The token is never sent back.
   */
  | { readonly type: "set-claude"; readonly id?: string; readonly token: string }
  /** The repos a GitHub token reaches: the result is `{ repos }` or `{ refused }`. The token is never sent back. */
  | { readonly type: "github-repos"; readonly id?: string; readonly token: string }
  /** Keep a GitHub token for the cloud machine and the repos it may touch; the result is `{ refused }` when it can't. */
  | { readonly type: "set-github"; readonly id?: string; readonly token: string; readonly repos: readonly string[] }
  /** Forget a subscription; tasks sign in with their machine's own login. */
  | { readonly type: "remove-subscription"; readonly id?: string; readonly kind: SubscriptionKind }
  /**
   * Connect Executor: ky lists its tools with the token before keeping it. The result is `{ refused }` when it
   * can't. The token is never sent back.
   */
  | { readonly type: "set-executor"; readonly id?: string; readonly url: string; readonly token: string }
  /** Forget Executor; its tools go away. */
  | { readonly type: "remove-executor"; readonly id?: string }
  /** Start ChatGPT's device code sign-in; the result is `{ userCode, verificationUrl, loginId }`. */
  | { readonly type: "chatgpt-login"; readonly id?: string }
  /** How a ChatGPT sign-in is going: the result is "pending", "done" or `{ error }`. */
  | { readonly type: "chatgpt-poll"; readonly id?: string; readonly login: string }
  /** The peers, each checked with a call to it; the result is PeerView[]. */
  | { readonly type: "peer-list"; readonly id?: string }
  /** Make an invite for a peer this ky will call `name`; the result is a PeerInvite or `{ refused }`. */
  | { readonly type: "peer-invite"; readonly id?: string; readonly name: string }
  /** Pair with the ky at `address` with its invite code, calling it `name`; the result is `{ refused }` when it can't. */
  | { readonly type: "peer-pair"; readonly id?: string; readonly name: string; readonly address: string; readonly code: string }
  /** Unpair a peer, both ways; the result is `{ refused }` when there is none by that name. */
  | { readonly type: "peer-remove"; readonly id?: string; readonly name: string }
  /** Start a side chat; the result is `{ session }`. */
  | { readonly type: "new-chat"; readonly id?: string }
  /** Archive a side chat, or unarchive it with `archived: false`. */
  | { readonly type: "archive-chat"; readonly id?: string; readonly session: string; readonly archived: boolean }
  /** Name a side chat; a blank title leaves it as it was. */
  | { readonly type: "rename-chat"; readonly id?: string; readonly session: string; readonly title: string }
  /** Make specialists a chat's members, the main chat's or a side chat's: a group chat. None makes it a plain chat. */
  | { readonly type: "chat-members"; readonly id?: string; readonly session: string; readonly members: readonly string[] }
  /** Change a skill as the user: edit, archive, restore, or revert it. */
  | { readonly type: "skill-change"; readonly id?: string; readonly change: SkillChange }
  /** A skill's versions, newest first, as the result. */
  | { readonly type: "skill-history"; readonly id?: string; readonly name: string }
  /** Change SOUL.md as the user: edit, patch, or revert it. */
  | { readonly type: "soul-change"; readonly id?: string; readonly change: SoulChange }
  /** SOUL.md's versions, newest first, as the result. */
  | { readonly type: "soul-history"; readonly id?: string }
  /** Create a specialist (`create: true`, with a brief) or change its description, model or machine. */
  | {
      readonly type: "specialist-save";
      readonly id?: string;
      readonly specialist: string;
      readonly create?: boolean;
      readonly draft: SpecialistDraft;
    }
  /** Change a specialist's brief as the user: edit, patch, or revert it. */
  | { readonly type: "specialist-brief"; readonly id?: string; readonly specialist: string; readonly change: SoulChange }
  /** A specialist's brief versions, newest first, as the result. */
  | { readonly type: "specialist-history"; readonly id?: string; readonly specialist: string }
  /** Answers with a MemorySearch. */
  | { readonly type: "memory-search"; readonly id?: string; readonly query: string }
  /** Answers with a block's two halves, as MemoryItems. */
  | { readonly type: "memory-zoom"; readonly id?: string; readonly block: string }
  /** Drops a block's summary and those above it, for the agent to rebuild. */
  | { readonly type: "memory-forget"; readonly id?: string; readonly block: string }
  /** Create an automation as the user, or change one by its id; the result is `{ refused }` when it cannot be saved. */
  | { readonly type: "automation-save"; readonly id?: string; readonly automation?: string; readonly draft: AutomationDraft }
  /** Pause, resume, archive, unarchive, run or delete an automation, by its id; the result is what happened, as text. */
  | {
      readonly type: "automation";
      readonly id?: string;
      readonly automation: string;
      readonly action: AutomationAction;
    }
  /** Let the nightly dream book check-ins, or not; off pauses the ones waiting. */
  | { readonly type: "set-check-ins"; readonly id?: string; readonly on: boolean }
  /** Choose the model, and its thinking level, for one purpose. */
  | {
      readonly type: "set-model";
      readonly id?: string;
      readonly purpose: Purpose;
      readonly choice: ModelChoice;
    }
  /**
   * Save an API key for a vendor once a test call takes it; the result is `{ refused }` when it doesn't. The key is
   * never sent back.
   */
  | { readonly type: "add-key"; readonly id?: string; readonly vendor: string; readonly key: string }
  /** Remove an api-key provider's key; what ran on it moves to the next healthy provider. */
  | { readonly type: "remove-key"; readonly id?: string; readonly provider: string };

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
      readonly groups: Readonly<Record<string, readonly string[]>>;
    }
  /** Every skill, active ones first; sent on connect and on change. */
  | { readonly type: "skills"; readonly skills: readonly SkillRow[] }
  /** SOUL.md, ky's persona; sent on connect and on change. */
  | { readonly type: "soul"; readonly soul: SoulView }
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

export type { TaskRow } from "./automations/contract";

export type { ChatRow } from "./chats";

export type { SkillChange, SkillRow, SkillVersion } from "./skills/contract";

export type { MemoryItem, MemoryRow, MemorySearch, MemoryView } from "./dreaming/contract";

export type { SoulChange, SoulVersion, SoulView } from "./dreaming/contract";

export type { SpecialistDraft, SpecialistView } from "./skills/contract";

export type { FileRow } from "./files";

export type { ModelChoice, ModelOption, ProviderInfo, Purpose, SettingsView, VendorOption } from "./settings";

export type { SetupView } from "./setup";

export type { PiSessionView as SessionView } from "./view";
