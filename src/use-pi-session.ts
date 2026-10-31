import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Asks } from "./asks";
import type { AvatarsView } from "./avatars/contract";
import { parseOr } from "./core/decode";
import type { MachineChange } from "./machines/contract";
import { dropReturned, isStranded, markTaking, type Outgoing, reduceOutbox, settleOutgoing, type Upload, withFiles } from "./outbox";
import { actStore, messageStore, type StoredAct, type StoredMessage } from "./outbox-store";
import { outgoingOf, Pending } from "./pending";
import { uploadClip, UploadOffline } from "./ui/pick-media";
import { EMPTY_VIEW, reduceEvents } from "./view";
import { useConnection } from "./connection";
import type { CardAnswer } from "./cards/contract";
import { cachedShared, cachedView, saveView } from "./view-cache";
import { type Answer, type Ask, ServerFrameSchema } from "./server-frames";
import type {
  AutomationAction,
  AutomationDraft,
  AutomationInfo,
  ChatRow,
  ClientMessage,
  FileRow,
  MachineInfo,
  MemoryView,
  ModelChoice,
  PostVerdict,
  PostVerdicts,
  ProactivityLevel,
  Purpose,
  ServerMessage,
  SettingsView,
  SetupView,
  ExecutorView,
  SubscriptionKind,
  SubscriptionView,
  SkillChange,
  SkillRow,
  SoulChange,
  SoulView,
  AccessChange,
  SpecialistAccess,
  SpecialistDraft,
  SpecialistView,
  TaskRow,
  SessionView,
  ToolInfo
} from "./protocol";
import type { ApprovalAction, ApprovalView, ToolPolicy } from "./approvals/contract";

type ConnectionStatus = "connecting" | "open" | "closed";

type State = SessionView & {
  /** Messages sent that pi has not placed yet, oldest first. */
  readonly outbox: readonly Outgoing[];
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
  /** Each group chat's specialists, by session. */
  readonly groups: Readonly<Record<string, readonly string[]>>;
  /** ky's skills, active ones first. */
  readonly skills: readonly SkillRow[];
  /** SOUL.md, ky's persona; null until the server sends it. */
  readonly soul: SoulView | null;
  /** The user's specialists and their briefs. */
  readonly specialists: readonly SpecialistView[];
  /** Each specialist's sandbox and Macs, by id. */
  readonly specialistAccess: Readonly<Record<string, SpecialistAccess>>;
  /** The bloubs ky and the specialists wear, by "ky" or specialist id. */
  readonly avatars: AvatarsView;
  /** ky's memory as wake shows it; null until the server sends it. */
  readonly memory: MemoryView | null;
  /** Active, paused and archived automations, newest first. */
  readonly automations: readonly AutomationInfo[];
  /** Whether the nightly dream books check-ins. */
  readonly checkIns: boolean;
  /** The open chat's recalled context, the lines under each user message, by its message id. Sent again on each connect. */
  readonly recalled: Readonly<Record<string, readonly string[]>>;
  /** Model choices; null until the server sends them. */
  readonly settings: SettingsView | null;
  /** ky's repo and the tools this deploy lacks; null until the server sends them. */
  readonly setup: SetupView | null;
  /** Whether each subscription is set up. */
  readonly subscriptions: readonly SubscriptionView[];
  /** Whether Executor is connected; null until the server says. */
  readonly executor: ExecutorView | null;
  /** The approvals waiting on the user's tap, each a card in its chat. */
  readonly approvals: readonly ApprovalView[];
  /** A newer deploy is serving than the one this page loaded from. */
  readonly updated: boolean;
  /** Changes the user made while ky was out of reach, oldest first; each goes once a socket opens. */
  readonly acts: readonly StoredAct[];
};

/** Each server frame, by its type. */
type Frames = { [Frame in ServerMessage as Frame["type"]]: Frame };

/** What the page does with each frame: one handler per type, so a new type doesn't compile until the page handles it. */
type FrameHandlers = { readonly [Type in keyof Frames]: (frame: Frames[Type]) => void };

/** Hand a frame to its type's handler. */
function handleFrame<Type extends keyof Frames>(handlers: FrameHandlers, type: Type, frame: Frames[Type]): void {
  handlers[type](frame);
}

/** What the frame handlers change: the state, and the refs that track what the server hasn't answered. */
type Receiver = {
  readonly setState: (update: (current: State) => State) => void;
  readonly events: { add(events: readonly AgentEvent[]): void };
  readonly version: { current: string | null };
  readonly pending: Pending;
  readonly asks: Asks;
};

