import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import type { PiSessionId, PiWhenBusy } from "agents/harness/pi";
import type { AutomationDraft, AutomationView } from "./automations";
import type { ChatRow } from "./chats";
import type { FileRow } from "./files";
import type { MachineState } from "./machines";
import type { MachineFacts } from "./runner-protocol";
import type { SettingsView, Slot, SlotSetting } from "./settings";
import type { SkillChange, SkillRow } from "./skills";
import type { SoulChange, SoulView } from "./soul";
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
  /** Create an automation as the user, or change one by its id; the result is `{ refused }` when it cannot be saved. */
  | { readonly type: "automation-save"; readonly id?: string; readonly automation?: string; readonly draft: AutomationDraft }
  /** Pause, resume, archive, run or delete an automation, by its id; the result is what happened, as text. */
  | {
      readonly type: "automation";
      readonly id?: string;
      readonly automation: string;
      readonly action: AutomationAction;
    }
  /** Choose the model, and its thinking level, for one slot. */
  | {
      readonly type: "set-model";
      readonly id?: string;
      readonly slot: Slot;
      readonly setting: SlotSetting;
    };

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
  /** Side chats, archived ones included, newest first; sent on connect and on change. */
  | { readonly type: "chats"; readonly chats: readonly ChatRow[] }
  /** Every skill, active ones first; sent on connect and on change. */
  | { readonly type: "skills"; readonly skills: readonly SkillRow[] }
  /** SOUL.md, ky's persona; sent on connect and on change. */
  | { readonly type: "soul"; readonly soul: SoulView }
  /** The active and paused automations, newest first; sent on connect and on change. */
  | { readonly type: "automations"; readonly automations: readonly AutomationInfo[] }
  /** Providers, their models, and each slot's choice; sent on connect and on change. */
  | { readonly type: "settings"; readonly settings: SettingsView }
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

export type { SoulChange, SoulVersion, SoulView } from "./soul";

export type { FileRow } from "./files";

export type { ModelOption, ProviderInfo, SettingsView, Slot, SlotSetting } from "./settings";

export type {
  PiMessage as TranscriptMessage,
  PiMessagePart as TranscriptPart
} from "./transcript";

export type { PiSessionView as SessionView } from "./view";
