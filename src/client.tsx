import type { UserInput } from "@earendil-works/pi-durable";
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type ComponentProps, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { imageSupport } from "./files/media";
import type { SettingsView, TaskRow } from "./protocol";
import { type Activity, currentActivity, toolLabels } from "./ui/activity";
import { FilesContext } from "./ui/Attachments";
import { AutomationsContext, RoutinesContext } from "./ui/Automations";
import { SendTaskContext } from "./ui/change-review";
import type { CardAnswer } from "./ui-blocks";
import type { BlobVariantId } from "./ui/blob-catalog";
import { ChatThread } from "./ui/ChatThread";
import { CommandPalette } from "./ui/CommandPalette";
import { isQueued, isReturned, type Outgoing, sendingMessage } from "./outbox";
import { paletteCommands } from "./ui/commands";
import type { Mentionable } from "./ui/Composer";
import { ComposerDock } from "./ui/ComposerDock";
import { ExecutorContext } from "./ui/Executor";
import { ApprovalsContext } from "./ui/Approvals";
import { MailContext } from "./ui/Mail";
import { ProactivityContext } from "./ui/Proactivity";
import { LedgerContext } from "./ui/LastNight";
import { PeerContext } from "./ui/Peers";
import { LightboxProvider } from "./ui/Lightbox";
import { TaskStepsContext } from "./ui/Timeline";
import { useShownCrew } from "./ui/Crew";
import { crewOf, NO_CREW, sameCrew } from "./ui/crew-of";
import { MAIN_SESSION, mainModelName, NAME, openChat, statusLabel, whoSub, workingCount } from "./ui/open-chat";
import { Panel, type Theme } from "./ui/Panel";
import { PanelSlot } from "./ui/PanelSlot";
import { backgroundLine, isLive } from "./ui/task-progress";
import type { PendingImage } from "./ui/pick-images";
import { RoutineList } from "./ui/RoutineList";
import { Sidebar } from "./ui/Sidebar";
import { Topbar } from "./ui/Topbar";
import { sentTexts } from "./ui/turns";
import { useDraft, useReloadOnDeploy } from "./ui/use-draft";
import { useNow } from "./ui/use-now";
import type { Visit } from "./ui/thread-marks";
import { useSeen } from "./ui/use-seen";
import { SettingsNavContext, usePanel, type PanelState } from "./ui/use-panel";
import { Artifacts } from "./ui/Artifacts";
import { SkillsPage as Skills } from "./ui/SkillsPage";
import { type ArtifactKind, type SkillFilter, useSessionRoute } from "./ui/use-session-route";
import { wide } from "./ui/layout";
import { useShell, type Shell } from "./ui/use-shell";
import { shallow, useSame, useStableCallback } from "./ui/use-stable";
import { restoreAccent } from "./ui/use-accent";
import { useTheme } from "./ui/use-theme";
import { AvatarsContext } from "./ui/Bloub";
import { type FirstRunTarget, type SetUp, SOUL_INTERVIEW, Welcome } from "./ui/Welcome";
import { usePiSession } from "./use-pi-session";
import "./styles.css";
import "./ui/scotty.css";
import "./ui/shell.css";

/** ky's own blob, ink on light and cream on dark; subagents get one from their name. */
const KY_BLOB: Record<Theme, BlobVariantId> = { light: "squircle-encre", dark: "squircle-creme" };

const speakerBlob = (subagent: TaskRow | undefined, theme: Theme) => (subagent ? undefined : KY_BLOB[theme]);

/** One empty list, so a prop that falls back to none keeps its identity. */
const NONE: readonly never[] = [];

/** What a specialist's "New avatar" asks ky: the make-avatar skill does the rest, in chat. */
const avatarRequest = (id: string) =>
  `Design a new avatar for @${id}, from what its brief says it does. Show me three options, then save the one I pick.`;

// The heavy parts, memoised here so a render of the page that leaves their props alone skips them:
// each streamed token, each tick, and anything else the page re-renders for.
const TopbarMemo = memo(Topbar);

const ChatThreadMemo = memo(ChatThread);

const PanelMemo = memo(Panel);

