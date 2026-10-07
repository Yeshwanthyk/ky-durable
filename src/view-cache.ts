import type { AutomationInfo, ChatRow, FileRow, MachineInfo, SettingsView, SkillRow, TaskRow, ToolInfo } from "./protocol";
import type { PiMessage, PiMessagePart } from "./transcript";
import type { PiSessionView } from "./view";

/**
 * The last thing each chat showed, kept in localStorage so a cold start
 * paints it at once instead of waiting for the socket's snapshot, which then
 * replaces it. Only the build that wrote it reads it back: a deploy may
 * change these shapes, and the URL of the chunk this module is in changes
 * whenever ky's code does.
 */

const KEY = "ky:view-cache";

const BUILD = import.meta.url;

/** Enough of a chat to fill a phone's screen and a scroll or two. */
const MAX_MESSAGES = 60;

/** Chats kept, most recently shown first. */
const MAX_SESSIONS = 8;

/** The lists every chat shares, from the server's other messages. */
export type SharedLists = {
  readonly catalog: readonly ToolInfo[];
  readonly tasks: readonly TaskRow[];
  readonly machines: readonly MachineInfo[];
  readonly files: readonly FileRow[];
  readonly chats: readonly ChatRow[];
  readonly skills: readonly SkillRow[];
  readonly automations: readonly AutomationInfo[];
  readonly settings: SettingsView | null;
};

type CachedView = Pick<PiSessionView, "messages" | "model">;

type Cache = {
  readonly build: string;
  readonly shared: SharedLists;
  /** By session, most recently shown first. */
  readonly sessions: ReadonlyArray<{ readonly session: string; readonly view: CachedView }>;
};

function read(): Cache | null {
  try {
    const raw = localStorage.getItem(KEY);
    // SAFETY: only `saveView` writes this key, and a cache from another build is ignored below.
    const cache = raw ? (JSON.parse(raw) as Cache) : null;

    return cache?.build === BUILD ? cache : null;
  } catch {
    return null;
  }
}

/** The shared lists the last page showed; none from another build. */
export function cachedShared(): Partial<SharedLists> {
  return read()?.shared ?? {};
}

/** What the session showed last time; nothing if it was not kept. */
export function cachedView(session: string): Partial<CachedView> {
  return read()?.sessions.find((each) => each.session === session)?.view ?? {};
}

/** Images are inline base64, too big for localStorage; the snapshot brings them back. */
function withoutImages(part: PiMessagePart): PiMessagePart[] {
  if (part.type === "image") return [];

  if (part.type === "tool-result") return [{ ...part, content: part.content.filter((each) => each.type !== "image") }];

  return [part];
}

const lighter = (message: PiMessage): PiMessage => ({ ...message, parts: message.parts.flatMap(withoutImages) });

/** Only the shared lists, from a state that carries more. */
const sharedOf = ({ catalog, tasks, machines, files, chats, skills, automations, settings }: SharedLists): SharedLists => ({
  catalog,
  tasks,
  machines,
  files,
  chats,
  skills,
  automations,
  settings
});

/** Keep what the session shows now, for the next cold start. */
export function saveView(session: string, state: PiSessionView & SharedLists): void {
  const kept: CachedView = { messages: state.messages.slice(-MAX_MESSAGES).map(lighter), model: state.model };
  const others = (read()?.sessions ?? []).filter((each) => each.session !== session);
  const cache: Cache = { build: BUILD, shared: sharedOf(state), sessions: [{ session, view: kept }, ...others].slice(0, MAX_SESSIONS) };

  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Over the quota: a cold start waits for the snapshot, as it did before.
    localStorage.removeItem(KEY);
  }
}