function frameHandlers({ setState, events, version, pending, asks }: Receiver): FrameHandlers {
  /** The frames that replace a part of the state outright. */
  const replace = (part: Partial<State>) => setState((current) => ({ ...current, ...part }));

  return {
    hello: ({ tools, version: serving }) => {
      // A deploy restarts the object, so the socket reconnects and says hello again.
      const updated = version.current !== null && version.current !== serving;
      version.current ??= serving;
      setState((current) => ({ ...current, catalog: tools, updated: current.updated || updated }));
    },
    events: (frame) => events.add(frame.events),
    result: ({ id, result }) => {
      pending.answered(id);
      setState((current) => ({ ...current, outbox: settleOutgoing(current.outbox, id, false) }));
      asks.answer(id, result);
    },
    error: ({ id, message }) => {
      // A refused submit is answered too; sending it again would be refused again.
      if (id !== undefined) {
        pending.answered(id);
        asks.fail(id, message);
      }

      setState((current) => ({
        ...current,
        error: message,
        outbox: id === undefined ? current.outbox : settleOutgoing(current.outbox, id, true)
      }));
    },
    tasks: ({ tasks, machines, files }) => replace({ tasks, machines, files }),
    settings: ({ settings }) => replace({ settings }),
    setup: ({ setup }) => replace({ setup }),
    subscriptions: ({ subscriptions }) => replace({ subscriptions }),
    executor: ({ executor }) => replace({ executor }),
    approvals: ({ approvals }) => replace({ approvals }),
    tools: ({ tools }) => replace({ catalog: tools }),
    // A Worker from before group chats sends no groups while a deploy settles.
    chats: ({ chats, main, groups }) => replace({ chats, mainUpdatedAt: main, groups: groups ?? {} }),
    skills: ({ skills }) => replace({ skills }),
    soul: ({ soul }) => replace({ soul }),
    // A Worker from before specialists had machines sends no access while a deploy settles.
    specialists: ({ specialists, access }) => replace({ specialists, specialistAccess: access ?? {} }),
    avatars: ({ avatars }) => replace({ avatars }),
    memory: ({ memory }) => replace({ memory }),
    automations: ({ automations, checkIns }) => replace({ automations, checkIns }),
    recalled: ({ recalls }) =>
      setState((current) => ({ ...current, recalled: { ...current.recalled, ...Object.fromEntries(recalls.map((each) => [String(each.entry), each.lines])) } }))
  };
}

/** The fields of an ask of `Type`, all but its type and the id the page gives it. */
type AskFields<Type extends Ask> = Omit<Extract<ClientMessage, { type: Type }>, "type" | "id">;

/** Send an ask; resolves with its answer, or rejects with why there is none. */
type AskFn = <Type extends Ask>(type: Type, fields: AskFields<Type>) => Promise<Answer<Type>>;

/** Why a save was refused, from its answer. */
const refusal = (answer: { readonly refused?: string }) => answer.refused;

/** Why an ask failed, as a save's refusal says it. */
const why = (error: Error) => error.message;

/** An ask that failed, as `{ refused }`, the way the server says no. */
const refused = (error: Error) => ({ refused: error.message });

