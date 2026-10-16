import type { UserInput } from "@earendil-works/pi-durable";
import { memo, useCallback, useImperativeHandle, useMemo, useRef, type ComponentProps, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { imageSupport } from "./images";
import type { SettingsView, TaskRow } from "./protocol";
import { type Activity, currentActivity, toolLabels } from "./ui/activity";
import { FilesContext } from "./ui/Attachments";
import { AutomationsContext } from "./ui/Automations";
import { SendTaskContext } from "./ui/change-review";
import type { BlobVariantId } from "./ui/blob-catalog";
import { ChatThread } from "./ui/ChatThread";
import { CommandPalette } from "./ui/CommandPalette";
import { isQueued, type Outgoing, sendingMessage } from "./outbox";
import { paletteCommands } from "./ui/commands";
import type { Mentionable } from "./ui/Composer";
import { ComposerDock } from "./ui/ComposerDock";
import { ExecutorContext } from "./ui/Executor";
import { PeerContext } from "./ui/Peers";
import { LightboxProvider } from "./ui/Lightbox";
import { TaskStepsContext } from "./ui/Timeline";
import { MAIN_SESSION, mainModelName, NAME, openChat, statusLabel, whoSub, workingCount } from "./ui/open-chat";
import { Panel, type Theme } from "./ui/Panel";
import { PanelSlot } from "./ui/PanelSlot";
import { backgroundLine, isLive } from "./ui/task-progress";
import type { PendingImage } from "./ui/pick-images";
import { Sidebar } from "./ui/Sidebar";
import { Topbar } from "./ui/Topbar";
import { sentTexts } from "./ui/turns";
import { useDraft, useReloadOnDeploy } from "./ui/use-draft";
import { useNow } from "./ui/use-now";
import { useSeen } from "./ui/use-seen";
import { SettingsNavContext, usePanel, type PanelState } from "./ui/use-panel";
import { useSessionRoute } from "./ui/use-session-route";
import { wide } from "./ui/layout";
import { useShell, type Shell } from "./ui/use-shell";
import { shallow, useSame, useStableCallback } from "./ui/use-stable";
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
};

/** What the page can do to the draft from outside the composer. */
type DraftHandle = { readonly setPrompt: (prompt: string) => void };

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
  onSend: (input: UserInput) => void;
  onStop: () => void;
  /** Take a queued message back; false once pi has placed it. */
  onWithdraw: (operationId: string) => Promise<boolean>;
};

// The composer and its draft. The draft lives here rather than in App, so a keystroke renders only this.
const DraftDock = memo(function DraftDock({ handle, run, settings, connected, talksToMain, mentions, group, history, updated, queue, onSend, onStop, onWithdraw }: DraftDockProps) {
  const draft = useDraft();
  const cantSee = whyCantSee(draft.images, settings, talksToMain);

  useImperativeHandle(handle, () => ({ setPrompt: draft.setPrompt }), [draft.setPrompt]);
  useReloadOnDeploy(updated, draft);

  const submit = () => {
    const input = canSend(connected, draft.reading, cantSee) ? draft.take() : null;

    if (input !== null) onSend(input);
  };

  // Editing takes the message out of the queue first, so it never goes in twice.
  const onEdit = async (item: Outgoing) => {
    if (await onWithdraw(item.operationId)) draft.restore(item.input);
  };

  const onDelete = async (item: Outgoing) => {
    await onWithdraw(item.operationId);
  };

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
      sub={whoSub(open.where, view.background, view.working, view.mainModel)}
      activity={activity}
      drawer={drawer}
      onBack={onBack}
      panel={pill}
      updated={ky.updated}
      group={group}
    />
  );
}