// The chats list, with its own clock: its "5m ago" labels need no more than the 30-second one.
const ChatsSidebar = memo(function ChatsSidebar(props: Omit<ComponentProps<typeof Sidebar>, "now">) {
  const now = useNow();

  return <Sidebar {...props} now={now} />;
});

/** What ky made, over the chat, with its own clock for "Yesterday" and the like. */
function ArtifactsPage({ kind, tasks, onKind, onChats }: { kind: ArtifactKind; tasks: Ky["tasks"]; onKind: (kind: ArtifactKind) => void; onChats: () => void }) {
  const now = useNow();
  const titles = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);

  return <Artifacts kind={kind} titles={titles} now={now} onKind={onKind} onChats={onChats} />;
}

/** ky's skills and kits, over the chat, with their own clock for "changed 2d ago". */
function SkillsPage({ filter, ky, onFilter, onChats }: { filter: SkillFilter; ky: Ky; onFilter: (filter: SkillFilter) => void; onChats: () => void }) {
  const now = useNow();

  return <Skills filter={filter} skills={ky.skills} now={now} onFilter={onFilter} onChats={onChats} onChange={ky.changeSkill} onHistory={ky.skillHistory} />;
}

/** Why the attached images can't go to this session's model, if they can't. */
function whyCantSee(images: readonly PendingImage[], settings: SettingsView | null, talksToMain: boolean) {
  if (images.length === 0 || !settings) return null;

  return imageSupport(settings, talksToMain ? "main" : "worker");
}

const canSend = (connected: boolean, reading: number, cantSee: string | null) =>
  connected && reading === 0 && !cantSee;

/** A live task whose clock is running; a queued one that has not started shows no time to tick. */
const clockRunning = (task: TaskRow) => isLive(task) && task.started_at !== null;

const sameActivity = (a: Activity | null, b: Activity | null) =>
  a === b || (a !== null && b !== null && a.icon === b.icon && a.label === b.label);

type Ky = ReturnType<typeof usePiSession>;

/** What is set up, for the first-run cards and the pills. */
function setUp({ settings, executor, soul, machines, subscriptions }: Ky): SetUp {
  const connected = (kind: "claude" | "chatgpt") => subscriptions.some((each) => each.kind === kind && each.connected);

  return {
    known: [settings, executor, soul].every((each) => each !== null),
    onlyProvider: settings && onlyProvider(settings),
    machines: machines.length > 0,
    claude: connected("claude"),
    chatgpt: connected("chatgpt"),
    executor: Boolean(executor?.url),
    soul: Number(soul?.version) > 1
  };
}

/** The main chat's provider while Workers AI is the only one there is. */
function onlyProvider({ providers }: SettingsView): string | null {
  const [only] = providers.filter((each) => providers.length === 1 && each.id === "workers-ai");

  return only?.name ?? null;
}

/** What the open chat looks like, worked out once per render for every part of the page. */
function describe(ky: Ky, session: string, theme: Theme) {
  const open = openChat(session, ky.chats, ky.tasks);

  return {
    session,
    theme,
    open,
    connected: ky.status === "open",
    mainModel: mainModelName(ky.settings),
    working: workingCount(ky.tasks),
    background: backgroundLine(ky.tasks),
    variantId: speakerBlob(open.subagent, theme),
    setUp: setUp(ky)
  };
}

type View = ReturnType<typeof describe>;

/** How the connection is doing, in words. */
type Status = { readonly label: string; readonly connected: boolean };

/** What every part of the page is drawn from. */
type Parts = {
  ky: Ky;
  view: View;
  status: Status;
  panel: PanelState;
  shell: Shell;
  setTheme: (theme: Theme) => void;
  /** When the user last saw the open chat, for its New divider. */
  visit: Visit;
  /** Opens the Skills page, from the sidebar or the command palette. */
  onSkillsPage: () => void;
};

/** What the page can do to the draft from outside the composer: put a suggested ask in it. */
type DraftHandle = { readonly pick: (prompt: string) => void };

