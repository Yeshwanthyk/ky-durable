import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import type { PiSessionId, PiWhenBusy } from "agents/harness/pi";
import type { AutomationDraft, AutomationView } from "./automations";
import type { ChatRow } from "./chats";
import type { FileRow } from "./files";
import type { MachineState } from "./machines";
import type { MachineFacts } from "./runner-protocol";
import type { ModelChoice, Purpose, SettingsView } from "./settings";
import type { SetupView } from "./setup";
import type { SkillChange, SkillRow } from "./skills";
import type { MemoryView } from "./memory";
import type { SoulChange, SoulView } from "./soul";
import type { SpecialistDraft, SpecialistView } from "./specialists";
import type { TaskRow } from "./tasks";

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
};

/** An automation as Activity shows it: its view, and the chat it reports to by name. */
export type { AutomationDraft };

export type AutomationInfo = AutomationView & { readonly chat_label: string };

export type AutomationAction = "pause" | "resume" | "archive" | "run" | "delete";

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
    }
  /**
   * Set ky's GitHub repo, owner/name, for self-edits, and this page's origin as ky's address; an empty repo
   * clears it. The result is `{ refused }` when it cannot be saved.
   */
  | { readonly type: "set-repo"; readonly id?: string; readonly repo: string }
  /** Start a side chat; the result is `{ session }`. */
  | { readonly type: "new-chat"; readonly id?: string }
  /** Archive a side chat, or unarchive it with `archived: false`. */
  | { readonly type: "archive-chat"; readonly id?: string; readonly session: string; readonly archived: boolean }
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
  /** Pause, resume, archive, run or delete an automation, by its id; the result is what happened, as text. */
  | {
      readonly type: "automation";
      readonly id?: string;
      readonly automation: string;
      readonly action: AutomationAction;
    }
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
   * in the main chat (0 if never); sent on connect and on change.
   */
  | { readonly type: "chats"; readonly chats: readonly ChatRow[]; readonly main: number }
  /** Every skill, active ones first; sent on connect and on change. */
  | { readonly type: "skills"; readonly skills: readonly SkillRow[] }
  /** SOUL.md, ky's persona; sent on connect and on change. */
  | { readonly type: "soul"; readonly soul: SoulView }
  /** The specialists and their briefs; sent on connect and on change. */
  | { readonly type: "specialists"; readonly specialists: readonly SpecialistView[] }
  | { readonly type: "memory"; readonly memory: MemoryView }
  /** The active and paused automations, newest first; sent on connect and on change. */
  | { readonly type: "automations"; readonly automations: readonly AutomationInfo[] }
  /** Providers, their models, and each purpose's model; sent on connect and on change. */
  | { readonly type: "settings"; readonly settings: SettingsView }
  /** ky's repo and address, and what this deploy has no config for; sent on connect and on change. */
  | { readonly type: "setup"; readonly setup: SetupView }
  | { readonly type: "result"; readonly id: string; readonly result: JsonValue }
  | { readonly type: "error"; readonly id?: string; readonly message: string };

export type {
  PiClientMessage as ClientMessage,
  PiServerMessage as ServerMessage,
  PiToolInfo as ToolInfo
};

export type { TaskRow } from "./tasks";

export type { ChatRow } from "./chats";

export type { SkillChange, SkillRow, SkillVersion } from "./skills";

export type { MemoryItem, MemoryRow, MemorySearch, MemoryView } from "./memory";

export type { SoulChange, SoulVersion, SoulView } from "./soul";

export type { SpecialistDraft, SpecialistView } from "./specialists";

export type { FileRow } from "./files";

export type { ModelChoice, ModelOption, ProviderInfo, Purpose, SettingsView, VendorOption } from "./settings";

export type { SetupView } from "./setup";

export type {
  PiMessage as TranscriptMessage,
  PiMessagePart as TranscriptPart
} from "./transcript";

export type { PiSessionView as SessionView } from "./view";