// The chat: the topbar, the thread, and the composer.
function Stage(parts: Parts) {
  const { ky, view, panel } = parts;
  const { open, variantId } = view;
  const composer = useRef<DraftHandle>(null);

  // A message on its way shows in the thread at once; one waiting behind the run shows in the queue.
  const queue = useSame(
    useMemo(() => ky.outbox.filter(isQueued), [ky.outbox]),
    shallow
  );

  const sending = useSame(
    useMemo(() => ky.outbox.filter((item) => !isQueued(item)), [ky.outbox]),
    shallow
  );

  const messages = useMemo(
    () => (sending.length === 0 ? ky.messages : [...ky.messages, ...sending.map(sendingMessage)]),
    [ky.messages, sending]
  );

  const thread = useMemo(
    () => ({ messages, live: ky.live, running: ky.running, tools: ky.tools }),
    [messages, ky.live, ky.running, ky.tools]
  );

  const kept = useSame(view.setUp, shallow);
  const onPick = useCallback((prompt: string) => composer.current?.setPrompt(prompt), []);

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

  /** While a run is going, Enter steers it; otherwise it starts one. */
  const onSend = useStableCallback((input: UserInput) => ky.submit(input, ky.running ? "steer" : "followUp"));

  return (
    <section className="stage" aria-label="Chat">
      <StageTop {...parts} />

      <div className="chat chat-surface">
        <ChatThreadMemo chat={view.session} session={thread} welcome={welcome} />
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
          onSend={onSend}
          onStop={ky.abort}
          onWithdraw={ky.withdraw}
        />
      </div>
    </section>
  );
}

// ky's panel, activity, skills, soul and memory, and settings, in its slot. It keeps its own
// clock, so a running task's timer ticks the panel each second and not the whole page.
function KyPanel({ ky, view, status, panel, shell, setTheme }: Parts) {
  const now = useNow(panel.open && ky.tasks.some(clockRunning));
  const providers = ky.settings?.providers ?? NONE;
  const { setOpen, openSection, setPage } = panel;
  const onClose = useCallback(() => setOpen(false), [setOpen]);
  const running = useMemo(() => toolLabels(ky.tools, ky.messages), [ky.tools, ky.messages]);

  const automations = useMemo(
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

  const executor = useMemo(() => ({ view: ky.executor, actions: ky.executorActions }), [ky.executor, ky.executorActions]);
  const nav = useMemo(() => ({ page: panel.page, go: setPage, openSection }), [panel.page, setPage, openSection]);

  const memoryActions = useMemo(
    () => ({ onSearch: ky.searchMemory, onZoom: ky.zoomMemory, onForget: ky.forgetMemory }),
    [ky.searchMemory, ky.zoomMemory, ky.forgetMemory]
  );

  const specialistActions = useMemo(
    () => ({ onSave: ky.saveSpecialist, onBrief: ky.changeBrief, onHistory: ky.briefHistory }),
    [ky.saveSpecialist, ky.changeBrief, ky.briefHistory]
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
                  skills={ky.skills}
                  soul={ky.soul}
                  memory={ky.memory}
                  memoryActions={memoryActions}
                  specialists={ky.specialists}
                  specialistActions={specialistActions}
                  subscriptions={subscriptions}
                  theme={view.theme}
                  onTheme={setTheme}
                  onSetModel={ky.setModel}
                  onSkillChange={ky.changeSkill}
                  onSkillHistory={ky.skillHistory}
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
          </PeerContext.Provider>
        </ExecutorContext.Provider>
      </AutomationsContext.Provider>
    </PanelSlot>
  );
}

// ⌘K, mounted only while it is open, with its own clock for its "5m ago" hints.
function Palette({ ky, view, panel, shell, setTheme }: Parts) {
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
  const [session, go] = useSessionRoute();
  const [theme, setTheme] = useTheme();
  const rawPanel = usePanel();
  const ky = usePiSession(session);
  const shell = useStableShell(useShell(go, rawPanel, ky.newChat));
  const panel = useStablePanel(rawPanel);
  const view = describe(ky, session, theme);
  const label = statusLabel(ky.status);
  const status = useMemo(() => ({ label, connected: view.connected }), [label, view.connected]);
  const parts: Parts = { ky, view, status, panel, shell, setTheme };
  const { setPaletteOpen } = shell;
  const onSearch = useCallback(() => setPaletteOpen(true), [setPaletteOpen]);

  const times = useMemo(
    () => Object.fromEntries([[MAIN_SESSION, ky.mainUpdatedAt], ...ky.chats.map((chat) => [chat.session, chat.updated_at])]),
    [ky.chats, ky.mainUpdatedAt]
  );

  const unread = useSeen(session, times);

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
                />
              </div>
              {/* Always there so it can fade with the drawer; closed, it lets every click through. */}
              <div className="scrim" aria-hidden onClick={() => shell.setDrawerOpen(false)} />

              <Stage {...parts} />
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

createRoot(root).render(<App />);

// Built assets from the cache and the last page offline (public/sw.js). Not in
// dev, where Vite serves modules unhashed and a cache would serve stale code.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  // Without one (private browsing, say) ky works as it did, from the network.
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