type DraftDockProps = {
  handle: RefObject<DraftHandle | null>;
  run: ComponentProps<typeof ComposerDock>["session"];
  settings: SettingsView | null;
  connected: boolean;
  talksToMain: boolean;
  mentions: readonly Mentionable[];
  group: boolean;
  /** What the user sent in this chat, oldest first. */
  history: readonly string[];
  /** A newer deploy is serving; reload unless that would throw the draft away. */
  updated: boolean;
  queue: readonly Outgoing[];
  /** Queued messages ky gave back, as Stop does, for the composer to take in. */
  returned: readonly Outgoing[];
  onSend: (input: UserInput) => void;
  onStop: () => void;
  /** Stop the step ky is on, so the queue goes in now. */
  onSteer: () => void;
  /** Take a queued message back; false once pi has placed it. */
  onWithdraw: (operationId: string) => Promise<boolean>;
  /** The composer has taken in these returned messages. */
  onReturned: (operationIds: ReadonlySet<string>) => void;
};

/**
 * Messages ky gave back go into the composer, oldest first and above what is there, so nothing the
 * user sent is lost: Stop, or a run that ended with them still queued, hands them back to edit or send.
 */
function useTakeReturned(returned: readonly Outgoing[], restore: (input: UserInput) => void, onReturned: (operationIds: ReadonlySet<string>) => void) {
  const taken = useRef(new Set<string>());

  useEffect(() => {
    const fresh = returned.filter((item) => !taken.current.has(item.operationId));

    if (fresh.length === 0) return;

    for (const item of fresh) taken.current.add(item.operationId);

    // Each restore goes above the draft, so the newest goes first and the oldest ends on top.
    for (const item of [...fresh].reverse()) restore(item.input);
    onReturned(new Set(fresh.map((item) => item.operationId)));
  }, [returned, restore, onReturned]);
}

/** Edit takes a queued message back into the composer, first out of the queue so it never goes in twice; delete just takes it back. */
function useQueueActions(onWithdraw: (operationId: string) => Promise<boolean>, restore: (input: UserInput) => void) {
  const onEdit = async (item: Outgoing) => {
    if (await onWithdraw(item.operationId)) restore(item.input);
  };

  const onDelete = async (item: Outgoing) => {
    await onWithdraw(item.operationId);
  };

  return { onEdit, onDelete };
}

