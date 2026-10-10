import type { JsonValue } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineChange } from "./machines";
import { EMPTY_VIEW, reduceEvents } from "./view";
import { cachedShared, cachedView, saveView } from "./view-cache";
import type {
  AutomationAction,
  AutomationDraft,
  AutomationInfo,
  ChatRow,
  ClientMessage,
  FileRow,
  MachineInfo,
  MemoryItem,
  MemorySearch,
  MemoryView,
  ModelChoice,
  Purpose,
  ServerMessage,
  SettingsView,
  SetupView,
  SkillChange,
  SkillRow,
  SkillVersion,
  SoulChange,
  SoulVersion,
  SoulView,
  SpecialistDraft,
  SpecialistView,
  TaskRow,
  SessionView,
  ToolInfo
} from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

type State = SessionView & {
  readonly status: ConnectionStatus;
  /** Every registered tool, from the server's hello. */
  readonly catalog: readonly ToolInfo[];
  /** Delegated work, newest first, from the server's task feed. */
  readonly tasks: readonly TaskRow[];
  readonly machines: readonly MachineInfo[];
  readonly files: readonly FileRow[];
  /** Side chats, newest first. */
  readonly chats: readonly ChatRow[];
  /** When ky last answered in the main chat; 0 until it has. */
  readonly mainUpdatedAt: number;
  /** ky's skills, active ones first. */
  readonly skills: readonly SkillRow[];
  /** SOUL.md, ky's persona; null until the server sends it. */
  readonly soul: SoulView | null;
  /** The user's specialists and their briefs. */
  readonly specialists: readonly SpecialistView[];
  /** ky's memory as wake shows it; null until the server sends it. */
  readonly memory: MemoryView | null;
  /** Active and paused automations, newest first. */
  readonly automations: readonly AutomationInfo[];
  /** Model choices; null until the server sends them. */
  readonly settings: SettingsView | null;
  /** ky's repo and the tools this deploy lacks; null until the server sends them. */
  readonly setup: SetupView | null;
  /** A newer deploy is serving than the one this page loaded from. */
  readonly updated: boolean;
};

const INITIAL_STATE: State = {
  ...EMPTY_VIEW,
  status: "connecting",
  catalog: [],
  tasks: [],
  machines: [],
  files: [],
  chats: [],
  mainUpdatedAt: 0,
  skills: [],
  soul: null,
  specialists: [],
  memory: null,
  automations: [],
  settings: null,
  setup: null,
  updated: false
};

/** The one agent object this app talks to. */
const OBJECT = "me";

/**
 * One pi session over the harness's WebSocket protocol, connected with
 * `useAgent`. The server sends pi's own agent events; this folds them with
 * the same `reduceEvents` the server tests use. A reconnect gets a fresh
 * snapshot, so there is nothing to resume from.
 */
