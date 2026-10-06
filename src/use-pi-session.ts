import type { JsonValue } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineChange } from "./machines";
import { EMPTY_VIEW, reduceEvents } from "./view";
import type {
  AutomationAction,
  AutomationInfo,
  ChatRow,
  ClientMessage,
  FileRow,
  MachineInfo,
  ServerMessage,
  SettingsView,
  SkillChange,
  SkillRow,
  SkillVersion,
  Slot,
  SlotSetting,
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
  /** ky's skills, active ones first. */
  readonly skills: readonly SkillRow[];
  /** Active and paused automations, newest first. */
  readonly automations: readonly AutomationInfo[];
  /** Model choices; null until the server sends them. */
  readonly settings: SettingsView | null;
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
  skills: [],
  automations: [],
  settings: null,
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
  const [state, setState] = useState<State>(INITIAL_STATE);
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
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
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
        case "chats":
          setState((current) => ({ ...current, chats: message.chats }));

          return;
        case "skills":
          setState((current) => ({ ...current, skills: message.skills }));

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

  useEffect(() => {
    setState((current) => ({
      ...INITIAL_STATE,
      tasks: current.tasks,
      machines: current.machines,
      files: current.files,
      chats: current.chats,
      skills: current.skills,
      automations: current.automations,
      settings: current.settings,
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
    (slot: Slot, setting: SlotSetting) =>
      send({ type: "set-model", id: crypto.randomUUID(), slot, setting }),
    [send]
  );

  /** Start a side chat; resolves with its session. */
  const newChat = useCallback(
    () =>
      new Promise<string>((resolve) => {
        const id = crypto.randomUUID();
        // SAFETY: the server answers new-chat with `{ session }`.
        waiting.current.set(id, (result) => resolve((result as { session: string }).session));
        send({ type: "new-chat", id });
      }),
    [send]
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
      new Promise<readonly SkillVersion[]>((resolve) => {
        const id = crypto.randomUUID();
        // SAFETY: the server answers skill-history with the skill's versions.
        waiting.current.set(id, (result) => resolve(result as readonly SkillVersion[]));
        send({ type: "skill-history", id, name });
      }),
    [send]
  );

  /** Pause, resume or archive an automation as the user. */
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
    newChat,
    archiveChat,
    changeSkill,
    skillHistory,
    changeAutomation
  };
}
