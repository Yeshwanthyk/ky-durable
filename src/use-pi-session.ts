import type { UserInput } from "@earendil-works/pi-durable";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_VIEW, reduceEvents } from "./view";
import type {
  ClientMessage,
  FileRow,
  MachineInfo,
  ServerMessage,
  SettingsView,
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

  const agent = useAgent({
    agent: "pi-agent",
    name: OBJECT,
    query: { session },
    queryDeps: [session],
    onOpen: () => setState((current) => ({ ...current, status: "open" })),
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
    onMessage: (event) => {
      let message: ServerMessage;

      try {
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
        case "error":
          setState((current) => ({ ...current, error: message.message }));

          return;
        default:
          return;
      }
    }
  });

  useEffect(() => {
    setState((current) => ({
      ...INITIAL_STATE,
      tasks: current.tasks,
      machines: current.machines,
      files: current.files,
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

  /** Idle: starts a run. Busy: queued as a follow-up, or steers the run. */
  const submit = useCallback(
    (input: UserInput, whenBusy: "followUp" | "steer" = "followUp") =>
      send({ type: "submit", id: crypto.randomUUID(), input, whenBusy }),
    [send]
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

  const stopAll = useCallback(
    () => send({ type: "stop-all", id: crypto.randomUUID() }),
    [send]
  );

  const setModel = useCallback(
    (slot: Slot, setting: SlotSetting) =>
      send({ type: "set-model", id: crypto.randomUUID(), slot, setting }),
    [send]
  );

  return { ...state, submit, abort, reset, stopTask, stopAll, setModel };
}