export function usePiSession(session: string) {
  const [state, setState] = useState<State>(() => ({ ...INITIAL_STATE, ...cachedShared(), ...cachedView(session) }));
  const version = useRef<string | null>(null);
  /** Commands waiting for their `result`, by id. */
  const waiting = useRef(new Map<string, (result: JsonValue) => void>());
  /**
   * Submits the server has not answered yet, by operation id, with the session
   * they went to. A socket that drops may or may not have delivered one, so
   * each is sent again when its session's socket opens; pi drops the copy
   * whose operation id it already has.
   */
  const unanswered = useRef(new Map<string, { session: string; message: ClientMessage }>());
  /** This render's session and socket, for the open handler. */
  const live = useRef<{ session: string; send(data: string): void } | null>(null);

  const agent = useAgent({
    agent: "pi-agent",
    name: OBJECT,
    query: { session },
    queryDeps: [session],
    onOpen: () => {
      setState((state) => ({ ...state, status: "open" }));

      for (const pending of unanswered.current.values()) {
        if (pending.session === live.current?.session) live.current.send(JSON.stringify(pending.message));
      }
    },
    onClose: () => {
      setState((current) => ({ ...current, status: "closed" }));
      void reloadIfSignedOut();
    },
    onMessage: (event) => {
      let message: ServerMessage;

      try {
        // SAFETY: the only sender is ky's own object, which sends ServerMessages.
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      switch (message.type) {
        case "hello": {
          // A deploy restarts the object, so the socket reconnects and says hello again.
          const updated = version.current !== null && version.current !== message.version;
          version.current ??= message.version;
          setState((current) => ({
            ...current,
            catalog: message.tools,
            updated: current.updated || updated
          }));

          return;
        }

        case "events":
          setState((current) => ({
            ...current,
            ...reduceEvents(current, message.events)
          }));

          return;
        case "tasks":
          setState((current) => ({
            ...current,
            tasks: message.tasks,
            machines: message.machines,
            files: message.files
          }));

          return;
        case "settings":
          setState((current) => ({ ...current, settings: message.settings }));

          return;
        case "setup":
          setState((current) => ({ ...current, setup: message.setup }));

          return;
        case "chats":
          setState((current) => ({ ...current, chats: message.chats, mainUpdatedAt: message.main }));

          return;
        case "skills":
          setState((current) => ({ ...current, skills: message.skills }));

          return;
        case "soul":
          setState((current) => ({ ...current, soul: message.soul }));

          return;
        case "specialists":
          setState((current) => ({ ...current, specialists: message.specialists }));

          return;
        case "memory":
          setState((current) => ({ ...current, memory: message.memory }));

          return;
        case "automations":
          setState((current) => ({ ...current, automations: message.automations }));

          return;
        case "result":
          unanswered.current.delete(message.id);
          waiting.current.get(message.id)?.(message.result);
          waiting.current.delete(message.id);

          return;
        case "error":
          // A refused submit is answered too; sending it again would be refused again.
          if (message.id !== undefined) unanswered.current.delete(message.id);
          setState((current) => ({ ...current, error: message.message }));

          return;
        default:
          return;
      }
    }
  });

  useEffect(() => {
    live.current = { session, send: (data) => agent.send(data) };
  }, [session, agent]);

  useResumeReconnect(agent);
  useSaveView(session, state);

  useEffect(() => {
    setState((current) => ({
      ...INITIAL_STATE,
      ...cachedView(session),
      tasks: current.tasks,
      machines: current.machines,
      files: current.files,
      chats: current.chats,
      mainUpdatedAt: current.mainUpdatedAt,
      skills: current.skills,
      soul: current.soul,
      specialists: current.specialists,
      memory: current.memory,
      automations: current.automations,
      settings: current.settings,
      setup: current.setup,
      updated: current.updated
    }));
  }, [session]);

  const send = useCallback(
    (message: ClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(message));
      }
    },
    [agent]
  );

  /** Send a message the server answers by its id; resolves with the answer. */
  const ask = useCallback(
    (message: (id: string) => ClientMessage) =>
      new Promise<JsonValue>((resolve) => {
        const id = crypto.randomUUID();
        waiting.current.set(id, resolve);
        send(message(id));
      }),
    [send]
  );

  /**
   * Idle: starts a run. Busy: queued as a follow-up, or steers the run. Each
   * message gets one operation id, kept across resends, so pi takes it once.
   */
  const submit = useCallback(
    (input: UserInput, whenBusy: "followUp" | "steer" = "followUp") => {
      const operationId = crypto.randomUUID();
      const message: ClientMessage = { type: "submit", id: operationId, operationId, input, whenBusy };
      unanswered.current.set(operationId, { session, message });
      send(message);
    },
    [send, session]
  );

  const abort = useCallback(
    () => send({ type: "abort", id: crypto.randomUUID() }),
    [send]
  );

  const reset = useCallback(
    () => send({ type: "reset", id: crypto.randomUUID() }),
    [send]
  );

  const stopTask = useCallback(
    (task: string) => send({ type: "stop-task", id: crypto.randomUUID(), task }),
    [send]
  );

  const sendTask = useCallback(
    (task: string, message: string) => send({ type: "send-task", id: crypto.randomUUID(), task, message }),
    [send]
  );

  const stopAll = useCallback(
    () => send({ type: "stop-all", id: crypto.randomUUID() }),
    [send]
  );

  /** Set whether ky may use a machine, or what it is for. */
  const setMachine = useCallback(
    (machine: string, change: MachineChange) =>
      send({ type: "set-machine", id: crypto.randomUUID(), machine, ...change }),
    [send]
  );

  const setModel = useCallback(
    (purpose: Purpose, choice: ModelChoice) =>
      send({ type: "set-model", id: crypto.randomUUID(), purpose, choice }),
    [send]
  );

  /** Set ky's repo for self-edits; resolves with why it was refused, if it was. */
  const setRepo = useCallback(
    (repo: string) =>
      ask((id) => ({ type: "set-repo", id, repo })).then(refusal),
    [ask]
  );

  /** Test and save a vendor's API key; resolves with why it was refused, if it was. */
  const addKey = useCallback(
    (vendor: string, key: string) =>
      ask((id) => ({ type: "add-key", id, vendor, key })).then(refusal),
    [ask]
  );

  /** Remove an api-key provider's key, and with it the provider. */
  const removeKey = useCallback(
    (provider: string) => send({ type: "remove-key", id: crypto.randomUUID(), provider }),
    [send]
  );

  /** Start a side chat; resolves with its session. */
  const newChat = useCallback(
    () =>
      // SAFETY: the server answers new-chat with `{ session }`.
      ask((id) => ({ type: "new-chat", id })).then((result) => (result as { session: string }).session),
    [ask]
  );

  /** Archive a side chat, or put it back in the list. */
  const archiveChat = useCallback(
    (chat: string, archived: boolean) => send({ type: "archive-chat", id: crypto.randomUUID(), session: chat, archived }),
    [send]
  );

  /** Change a skill as the user. */
  const changeSkill = useCallback(
    (change: SkillChange) => send({ type: "skill-change", id: crypto.randomUUID(), change }),
    [send]
  );

  /** A skill's versions, newest first. */
  const skillHistory = useCallback(
    (name: string) =>
      // SAFETY: the server answers skill-history with the skill's versions.
      ask((id) => ({ type: "skill-history", id, name })).then((result) => result as readonly SkillVersion[]),
    [ask]
  );

  /** Change SOUL.md as the user. */
  const changeSoul = useCallback(
    (change: SoulChange) => send({ type: "soul-change", id: crypto.randomUUID(), change }),
    [send]
  );

  /** SOUL.md's versions, newest first. */
  const soulHistory = useCallback(
    () =>
      // SAFETY: the server answers soul-history with SOUL.md's versions.
      ask((id) => ({ type: "soul-history", id })).then((result) => result as readonly SoulVersion[]),
    [ask]
  );

  /** Create a specialist or change its settings; resolves with why it was refused, if it was. */
  const saveSpecialist = useCallback(
    (specialist: string, draft: SpecialistDraft, create: boolean) =>
      ask((id) => ({ type: "specialist-save", id, specialist, create, draft })).then(refusal),
    [ask]
  );

  /** Change a specialist's brief as the user. */
  const changeBrief = useCallback(
    (specialist: string, change: SoulChange) =>
      send({ type: "specialist-brief", id: crypto.randomUUID(), specialist, change }),
    [send]
  );

  /** A specialist's brief versions, newest first. */
  const briefHistory = useCallback(
    (specialist: string) =>
      // SAFETY: the server answers specialist-history with the brief's versions.
      ask((id) => ({ type: "specialist-history", id, specialist })).then((result) => result as readonly SoulVersion[]),
    [ask]
  );

  /** Memories matching a regex, or the plain text when it is not one, newest first. */
  const searchMemory = useCallback(
    (query: string) =>
      // SAFETY: the server answers memory-search with a MemorySearch.
      ask((id) => ({ type: "memory-search", id, query })).then((result) => result as MemorySearch),
    [ask]
  );

  /** A memory block's two halves, newest first. */
  const zoomMemory = useCallback(
    (block: string) =>
      // SAFETY: the server answers memory-zoom with the block's halves.
      ask((id) => ({ type: "memory-zoom", id, block })).then((result) => result as readonly MemoryItem[]),
    [ask]
  );

  /** Drop a block's summary so ky writes it again. */
  const forgetMemory = useCallback(
    (block: string) => send({ type: "memory-forget", id: crypto.randomUUID(), block }),
    [send]
  );

  /** Create an automation as the user, or change one; resolves with why it was refused, if it was. */
  const saveAutomation = useCallback(
    (automation: string | undefined, draft: AutomationDraft) =>
      ask((id) => ({ type: "automation-save", id, automation, draft })).then(refusal),
    [ask]
  );

  /** Pause, resume, archive, run or delete an automation as the user. */
  const changeAutomation = useCallback(
    (automation: string, action: AutomationAction) =>
      send({ type: "automation", id: crypto.randomUUID(), automation, action }),
    [send]
  );

  return {
    ...state,
    submit,
    abort,
    reset,
    stopTask,
    sendTask,
    stopAll,
    setMachine,
    setModel,
    setRepo,
    addKey,
    removeKey,
    newChat,
    archiveChat,
    changeSkill,
    skillHistory,
    changeSoul,
    soulHistory,
    saveSpecialist,
    changeBrief,
    briefHistory,
    searchMemory,
    zoomMemory,
    forgetMemory,
    changeAutomation,
    saveAutomation
  };
}

