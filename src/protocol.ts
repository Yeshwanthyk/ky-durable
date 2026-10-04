import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import type { PiSessionId, PiWhenBusy } from "agents/harness/pi";
import type { ChatRow } from "./chats";
import type { FileRow } from "./files";
import type { SettingsView, Slot, SlotSetting } from "./settings";
import type { TaskRow } from "./tasks";

export type MachineInfo = {
  readonly name: string;
  readonly online: boolean;
  readonly seenAt: number;
  /** Its tasks that are queued or working. */
  readonly active: number;
};

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
  /** Start a side chat; the result is `{ session }`. */
  | { readonly type: "new-chat"; readonly id?: string }
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
  /** Side chats, newest first; sent on connect and on change. */
  | { readonly type: "chats"; readonly chats: readonly ChatRow[] }
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

export type { FileRow } from "./files";

export type { ModelOption, ProviderInfo, SettingsView, Slot, SlotSetting } from "./settings";

export type {
  PiMessage as TranscriptMessage,
  PiMessagePart as TranscriptPart
} from "./transcript";

export type { PiSessionView as SessionView } from "./view";
