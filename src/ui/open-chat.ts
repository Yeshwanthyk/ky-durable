import type { ChatRow, SettingsView, TaskRow } from "../protocol";
import type { ConnectionStatus } from "../use-pi-session";

export const NAME = "ky";

/** The main chat's session. Side chats and subagents have their own. */
export const MAIN_SESSION = "1";

/** ky's main chat, a side chat with ky, or a subagent's own conversation. */
export type ChatKind = "main" | "side" | "subagent";

/** Which kind of conversation is open, and who is talking in it. */
export type OpenChat = {
  readonly session: string;
  readonly kind: ChatKind;
  readonly main: boolean;
  /** Set when a side chat is open. */
  readonly chat: ChatRow | undefined;
  /** Side chats talk to the main agent too, with its model and memory. */
  readonly talksToMain: boolean;
  /** Set when a subagent's conversation is open. */
  readonly subagent: TaskRow | undefined;
  /** Who is talking in the open chat: ky, or the subagent's own blob. */
  readonly speaker: string;
  /** What the topbar says under the speaker instead of the model; null in the main chat. */
  readonly where: string | null;
};

function findSubagent(session: string, tasks: readonly TaskRow[]) {
  return tasks.find((task) => task.kind === "cloud" && task.session === session);
}

function speakerOf(subagent: TaskRow | undefined, talksToMain: boolean) {
  return subagent?.worker ?? (talksToMain ? NAME : "Subagent");
}

function kindOf(main: boolean, chat: ChatRow | undefined): ChatKind {
  if (main) return "main";

  return chat ? "side" : "subagent";
}

const subagentTitle = (subagent: TaskRow | undefined, session: string) => subagent?.title ?? `Session ${session}`;

function whereOf(open: Omit<OpenChat, "where" | "speaker" | "kind">) {
  if (open.main) return null;

  return open.chat ? open.chat.title || "New side chat" : subagentTitle(open.subagent, open.session);
}

export function openChat(session: string, chats: readonly ChatRow[], tasks: readonly TaskRow[]): OpenChat {
  const main = session === MAIN_SESSION;
  const chat = chats.find((each) => each.session === session);
  const talksToMain = main || chat !== undefined;
  const subagent = talksToMain ? undefined : findSubagent(session, tasks);
  const open = { session, main, chat, talksToMain, subagent };

  return { ...open, kind: kindOf(main, chat), speaker: speakerOf(subagent, talksToMain), where: whereOf(open) };
}

/** The main purpose's model by name, for the topbar and the panel. */
export function mainModelName(settings: SettingsView | null): string {
  const main = settings?.purposes.main;

  if (!main) return "Main agent";

  const provider = settings?.providers.find((each) => each.id === main.provider);

  return provider?.models.find((each) => each.modelId === main.modelId)?.name ?? main.modelId;
}

export function statusLabel(status: ConnectionStatus): string {
  if (status === "open") return "Connected";

  return status === "connecting" ? "Connecting" : "Reconnecting";
}

/**
 * The line under the speaker: where we are, else what the background work is
 * doing ("webmac: Editing x.ts"), else how much is working, else the model.
 */
export function whoSub(where: string | null, background: string | null, working: number, model: string): string {
  if (where !== null) return where;

  if (background !== null) return background;

  return working > 0 ? `${working} working` : model;
}

export const workingCount = (tasks: readonly TaskRow[]) =>
  tasks.filter((task) => task.status === "working").length;
