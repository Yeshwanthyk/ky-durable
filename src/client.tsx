import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { imageSupport } from "./images";
import type { SettingsView, TaskRow } from "./protocol";
import { currentActivity, toolLabels } from "./ui/activity";
import { FilesContext } from "./ui/Attachments";
import { AutomationsContext } from "./ui/Automations";
import { SendTaskContext } from "./ui/change-review";
import type { BlobVariantId } from "./ui/blob-catalog";
import { ChatThread } from "./ui/ChatThread";
import { CommandPalette } from "./ui/CommandPalette";
import { paletteCommands } from "./ui/commands";
import { ComposerDock } from "./ui/ComposerDock";
import { LightboxProvider } from "./ui/Lightbox";
import { MAIN_SESSION, mainModelName, NAME, openChat, statusLabel, whoSub, workingCount } from "./ui/open-chat";
import { Panel, type Theme } from "./ui/Panel";
import { PanelSlot } from "./ui/PanelSlot";
import { backgroundLine, isLive } from "./ui/task-progress";
import type { PendingImage } from "./ui/pick-images";
import { Sidebar } from "./ui/Sidebar";
import { Topbar } from "./ui/Topbar";
import { useDraft, useReloadOnDeploy, type Draft } from "./ui/use-draft";
import { useNow } from "./ui/use-now";
import { useSeen } from "./ui/use-seen";
import { usePanel, type PanelState } from "./ui/use-panel";
import { useSessionRoute } from "./ui/use-session-route";
import { useShell, type Shell } from "./ui/use-shell";
import { useTheme } from "./ui/use-theme";
import { Welcome } from "./ui/Welcome";
import { usePiSession } from "./use-pi-session";
import "./styles.css";
import "./ui/scotty.css";
import "./ui/shell.css";

/** ky's own blob, ink on light and cream on dark; subagents get one from their name. */
const KY_BLOB: Record<Theme, BlobVariantId> = { light: "squircle-encre", dark: "squircle-creme" };

const speakerBlob = (subagent: TaskRow | undefined, theme: Theme) => (subagent ? undefined : KY_BLOB[theme]);

/** Why the attached images can't go to this session's model, if they can't. */
function whyCantSee(images: readonly PendingImage[], settings: SettingsView | null, talksToMain: boolean) {
  if (images.length === 0 || !settings) return null;

  return imageSupport(settings, talksToMain ? "main" : "subagents");
}

const canSend = (connected: boolean, reading: number, cantSee: string | null) =>
  connected && reading === 0 && !cantSee;

type Ky = ReturnType<typeof usePiSession>;

/** What the open chat looks like, worked out once per render for every part of the page. */
function describe(ky: Ky, session: string, theme: Theme, draft: Draft) {
  const open = openChat(session, ky.chats, ky.tasks);
  const connected = ky.status === "open";
  const cantSee = whyCantSee(draft.images, ky.settings, open.talksToMain);

  return {
    session,
    theme,
    open,
    connected,
    status: { label: statusLabel(ky.status), connected },
    cantSee,
    sendable: canSend(connected, draft.reading, cantSee),
    mainModel: mainModelName(ky.settings),
    working: workingCount(ky.tasks),
    background: backgroundLine(ky.tasks),
    variantId: speakerBlob(open.subagent, theme)
  };
}

type View = ReturnType<typeof describe>;

/** What every part of the page is drawn from. */
type Parts = {
  ky: Ky;
  view: View;
  panel: PanelState;
  shell: Shell;
  now: number;
  setTheme: (theme: Theme) => void;
};