const INITIAL_STATE: State = {
  ...EMPTY_VIEW,
  outbox: [],
  status: "connecting",
  catalog: [],
  tasks: [],
  machines: [],
  files: [],
  chats: [],
  mainUpdatedAt: 0,
  groups: {},
  skills: [],
  soul: null,
  specialists: [],
  specialistAccess: {},
  avatars: {},
  memory: null,
  automations: [],
  checkIns: true,
  recalled: {},
  settings: null,
  setup: null,
  subscriptions: [],
  executor: null,
  approvals: [],
  updated: false,
  acts: []
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
  /** Asks waiting for their answer, by id. */
  const [asks] = useState(() => new Asks());
  /** Submits the server has not answered yet, in memory and on the device (src/pending.ts). */
  const [pending] = useState(() => new Pending((operationId) => setState(withoutOutgoing(operationId))));

  useEffect(() => () => pending.close(), [pending]);
  /** This render's session and socket, for the open handler and for a message that goes once its clips are up. */
  const live = useRef<Live | null>(null);
  const events = useEventBatch(setState);
  const handlers = useMemo(() => frameHandlers({ setState, events, version, pending, asks }), [events, asks, pending]);
  const deliver = useDeliver(pending, live, setState);
  const acts = useActs(live, asks, setState);

  const agent = useAgent({
    agent: "pi-agent",
    name: OBJECT,
    query: { session },
    queryDeps: [session],
    onOpen: () => {
      events.flush();
      setState((state) => ({ ...state, status: "open" }));

      for (const message of pending.of(live.current?.session ?? session)) deliver(message.operationId);
      void acts.flush();
    },
    onClose: () => {
      events.flush();
      setState((current) => ({ ...current, status: "closed" }));
      asks.close();
    },
    onMessage: (event) => {
      // The agents SDK's own frames, and anything else ky didn't send, aren't one.
      const frame: ServerMessage | undefined = parseOr(ServerFrameSchema, String(event.data), undefined);

      if (frame === undefined) return;

      // Every other frame lands after the events before it, as it did when each was its own update.
      if (frame.type !== "events") events.flush();
      handleFrame(handlers, frame.type, frame);
    }
  });

  useEffect(() => {
    live.current = { session, send: (data) => agent.send(data), open: () => agent.readyState === WebSocket.OPEN };
  }, [session, agent]);

  useRestore(pending, live, deliver, acts, setState);

  useResumeReconnect(agent);
  // Why the socket is down, for the pill; it also catches a socket that says OPEN but is dead.
  const connection = useConnection(agent, state.outbox.length);
  useSaveView(session, state);

  // Another chat starts from its cache during render, so the old chat never paints under the new one's name.
  const [shown, setShown] = useState(session);

  if (shown !== session) {
    setShown(session);
    // Events still waiting were the old chat's; the reset below would throw them away anyway.
    events.drop();
    setState((current) => ({
      ...INITIAL_STATE,
      ...cachedView(session),
      // What the user sent here that ky hasn't answered, kept for this chat while another was open.
      outbox: pending.of(session).map(outgoingOf),
      acts: current.acts,
      tasks: current.tasks,
      machines: current.machines,
      files: current.files,
      chats: current.chats,
      mainUpdatedAt: current.mainUpdatedAt,
      groups: current.groups,
      skills: current.skills,
      soul: current.soul,
      specialists: current.specialists,
      specialistAccess: current.specialistAccess,
      avatars: current.avatars,
      memory: current.memory,
      automations: current.automations,
      checkIns: current.checkIns,
      settings: current.settings,
      setup: current.setup,
      subscriptions: current.subscriptions,
      executor: current.executor,
      approvals: current.approvals,
      updated: current.updated
    }));
  }

  /**
   * A command over the socket. Offline, a change waits on the device and goes once a socket opens (WAITS_OFFLINE);
   * any other says it didn't go, so a tap never does nothing. The page offers those only while connected.
   */
  const send = useCallback(
    (message: ClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) agent.send(JSON.stringify(message));
      else if (WAITS_OFFLINE.has(message.type)) acts.queue(message);
      else setState((current) => ({ ...current, error: "ky is offline, so that didn't go. Try again once it reconnects." }));
    },
    [agent, acts]
  );

  /** Send a message the server answers by its id; it settles on the answer, an error, the socket closing, or a timeout. */
  const ask: AskFn = useCallback(
    <Type extends Ask>(type: Type, fields: AskFields<Type>) => {
      const id = crypto.randomUUID();
      const answer = asks.wait(type, id);

      if (agent.readyState === WebSocket.OPEN) agent.send(JSON.stringify({ ...fields, type, id }));
      else asks.fail(id, "ky isn't connected.");

      return answer;
    },
    [agent, asks]
  );

  /**
   * Idle: starts a run. Busy: queued as a follow-up, or steers the run. Each
   * message gets one operation id, kept across resends, so pi takes it once.
   */
  const running = useRef(state.running);
  running.current = state.running;

  /**
   * Idle: starts a run. Busy: queued as a follow-up, or steers the run. Each message gets one operation id, kept
   * across resends, so pi takes it once. Offline it waits, kept on the device, and goes once the socket opens;
   * clips attached offline (`uploads`) go up first.
   */
  const submit = useCallback(
    (input: UserInput, whenBusy: "followUp" | "steer" = "followUp", card?: CardAnswer, uploads: readonly Upload[] = []) => {
      const operationId = crypto.randomUUID();
      const message: StoredMessage["message"] = { type: "submit", id: operationId, operationId, input, whenBusy };

      if (card !== undefined) message.card = { ...card, values: card.values.map((value) => [...value]) };
      const at = Date.now();
      const behind = running.current;
      pending.add({ operationId, session, message, at, behind, written: false, uploads });
      const sent = deliver(operationId);
      // It shows before the server answers: in the thread, queued behind the run going now, or waiting for the connection.
      setState((current) => ({
        ...current,
        outbox: [...current.outbox, { operationId, input, at, behind, submission: null, back: null, waiting: !sent, uploads }]
      }));
    },
    [pending, deliver, session]
  );

  /**
   * Take back a queued message; resolves false once pi has placed it, too late to take back. One the page never
   * sent, as one written offline, it takes back itself: ky never had it.
   */
  const withdraw = useCallback(
    async (operationId: string) => {
      if (pending.takeBack(operationId) !== undefined) {
        setState(withoutOutgoing(operationId));

        return true;
      }

      // Marked first, so pi's word that it is withdrawn drops it rather than returning it to the composer.
      setState((current) => ({ ...current, outbox: markTaking(current.outbox, operationId, true) }));
      const taken = await ask("withdraw", { operationId }).catch(() => false);

      if (!taken) setState((current) => ({ ...current, outbox: markTaking(current.outbox, operationId, false) }));

      return taken;
    },
    [ask, pending]
  );

  /** The composer has taken in these returned messages. */
  const takeReturned = useCallback(
    (operationIds: ReadonlySet<string>) => setState((current) => ({ ...current, outbox: dropReturned(current.outbox, operationIds) })),
    []
  );

  // A message pi still holds queued once the run has ended would never go in: withdraw it, and it comes back to the composer.
  const askedBack = useRef(new Set<string>());

  useEffect(() => {
    if (state.status !== "open") return;

    for (const item of state.outbox) {
      if (!isStranded(item, state.running) || askedBack.current.has(item.operationId)) continue;
      askedBack.current.add(item.operationId);
      void ask("withdraw", { operationId: item.operationId }).catch(() => false);
    }
  }, [state.outbox, state.running, state.status, ask]);

  /** Stop the tool calls the run waits on, so what is queued goes in now. */
  const steerNow = useCallback(
    () => send({ type: "steer-now", id: crypto.randomUUID() }),
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
      ask("set-repo", { repo }).then(refusal, why),
    [ask]
  );

  /** Test and save a vendor's API key; resolves with why it was refused, if it was. */
  const addKey = useCallback(
    (vendor: string, key: string) =>
      ask("add-key", { vendor, key }).then(refusal, why),
    [ask]
  );

  /** Remove an api-key provider's key, and with it the provider. */
  const removeKey = useCallback(
    (provider: string) => send({ type: "remove-key", id: crypto.randomUUID(), provider }),
    [send]
  );

  const subscriptionActions = useSubscriptionActions(ask, send);

  const { executorActions, peerActions, mailActions, approvalActions } = useSettingsActions(ask, send, live);

  /** Settings › Proactivity's. New on each connect, so a page that asked while the socket was closed asks again. */
  const proactivityActions = useMemo(() => proactivityActionsOf(ask, state.status === "open"), [ask, state.status]);

  /** Settings › Spend's, new on each connect as Proactivity's are. */
  const spendActions = useMemo(
    () => ({ open: state.status === "open", onView: () => ask("spend", {}), onCap: (usd: number | null) => ask("set-spend-cap", { usd }) }),
    [ask, state.status]
  );

  /** Start a side chat; resolves with its session. */
  const newChat = useCallback(
    () => ask("new-chat", {}).then(({ session }) => session),
    [ask]
  );

  /** Archive a side chat, or put it back in the list. */
  const archiveChat = useCallback(
    (chat: string, archived: boolean) => send({ type: "archive-chat", id: crypto.randomUUID(), session: chat, archived }),
    [send]
  );

  /** Name a side chat. */
  const renameChat = useCallback(
    (chat: string, title: string) => send({ type: "rename-chat", id: crypto.randomUUID(), session: chat, title }),
    [send]
  );

  /** Change a skill as the user. */
  const changeSkill = useCallback(
    (change: SkillChange) => send({ type: "skill-change", id: crypto.randomUUID(), change }),
    [send]
  );

  /** A skill's versions, newest first. */
  const skillHistory = useCallback(
    (name: string) => ask("skill-history", { name }).catch(() => []),
    [ask]
  );

  /** Change SOUL.md as the user. */
  const changeSoul = useCallback(
    (change: SoulChange) => send({ type: "soul-change", id: crypto.randomUUID(), change }),
    [send]
  );

  /** SOUL.md's versions, newest first. */
  const soulHistory = useCallback(
    () => ask("soul-history", {}).catch(() => []),
    [ask]
  );

  /** Create a specialist or change its settings; resolves with why it was refused, if it was. */
  const saveSpecialist = useCallback(
    (specialist: string, draft: SpecialistDraft, create: boolean) =>
      ask("specialist-save", { specialist, create, draft }).then(refusal, why),
    [ask]
  );

  /** Grant or revoke a specialist a Mac, or move it to another sandbox; resolves with why it was refused, if it was. */
  const changeAccess = useCallback(
    (specialist: string, change: AccessChange) => ask("specialist-access", { specialist, change }).then(refusal, why),
    [ask]
  );

  /** Delete a specialist; resolves with why it was refused, if it was. */
  const deleteSpecialist = useCallback((specialist: string) => ask("specialist-delete", { specialist }).then(refusal, why), [ask]);

  /** Make specialists a chat's members, or none to make it a plain chat again. */
  const setMembers = useCallback(
    (chat: string, members: readonly string[]) => send({ type: "chat-members", id: crypto.randomUUID(), session: chat, members }),
    [send]
  );

  /** Change a specialist's brief as the user. */
  const changeBrief = useCallback(
    (specialist: string, change: SoulChange) =>
      send({ type: "specialist-brief", id: crypto.randomUUID(), specialist, change }),
    [send]
  );

  /** A specialist's brief versions, newest first. */
  const briefHistory = useCallback(
    (specialist: string) => ask("specialist-history", { specialist }).catch(() => []),
    [ask]
  );

  /** Memories matching a regex, or the plain text when it is not one, newest first. */
  const searchMemory = useCallback(
    (query: string) => ask("memory-search", { query }).catch(() => ({ matches: [], total: 0, regex: false })),
    [ask]
  );

  /** Every step a task's log kept, oldest first; none when ky can't say. */
  const taskSteps = useCallback(
    (task: string) => ask("task-steps", { task }).catch(() => []),
    [ask]
  );

  /** A memory block's two halves, newest first. */
  const zoomMemory = useCallback(
    (block: string) => ask("memory-zoom", { block }).catch(() => []),
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
      ask("automation-save", { automation, draft }).then(refusal, why),
    [ask]
  );

  const { changeAutomation, setCheckIns } = useAutomationActions(send);

  const open = state.status === "open";

  /**
   * Activity › Last night's: the latest dream's changes, and undoing one. New on each connect, so a list that
   * opened before the socket did, or across a reconnect, reads again.
   */
  const ledgerActions = useMemo(
    () => ({ open, onView: () => ask("dream-ledger", {}), onUndo: (entry: number) => ask("dream-undo", { entry }) }),
    [ask, open]
  );

  const verdictActions = useVerdicts(ask, open);

  return {
    ...state,
    connection,
    submit,
    withdraw,
    takeReturned,
    steerNow,
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
    subscriptionActions,
    executorActions,
    peerActions,
    mailActions,
    approvalActions,
    proactivityActions,
    spendActions,
    ledgerActions,
    verdictActions,
    newChat,
    archiveChat,
    renameChat,
    changeSkill,
    skillHistory,
    changeSoul,
    soulHistory,
    saveSpecialist,
    changeAccess,
    deleteSpecialist,
    setMembers,
    changeBrief,
    briefHistory,
    searchMemory,
    taskSteps,
    zoomMemory,
    forgetMemory,
    changeAutomation,
    saveAutomation,
    setCheckIns
  };
}