// The composer and its draft. The draft lives here rather than in App, so a keystroke renders only this.
const DraftDock = memo(function DraftDock({ handle, run, settings, connected, talksToMain, mentions, group, history, updated, queue, returned, onSend, onStop, onSteer, onWithdraw, onReturned }: DraftDockProps) {
  const draft = useDraft();
  const cantSee = whyCantSee(draft.images, settings, talksToMain);

  useImperativeHandle(handle, () => ({ pick: draft.pick }), [draft.pick]);
  useReloadOnDeploy(updated, draft);
  useTakeReturned(returned, draft.restore, onReturned);

  // A video's frames go only to a model that reads images; its tag still names the video.
  const seesImages = settings === null || imageSupport(settings, talksToMain ? "main" : "worker") === null;

  const submit = () => {
    const input = canSend(connected, draft.reading, cantSee) ? draft.take(seesImages) : null;

    if (input !== null) onSend(input);
  };

  const { onEdit, onDelete } = useQueueActions(onWithdraw, draft.restore);

  return (
    <ComposerDock
      session={run}
      queue={queue}
      draft={draft}
      cantSee={cantSee}
      connected={connected}
      talksToMain={talksToMain}
      mentions={mentions}
      group={group}
      history={history}
      onSubmit={submit}
      onStop={onStop}
      onSteer={onSteer}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
});

// The topbar, with props that keep their identity while nothing in them changes.
function StageTop({ ky, view, status, panel, shell }: Parts) {
  const { open } = view;
  const members = ky.groups[view.session] ?? NONE;

  const activity = useSame(
    useMemo(
      () =>
        currentActivity({
          running: ky.running,
          live: ky.live,
          tools: ky.tools,
          messages: ky.messages,
          retrying: ky.retry !== null
        }),
      [ky.running, ky.live, ky.tools, ky.messages, ky.retry]
    ),
    sameActivity
  );

  // Only ky's own chats have specialists working for them.
  const crew = useShownCrew(
    useSame(
      useMemo(() => (open.talksToMain ? crewOf(ky.tasks, view.session, members) : NO_CREW), [open.talksToMain, ky.tasks, view.session, members]),
      sameCrew
    ),
    view.session
  );

  const who = useMemo(() => ({ talksToMain: open.talksToMain, speaker: open.speaker }), [open.talksToMain, open.speaker]);
  const { openSession } = shell;
  const onOpenDrawer = useStableCallback(shell.showChats);
  const drawer = useMemo(() => ({ open: shell.drawerOpen, onOpen: onOpenDrawer }), [shell.drawerOpen, onOpenDrawer]);
  const onBack = useCallback(() => openSession(MAIN_SESSION), [openSession]);

  const pill = useMemo(
    () => ({ whoRef: panel.whoRef, open: panel.open, shown: panel.shown, toggle: panel.toggle }),
    [panel.whoRef, panel.open, panel.shown, panel.toggle]
  );

  const setMembers = useStableCallback((next: string[]) => ky.setMembers(view.session, next));

  const group = useMemo(
    () => (open.talksToMain ? { members, specialists: ky.specialists, onChange: setMembers } : undefined),
    [open.talksToMain, members, ky.specialists, setMembers]
  );

  return (
    <TopbarMemo
      open={who}
      variantId={view.variantId}
      running={ky.running}
      status={status}
      sub={whoSub(crew.line, open.where, view.background, view.working, view.mainModel)}
      activity={activity}
      drawer={drawer}
      onBack={onBack}
      panel={pill}
      updated={ky.updated}
      group={group}
      crew={crew}
    />
  );
}

// The chat: the topbar, the thread, and the composer.
/**
 * Where each outgoing message shows: one on its way in the thread at once, one waiting behind the
 * run in the queue, and one ky gave back in the composer.
 */
function useOutboxParts(outbox: readonly Outgoing[]) {
  const queue = useSame(
    useMemo(() => outbox.filter(isQueued), [outbox]),
    shallow
  );

  const sending = useSame(
    useMemo(() => outbox.filter((item) => !isQueued(item) && !isReturned(item)), [outbox]),
    shallow
  );

  const returned = useSame(
    useMemo(() => outbox.filter(isReturned), [outbox]),
    shallow
  );

  return { queue, sending, returned };
}

function Stage(parts: Parts) {
  const { ky, view, panel, visit } = parts;
  const { open, variantId } = view;
  const composer = useRef<DraftHandle>(null);

  const { queue, sending, returned } = useOutboxParts(ky.outbox);

  const messages = useMemo(
    () => (sending.length === 0 ? ky.messages : [...ky.messages, ...sending.map(sendingMessage)]),
    [ky.messages, sending]
  );

  const thread = useMemo(
    () => ({ messages, live: ky.live, running: ky.running, tools: ky.tools, answers: ky.answers }),
    [messages, ky.live, ky.running, ky.tools, ky.answers]
  );

  const kept = useSame(view.setUp, shallow);
  const onPick = useCallback((prompt: string) => composer.current?.pick(prompt), []);

  const onGo = useStableCallback((target: FirstRunTarget) =>
    target === "soul" ? ky.submit(SOUL_INTERVIEW) : panel.openSection(target)
  );

  const welcome = useMemo(
    () => (
      <Welcome
        kind={open.kind}
        speaker={open.speaker}
        variantId={variantId}
        running={ky.running}
        connected={view.connected}
        setUp={kept}
        onPick={onPick}
        onGo={onGo}
      />
    ),
    [open.kind, open.speaker, variantId, ky.running, view.connected, kept, onPick, onGo]
  );

  const run = useMemo(
    () => ({ retry: ky.retry, queued: ky.queued, error: ky.error, running: ky.running }),
    [ky.retry, ky.queued, ky.error, ky.running]
  );

  // Kept while the chat's sent messages are the same, so a streamed token does not render the composer.
  const history = useSame(
    useMemo(() => sentTexts(ky.messages), [ky.messages]),
    shallow
  );

  /** While a run is going, Enter steers it; otherwise it starts one. A tap on a card ky showed sends the same way. */
  const onSend = useStableCallback((input: UserInput, card?: CardAnswer) => ky.submit(input, ky.running ? "steer" : "followUp", card));

  const routines = useMemo(() => ({ automations: ky.automations, onAction: ky.changeAutomation }), [ky.automations, ky.changeAutomation]);

  const approvals = useMemo(() => ({ approvals: ky.approvals, onDecide: ky.approvalActions.onDecide }), [ky.approvals, ky.approvalActions]);

  return (
    <section className="stage" aria-label="Chat">
      <StageTop {...parts} />

      <div className="chat chat-surface">
        <RoutinesContext.Provider value={routines}>
          <ApprovalsContext.Provider value={approvals}>
          <ChatThreadMemo chat={view.session} session={thread} welcome={welcome} recalled={ky.recalled} speaker={open.speaker} variantId={variantId} onReply={onSend} visit={visit} />
          </ApprovalsContext.Provider>
        </RoutinesContext.Provider>
        <DraftDock
          handle={composer}
          run={run}
          settings={ky.settings}
          connected={view.connected}
          talksToMain={open.talksToMain}
          mentions={open.talksToMain ? ky.specialists : NONE}
          group={open.talksToMain && (ky.groups[view.session]?.length ?? 0) > 0}
          history={history}
          updated={ky.updated}
          queue={queue}
          returned={returned}
          onSend={onSend}
          onStop={ky.abort}
          onSteer={ky.steerNow}
          onWithdraw={ky.withdraw}
          onReturned={ky.takeReturned}
        />
      </div>
    </section>
  );
}

/** The automations' context: the list, what a form offers, and the actions; for the panel and a routine's page. */
function useAutomations(ky: Ky) {
  const providers = ky.settings?.providers ?? NONE;

  return useMemo(
    () => ({
      automations: ky.automations,
      providers,
      machines: ky.machines,
      chats: ky.chats,
      onAction: ky.changeAutomation,
      onSave: ky.saveAutomation,
      checkIns: ky.checkIns,
      onCheckIns: ky.setCheckIns
    }),
    [ky.automations, providers, ky.machines, ky.chats, ky.changeAutomation, ky.saveAutomation, ky.checkIns, ky.setCheckIns]
  );
}

// The Routines page over the chat, with its own clock: a live run's time ticks each second.
function RoutineStage({ open, ky, onOpen, onChats }: { open: string; ky: Ky; onOpen: (id: string) => void; onChats: () => void }) {
  const automations = useAutomations(ky);
  const going = ky.automations.some((each) => each.runs[0]?.status === "working" || each.runs[0]?.status === "queued");
  const now = useNow(going);

  return (
    <AutomationsContext.Provider value={automations}>
      <ProactivityContext.Provider value={ky.proactivityActions}>
        <RoutineList open={open} tasks={ky.tasks} now={now} onOpen={onOpen} onChats={onChats} />
      </ProactivityContext.Provider>
    </AutomationsContext.Provider>
  );
}

// ky's panel, activity, skills, soul and memory, and settings, in its slot. It keeps its own
// clock, so a running task's timer ticks the panel each second and not the whole page.
function KyPanel({ ky, view, status, panel, shell, setTheme }: Parts) {
  const now = useNow(panel.open && ky.tasks.some(clockRunning));
  const { setOpen, openSection, setPage } = panel;
  const onClose = useCallback(() => setOpen(false), [setOpen]);
  const running = useMemo(() => toolLabels(ky.tools, ky.messages), [ky.tools, ky.messages]);

  const automations = useAutomations(ky);

  const executor = useMemo(() => ({ view: ky.executor, actions: ky.executorActions }), [ky.executor, ky.executorActions]);
  const nav = useMemo(() => ({ page: panel.page, go: setPage, openSection }), [panel.page, setPage, openSection]);

  const memoryActions = useMemo(
    () => ({ onSearch: ky.searchMemory, onZoom: ky.zoomMemory, onForget: ky.forgetMemory }),
    [ky.searchMemory, ky.zoomMemory, ky.forgetMemory]
  );

  const specialistActions = useMemo(
    () => ({
      onSave: ky.saveSpecialist,
      onBrief: ky.changeBrief,
      onHistory: ky.briefHistory,
      onAvatar: (id: string) => ky.submit(avatarRequest(id))
    }),
    [ky.saveSpecialist, ky.changeBrief, ky.briefHistory, ky.submit]
  );

  const subscriptions = useMemo(
    () => ({ views: ky.subscriptions, actions: ky.subscriptionActions }),
    [ky.subscriptions, ky.subscriptionActions]
  );

  const keyActions = useMemo(() => ({ onAdd: ky.addKey, onRemove: ky.removeKey }), [ky.addKey, ky.removeKey]);

  return (
    <PanelSlot panel={panel}>
      <AutomationsContext.Provider value={automations}>
        <ExecutorContext.Provider value={executor}>
          <PeerContext.Provider value={ky.peerActions}>
          <MailContext.Provider value={ky.mailActions}>
          <ProactivityContext.Provider value={ky.proactivityActions}>
          <LedgerContext.Provider value={ky.ledgerActions}>
            <SettingsNavContext.Provider value={nav}>
              <TaskStepsContext.Provider value={ky.taskSteps}>
                <PanelMemo
                  name={NAME}
                  variantId={KY_BLOB[view.theme]}
                  active={ky.running || view.working > 0}
                  status={status}
                  model={view.mainModel}
                  tasks={ky.tasks}
                  machines={ky.machines}
                  running={running}
                  catalog={ky.catalog}
                  session={view.session}
                  now={now}
                  settings={ky.settings}
                  setup={ky.setup}
                  soul={ky.soul}
                  memory={ky.memory}
                  memoryActions={memoryActions}
                  specialists={ky.specialists}
                  specialistActions={specialistActions}
                  subscriptions={subscriptions}
                  theme={view.theme}
                  onTheme={setTheme}
                  onSetModel={ky.setModel}
                  onSoulChange={ky.changeSoul}
                  onSoulHistory={ky.soulHistory}
                  onOpen={shell.openSession}
                  onStop={ky.stopTask}
                  onStopAll={ky.stopAll}
                  onSetMachine={ky.setMachine}
                  onSetRepo={ky.setRepo}
                  keyActions={keyActions}
                  onClose={onClose}
                  tab={panel.tab}
                  onTab={panel.setTab}
                />
              </TaskStepsContext.Provider>
            </SettingsNavContext.Provider>
          </LedgerContext.Provider>
          </ProactivityContext.Provider>
          </MailContext.Provider>
          </PeerContext.Provider>
        </ExecutorContext.Provider>
      </AutomationsContext.Provider>
    </PanelSlot>
  );
}

// ⌘K, mounted only while it is open, with its own clock for its "5m ago" hints.
function Palette({ ky, view, panel, shell, setTheme, onSkillsPage }: Parts) {
  const now = useNow();

  return (
    <CommandPalette
      onClose={() => shell.setPaletteOpen(false)}
      commands={paletteCommands({
        session: view.session,
        main: view.open.main,
        chats: ky.chats,
        tasks: ky.tasks,
        now,
        theme: view.theme,
        working: view.working,
        openSession: shell.openSession,
        startChat: shell.startChat,
        openPanel: panel.openTab,
        openSkills: onSkillsPage,
        setTheme,
        stopAll: ky.stopAll,
        sidebarShown: wide() ? !shell.sidebarHidden : shell.drawerOpen,
        toggleSidebar: shell.toggleSidebar
      })}
    />
  );
}

/** usePanel's handlers, each one function for the page's life, so memoised parts handed them skip renders. */
function useStablePanel(panel: PanelState): PanelState {
  const setOpen = useStableCallback(panel.setOpen);
  const toggle = useStableCallback(panel.toggle);
  const openTab = useStableCallback(panel.openTab);
  const openSection = useStableCallback(panel.openSection);

  return { ...panel, setOpen, toggle, openTab, openSection };
}

/** useShell's handlers, likewise. */
function useStableShell(shell: Shell): Shell {
  const openSession = useStableCallback(shell.openSession);
  const startChat = useStableCallback(shell.startChat);

  return { ...shell, openSession, startChat };
}

function App() {
  const route = useSessionRoute();
  const { session, go } = route;
  const [theme, setTheme] = useTheme();
  const rawPanel = usePanel();
  const ky = usePiSession(session);
  const shell = useStableShell(useShell(go, rawPanel, ky.newChat));
  const panel = useStablePanel(rawPanel);
  const view = describe(ky, session, theme);
  const label = statusLabel(ky.status);
  const status = useMemo(() => ({ label, connected: view.connected }), [label, view.connected]);
  const { setPaletteOpen } = shell;
  const onSearch = useCallback(() => setPaletteOpen(true), [setPaletteOpen]);

  const times = useMemo(
    () => Object.fromEntries([[MAIN_SESSION, ky.mainUpdatedAt], ...ky.chats.map((chat) => [chat.session, chat.updated_at])]),
    [ky.chats, ky.mainUpdatedAt]
  );

  const { unread, visit } = useSeen(session, times);

  const onSkillsPage = useStableCallback(() => {
    // Below the wide layout the panel covers the page, so it steps aside.
    if (!wide()) panel.setOpen(false);
    route.showSkills("all");
  });

  const parts: Parts = { ky, view, status, panel, shell, setTheme, visit, onSkillsPage };

  return (
    <AvatarsContext.Provider value={ky.avatars}>
      <FilesContext.Provider value={ky.files}>
        <SendTaskContext.Provider value={ky.sendTask}>
          <LightboxProvider>
            <div
              className="shell"
              data-panel={panel.open}
              data-panel-closing={panel.closing}
              data-drawer={shell.drawerOpen}
              data-sidebar={shell.sidebarHidden ? "hidden" : undefined}
            >
              <div className="sidebar-slot">
                <ChatsSidebar
                  chats={ky.chats}
                  session={session}
                  main={MAIN_SESSION}
                  mainUpdatedAt={ky.mainUpdatedAt}
                  unread={unread}
                  onOpen={shell.openSession}
                  onNew={shell.startChat}
                  onSearch={onSearch}
                  onArchive={ky.archiveChat}
                  onRename={ky.renameChat}
                  creating={shell.creating}
                  artifacts={route.artifacts !== null}
                  onArtifacts={() => {
                    shell.setDrawerOpen(false);
                    route.showArtifacts("all");
                  }}
                  skills={route.skills !== null}
                  onSkills={() => {
                    shell.setDrawerOpen(false);
                    route.showSkills("all");
                  }}
                  automations={ky.automations}
                  routine={route.routine !== null}
                  onRoutine={() => {
                    shell.setDrawerOpen(false);
                    route.showRoutine("");
                  }}
                />
              </div>
              {/* Always there so it can fade with the drawer; closed, it lets every click through. */}
              <div className="scrim" aria-hidden onClick={() => shell.setDrawerOpen(false)} />

              {route.artifacts !== null ? (
                <ArtifactsPage kind={route.artifacts} tasks={ky.tasks} onKind={route.showArtifacts} onChats={shell.showChats} />
              ) : route.skills !== null ? (
                <SkillsPage filter={route.skills} ky={ky} onFilter={route.showSkills} onChats={shell.showChats} />
              ) : route.routine !== null ? (
                <RoutineStage open={route.routine} ky={ky} onOpen={route.showRoutine} onChats={shell.showChats} />
              ) : (
                <Stage {...parts} />
              )}
              <KyPanel {...parts} />
              {shell.paletteOpen ? <Palette {...parts} /> : null}
            </div>
          </LightboxProvider>
        </SendTaskContext.Provider>
      </FilesContext.Provider>
    </AvatarsContext.Provider>
  );
}

const root = document.getElementById("root");

if (!root) throw new Error("Missing #root element");

restoreAccent();

createRoot(root).render(<App />);

// Built assets from the cache and the last page offline (public/sw.js). Not in
// dev, where Vite serves modules unhashed and a cache would serve stale code.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  // Without one (private browsing, say) ky works as it did, from the network.
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// Once ky is open, what its pushes left in the tray and on the app icon's badge (public/sw.js) has been read, so
// both go.
const readNotifications = async () => {
  if (document.visibilityState !== "visible") return;
  navigator.clearAppBadge?.().catch(() => {});
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;

  for (const shown of (await registration?.getNotifications()) ?? []) shown.close();
};

const read = () => void readNotifications().catch(() => {});

read();

document.addEventListener("visibilitychange", read);