// The chat: the topbar, the thread, and the composer.
function Stage({ ky, view, panel, shell, draft }: Parts & { draft: Draft }) {
  const { open, variantId } = view;

  const activity = useMemo(
    () =>
      currentActivity({
        running: ky.running,
        live: ky.live,
        tools: ky.tools,
        messages: ky.messages,
        retrying: ky.retry !== null
      }),
    [ky.running, ky.live, ky.tools, ky.messages, ky.retry]
  );

  /** While a run is going, Enter steers it; otherwise it starts one. */
  const submit = () => {
    const input = view.sendable ? draft.take() : null;

    if (input !== null) ky.submit(input, ky.running ? "steer" : "followUp");
  };

  return (
    <section className="stage" aria-label="Chat">
      <Topbar
        open={open}
        variantId={variantId}
        running={ky.running}
        status={view.status}
        sub={whoSub(open.where, view.background, view.working, view.mainModel)}
        activity={activity}
        drawer={{ open: shell.drawerOpen, onOpen: () => shell.setDrawerOpen(true) }}
        onBack={() => shell.openSession(MAIN_SESSION)}
        panel={panel}
        updated={ky.updated}
      />

      <div className="chat chat-surface">
        <ChatThread
          session={ky}
          welcome={
            <Welcome
              kind={open.kind}
              speaker={open.speaker}
              variantId={variantId}
              running={ky.running}
              connected={view.connected}
              onPick={draft.setPrompt}
            />
          }
        />
        <ComposerDock
          session={ky}
          draft={draft}
          cantSee={view.cantSee}
          connected={view.connected}
          talksToMain={open.talksToMain}
          onSubmit={submit}
          onStop={ky.abort}
        />
      </div>
    </section>
  );
}

// ky's panel, activity, skills, soul and memory, and settings, in its slot.
function KyPanel({ ky, view, panel, shell, now, setTheme }: Parts) {
  return (
    <PanelSlot panel={panel}>
      <AutomationsContext.Provider
        value={{
          automations: ky.automations,
          providers: ky.settings?.providers ?? [],
          machines: ky.machines,
          chats: ky.chats,
          onAction: ky.changeAutomation,
          onSave: ky.saveAutomation,
        }}
      >
        <Panel
          name={NAME}
          variantId={KY_BLOB[view.theme]}
          active={ky.running || view.working > 0}
          status={view.status}
          model={view.mainModel}
          tasks={ky.tasks}
          machines={ky.machines}
          running={toolLabels(ky.tools, ky.messages)}
          catalog={ky.catalog}
          session={view.session}
          now={now}
          settings={ky.settings}
          skills={ky.skills}
          soul={ky.soul}
          memory={ky.memory}
          memoryActions={{ onSearch: ky.searchMemory, onZoom: ky.zoomMemory, onForget: ky.forgetMemory }}
          specialists={ky.specialists}
          specialistActions={{ onSave: ky.saveSpecialist, onBrief: ky.changeBrief, onHistory: ky.briefHistory }}
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
          onClose={() => panel.setOpen(false)}
          tab={panel.tab}
          onTab={panel.setTab}
        />
      </AutomationsContext.Provider>
    </PanelSlot>
  );
}

// ⌘K, while it is open.
function Palette({ ky, view, panel, shell, now, setTheme }: Parts) {
  if (!shell.paletteOpen) return null;

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
        stopAll: ky.stopAll
      })}
    />
  );
}

function App() {
  const [session, go] = useSessionRoute();
  const draft = useDraft();
  const [theme, setTheme] = useTheme();
  const panel = usePanel();
  const ky = usePiSession(session);
  const now = useNow(ky.tasks.some(isLive));
  const shell = useShell(go, panel, ky.newChat);
  const parts: Parts = { ky, view: describe(ky, session, theme, draft), panel, shell, now, setTheme };

  const times = useMemo(
    () => Object.fromEntries([[MAIN_SESSION, ky.mainUpdatedAt], ...ky.chats.map((chat) => [chat.session, chat.updated_at])]),
    [ky.chats, ky.mainUpdatedAt]
  );

  const unread = useSeen(session, times);

  useReloadOnDeploy(ky.updated, draft);

  return (
    <FilesContext.Provider value={ky.files}>
      <SendTaskContext.Provider value={ky.sendTask}>
        <LightboxProvider>
          <div className="shell" data-panel={panel.open} data-panel-closing={panel.closing} data-drawer={shell.drawerOpen}>
            <div className="sidebar-slot">
              <Sidebar
                chats={ky.chats}
                session={session}
                main={MAIN_SESSION}
                mainUpdatedAt={ky.mainUpdatedAt}
                unread={unread}
                now={now}
                onOpen={shell.openSession}
                onNew={shell.startChat}
                onSearch={() => shell.setPaletteOpen(true)}
                onArchive={ky.archiveChat}
                creating={shell.creating}
              />
            </div>
            {shell.drawerOpen ? <div className="scrim" aria-hidden onClick={() => shell.setDrawerOpen(false)} /> : null}

            <Stage {...parts} draft={draft} />
            <KyPanel {...parts} />
            <Palette {...parts} />
          </div>
        </LightboxProvider>
      </SendTaskContext.Provider>
    </FilesContext.Provider>
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