/** How long a batch may wait when no frame is painted, as in a background tab, where requestAnimationFrame stops. */
const BATCH_FALLBACK_MS = 100;

/**
 * Streaming sends an events frame every few characters. Each was its own
 * render; this folds the frames that land within one animation frame into a
 * single update, in the order they came. Anything else that sets state calls
 * `flush` first, so it still applies after the events that preceded it.
 */
function useEventBatch(setState: (update: (current: State) => State) => void) {
  const batch = useMemo(() => {
    let pending: AgentEvent[] = [];
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cancel = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = 0;
      timer = undefined;
    };

    const flush = () => {
      cancel();

      if (pending.length === 0) return;
      const events = pending;
      pending = [];
      setState((current) => ({ ...current, ...reduceEvents(current, events), outbox: reduceOutbox(current.outbox, events) }));
    };

    return {
      add(events: readonly AgentEvent[]) {
        // One at a time: a snapshot's events could overflow a spread's argument list.
        for (const event of events) pending.push(event);

        if (timer !== undefined) return;
        frame = requestAnimationFrame(flush);
        timer = setTimeout(flush, BATCH_FALLBACK_MS);
      },
      flush,
      drop() {
        cancel();
        pending = [];
      }
    };
  }, [setState]);

  useEffect(() => batch.drop, [batch]);

  return batch;
}