/**
 * A socket upgrade Access or the Worker refused shows the browser only a close, not its status.
 * So on each close, ask for the page: if Access redirects it to its login or the Worker refuses it,
 * reload, and Access takes the page to its login.
 */
async function reloadIfSignedOut(): Promise<void> {
  try {
    const page = await fetch("/", { method: "HEAD", redirect: "manual", cache: "no-store" });

    if (page.type === "opaqueredirect" || page.status === 401) location.reload();
  } catch {
    // Offline: the socket keeps retrying.
  }
}

/** Why the server refused a save, from its answer. */
function refusal(result: JsonValue): string | undefined {
  // SAFETY: the server answers each save it may refuse with `{ refused? }`.
  return (result as { refused?: string }).refused;
}

/** Quiet this long after a change, the view is saved; streaming tokens would otherwise write on every delta. */
const SAVE_AFTER_MS = 500;

/** Keep what the chat shows for the next cold start: once it settles, and as the page is hidden. */
function useSaveView(session: string, state: State) {
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    // Until the socket opens, the state is what the cache painted.
    const save = () => latest.current.status === "open" && saveView(session, latest.current);
    const timer = setTimeout(save, SAVE_AFTER_MS);

    const onHide = () => {
      if (document.visibilityState === "hidden") save();
    };

    document.addEventListener("visibilitychange", onHide);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [session, state]);
}

/** Longer away than this and the socket may be a dead one iOS froze without closing. */
const STALE_AFTER_MS = 15_000;

/**
 * iOS freezes a backgrounded page's socket without closing it, so on return
 * the page would sit on a dead connection. Reopen it when the page comes back
 * after a while away, or from the back-forward cache; the new socket gets a
 * fresh snapshot, and unanswered submits are sent again on open.
 */
function useResumeReconnect(agent: { readonly readyState: number; reconnect(): void }) {
  useEffect(() => {
    let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();

        return;
      }

      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;

      if (away >= STALE_AFTER_MS || agent.readyState !== WebSocket.OPEN) agent.reconnect();
    };

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) agent.reconnect();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [agent]);
}