/** The open chat and its socket. */
type Live = { readonly session: string; send(data: string): void; open(): boolean };

type SetState = (update: (current: State) => State) => void;

/** A message that waited at least this long on the device tells ky how long, for the model's note (src/core/late.ts). */
const SAY_WAITED_MS = 5_000;

/**
 * The commands that, offline, wait on the device and go once a socket opens: changes the user made, which still
 * mean the same later. Stop, Steer now and stopping a task don't: a stop that lands later would stop whatever
 * runs by then, so the page offers them only while connected.
 */
const WAITS_OFFLINE: ReadonlySet<ClientMessage["type"]> = new Set<ClientMessage["type"]>([
  "approval-decide",
  "send-task",
  "set-machine",
  "set-model",
  "remove-key",
  "remove-subscription",
  "remove-executor",
  "archive-chat",
  "rename-chat",
  "skill-change",
  "soul-change",
  "chat-members",
  "specialist-brief",
  "memory-forget",
  "automation",
  "set-check-ins"
]);

const withOutgoing = (operationId: string, change: Partial<Outgoing>) => (current: State): State => ({
  ...current,
  outbox: current.outbox.map((item) => (item.operationId === operationId ? { ...item, ...change } : item))
});

const withoutOutgoing = (operationId: string) => (current: State): State => ({
  ...current,
  outbox: current.outbox.filter((item) => item.operationId !== operationId)
});

/**
 * Puts a kept message on the open chat's socket; it stays kept until ky answers. Returns whether it went now: one
 * with clips to put up first, or one another tab may have sent or taken back, goes once that is settled.
 */
function useDeliver(pending: Pending, live: { readonly current: Live | null }, setState: SetState): (operationId: string) => boolean {
  return useMemo(() => {
    const busy = new Set<string>();

    const write = (operationId: string): boolean => {
      const message = pending.get(operationId);
      const socket = live.current;

      if (message === undefined || socket === null || socket.session !== message.session || !socket.open()) return false;
      const waited = Date.now() - message.at;
      socket.send(JSON.stringify(waited >= SAY_WAITED_MS ? { ...message.message, waited } : message.message));

      if (!message.written) {
        pending.update(operationId, { written: true });
        setState(withOutgoing(operationId, { waiting: false }));
      }

      return true;
    };

    const upload = async (operationId: string): Promise<void> => {
      const message = pending.get(operationId);

      if (message === undefined || message.uploads.length === 0) return;
      const files = new Map<string, string>();

      for (const each of message.uploads) files.set(each.file, await uploadClip(each.body, each.type, () => {}));

      // Taken back while its clips went up: it goes nowhere.
      if (pending.get(operationId) === undefined) return;
      const input = withFiles(message.message.input, files);
      pending.update(operationId, { message: { ...message.message, input }, uploads: [] });
      setState(withOutgoing(operationId, { input, uploads: [] }));
    };

    const later = async (operationId: string): Promise<void> => {
      if (busy.has(operationId)) return;
      busy.add(operationId);

      try {
        if (pending.shared(operationId) && (await messageStore.has(operationId)) === false) {
          // Another tab had it answered, or the user took it back there.
          pending.forget(operationId);
          setState(withoutOutgoing(operationId));

          return;
        }

        await upload(operationId);
        write(operationId);
      } catch (error) {
        // A clip that couldn't go up for want of a connection waits for the next one; one ky refused says why.
        if (error instanceof Error && !(error instanceof UploadOffline)) setState((current) => ({ ...current, error: error.message }));
      } finally {
        busy.delete(operationId);
      }
    };

    return (operationId: string) => {
      const message = pending.get(operationId);

      if (message === undefined) return false;

      if (message.uploads.length === 0 && !pending.shared(operationId)) return write(operationId);
      void later(operationId);

      return false;
    };
  }, [pending, live, setState]);
}

/** Changes made offline: kept on the device, and sent in order once a socket opens, each by one tab only. */
function useActs(live: { readonly current: Live | null }, asks: Asks, setState: SetState) {
  return useMemo(() => {
    const kept: StoredAct[] = [];
    let flushing = false;

    const shown = () => setState((current) => ({ ...current, acts: [...kept] }));

    const sendAct = (socket: Live, { message }: StoredAct) => {
      // An approval's refusal, like one that came too late, is said where the chat shows errors.
      if (message.type === "approval-decide" && message.id !== undefined) {
        asks
          .wait("approval-decide", message.id)
          .then(refusal, why)
          .then((refused) => refused !== undefined && setState((current) => ({ ...current, error: refused })))
          .catch(() => {});
      }

      socket.send(JSON.stringify(message));
    };

    return {
      queue(message: ClientMessage) {
        const act = { id: message.id ?? crypto.randomUUID(), at: Date.now(), message };
        kept.push(act);
        shown();
        void actStore.put(act);
      },
      /** Ones another launch kept. */
      restore(acts: readonly StoredAct[]) {
        const fresh = acts.filter((act) => !kept.some((each) => each.id === act.id));

        if (fresh.length === 0) return;
        kept.push(...fresh);
        kept.sort((a, b) => a.at - b.at);
        shown();
      },
      async flush() {
        if (flushing) return;
        flushing = true;

        try {
          for (let act = kept[0]; act !== undefined && live.current?.open(); act = kept[0]) {
            const taken = await actStore.take(act.id);
            const socket = live.current;

            if (!socket?.open()) {
              // Closed while the device answered: it waits for the next socket.
              if (taken === true) await actStore.put(act);
              break;
            }

            kept.shift();
            shown();

            // Another tab sent it.
            if (taken !== false) sendAct(socket, act);
          }
        } finally {
          flushing = false;
        }
      }
    };
  }, [live, asks, setState]);
}

/** What the device kept from before this launch: messages show at once, in their chat, and go once its socket is open. */
function useRestore(pending: Pending, live: { readonly current: Live | null }, deliver: (operationId: string) => boolean, acts: ReturnType<typeof useActs>, setState: SetState) {
  useEffect(() => {
    let gone = false;

    void pending.restore().then((fresh) => {
      const here = live.current?.session;

      if (gone || here === undefined) return;
      const shown = fresh.filter((each) => each.session === here);

      setState((current) => ({
        ...current,
        outbox: [...current.outbox, ...shown.filter((each) => !current.outbox.some((item) => item.operationId === each.operationId)).map(outgoingOf)]
      }));

      for (const each of shown) deliver(each.operationId);
    });

    void actStore.all().then((kept) => {
      if (gone) return;
      acts.restore(kept);
      void acts.flush();
    });

    return () => {
      gone = true;
    };
  }, [pending, live, deliver, acts, setState]);
}

/** Activity's automation actions, sent over the socket. */
function useAutomationActions(send: (message: ClientMessage) => void) {
  /** Pause, resume, archive, unarchive, run or delete an automation as the user. */
  const changeAutomation = useCallback(
    (automation: string, action: AutomationAction) =>
      send({ type: "automation", id: crypto.randomUUID(), automation, action }),
    [send]
  );

  /** Let the nightly dream book check-ins, or not. */
  const setCheckIns = useCallback((on: boolean) => send({ type: "set-check-ins", id: crypto.randomUUID(), on }), [send]);

  return { changeAutomation, setCheckIns };
}

/** Settings › Subscriptions' actions, answered over the socket. */
function useSubscriptionActions(ask: AskFn, send: (message: ClientMessage) => void) {
  return useMemo(
    () => ({
      onSetClaude: (token: string) => ask("set-claude", { token }).then(refusal, why),
      onGithubRepos: (token: string) => ask("github-repos", { token }).catch(refused),
      onSetGithub: (token: string, repos: readonly string[]) => ask("set-github", { token, repos }).then(refusal, why),
      onRemove: (kind: SubscriptionKind) => send({ type: "remove-subscription", id: crypto.randomUUID(), kind }),
      onChatGptLogin: () => ask("chatgpt-login", {}).catch(refused),
      onChatGptPoll: (login: string) => ask("chatgpt-poll", { login }).catch((error: Error) => ({ error: error.message }))
    }),
    [ask, send]
  );
}

/** Settings › Executor's actions (connect it, tested by the server first, or forget it) and Settings › Peers', answered over the socket. */
function useSettingsActions(ask: AskFn, send: (message: ClientMessage) => void, live: { readonly current: Live | null }) {
  return useMemo(
    () => ({
      executorActions: {
        onConnect: (url: string, token: string) => ask("set-executor", { url, token }).then(refusal, why),
        onRemove: () => send({ type: "remove-executor", id: crypto.randomUUID() }),
        onPolicy: (tool: string, policy: ToolPolicy) => ask("set-tool-policy", { tool, policy }).then(() => undefined, why)
      },
      peerActions: peerActions(ask),
      mailActions: mailActions(ask),
      approvalActions: {
        // Offline the tap waits on the device and goes once ky is back; its card says so (src/ui/Approvals.tsx).
        onDecide: async (approval: string, action: ApprovalAction) => {
          if (live.current?.open()) return ask("approval-decide", { approval, action }).then(refusal, why);
          send({ type: "approval-decide", id: crypto.randomUUID(), approval, action });

          return undefined;
        }
      }
    }),
    [ask, send, live]
  );
}

/** Settings › Proactivity's actions, and whether the socket is open to answer them. */
function proactivityActionsOf(ask: AskFn, open: boolean) {
  return {
    open,
    onView: () => ask("proactivity", {}),
    onSet: (level: ProactivityLevel) => ask("set-proactivity", { level }),
    onLooks: (looks: readonly string[]) => ask("set-looks", { looks }),
    onRightAway: (most: number) => ask("set-right-away", { most }),
    onZone: () => ask("zone", {}),
    onSetZone: (zone: string | null) => ask("set-zone", { zone }),
    onPushKey: () => ask("push-key", {}),
    onSubscribe: (device: { endpoint: string; p256dh: string; auth: string }) => ask("push-subscribe", device),
    onUnsubscribe: (endpoint: string) => ask("push-unsubscribe", { endpoint }),
    onWatching: (watching: boolean) => ask("watching", { watching })
  };
}

/** Settings › Peers' actions. */
function peerActions(ask: AskFn) {
  return {
    onList: () => ask("peer-list", {}).catch(() => []),
    onInvite: (name: string) => ask("peer-invite", { name }).catch(refused),
    onPair: (name: string, address: string, code: string) => ask("peer-pair", { name, address, code }).then(refusal, why),
    onRemove: (name: string) => ask("peer-remove", { name }).then(refusal, why)
  };
}

/** Settings › Mail's actions. */
function mailActions(ask: AskFn) {
  return {
    onView: () => ask("mail-view", {}),
    onApprove: (mail: string) => ask("mail-approve", { mail }).then(refusal, why),
    onDiscard: (mail: string) => ask("mail-discard", { mail }).then(refusal, why),
    onDisallow: (address: string) => ask("mail-disallow", { address }).then(refusal, why)
  };
}

/** Quiet this long after a change, the view is saved; streaming tokens would otherwise write on every delta. */
const SAVE_AFTER_MS = 500;

/** The save waits for an idle moment, but no longer than this. */
const IDLE_WITHIN_MS = 2_000;

/** Run `work` when the main thread is idle, or soon on browsers without requestIdleCallback (Safari); returns a cancel. */
function whenIdle(work: () => void): () => void {
  if ("requestIdleCallback" in window) {
    const handle = requestIdleCallback(work, { timeout: IDLE_WITHIN_MS });

    return () => cancelIdleCallback(handle);
  }

  const timer = setTimeout(work, 0);

  return () => clearTimeout(timer);
}

/** Keep what the chat shows for the next cold start: once it settles, and as the page is hidden. */
function useSaveView(session: string, state: State) {
  const latest = useRef(state);
  latest.current = state;

  // Until the socket opens, the state is what the cache painted.
  const save = useCallback(() => latest.current.status === "open" && saveView(session, latest.current), [session]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") save();
    };

    document.addEventListener("visibilitychange", onHide);

    return () => document.removeEventListener("visibilitychange", onHide);
  }, [save]);

  useEffect(() => {
    // Writing the cache parses and stringifies it whole, so it waits for a quiet, idle moment.
    let cancelIdle = () => {};

    const timer = setTimeout(() => (cancelIdle = whenIdle(save)), SAVE_AFTER_MS);

    return () => {
      clearTimeout(timer);
      cancelIdle();
    };
  }, [save, state]);
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

      // Offline, useConnection has stopped the socket and `online` starts it again.
      if (!navigator.onLine) return;

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

/**
 * The user's verdicts on ky's unasked posts, read on each connect, and how to give one. A verdict's answer is every
 * verdict since, so this page shows what the server kept.
 */
function useVerdicts(ask: AskFn, open: boolean) {
  const [kept, setKept] = useState<PostVerdicts | null>(null);

  useEffect(() => {
    if (open) ask("post-verdicts", {}).then(setKept, () => undefined);
  }, [ask, open]);

  return useMemo(
    () => ({
      verdicts: Object.fromEntries((kept?.verdicts ?? []).map((each) => [each.item, each])),
      rate: kept === null ? null : { useful: kept.useful, judged: kept.judged },
      onJudge: (item: string, verdict: PostVerdict, reason?: string) =>
        ask("post-verdict", { verdict: reason === undefined ? { item, verdict } : { item, verdict, reason } }).then((answer) => {
          if ("refused" in answer) return answer.refused;
          setKept(answer);

          return undefined;
        }, why)
    }),
    [ask, kept]
  );
}
