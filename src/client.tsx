import { useState } from "react";
import { createRoot } from "react-dom/client";
import { imageSupport } from "./images";
import type { SettingsView, TaskRow } from "./protocol";
import { FilesContext } from "./ui/Attachments";
import type { BlobVariantId } from "./ui/blob-catalog";
import { CommandPalette } from "./ui/CommandPalette";
import { paletteCommands } from "./ui/commands";
import { ComposerDock } from "./ui/ComposerDock";
import { ChatThread } from "./ui/ChatThread";
import { LightboxProvider } from "./ui/Lightbox";
import { mainModelName, NAME, openChat, statusLabel, whoSub, workingCount } from "./ui/open-chat";
import { Panel, type Theme } from "./ui/Panel";
import { PanelSlot } from "./ui/PanelSlot";
import type { PendingImage } from "./ui/pick-images";
import { Sidebar } from "./ui/Sidebar";
import { Topbar } from "./ui/Topbar";
import { useDraft, useReloadOnDeploy } from "./ui/use-draft";
import { useNow } from "./ui/use-now";
import { usePanel, wide } from "./ui/use-panel";
import { MAIN_SESSION, useSessionRoute } from "./ui/use-session-route";
import { useShortcuts } from "./ui/use-shortcuts";
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

function App() {
  const [session, go] = useSessionRoute();
  const draft = useDraft();
  const [theme, setTheme] = useTheme();
  const now = useNow();
  const panel = usePanel();
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Only below WIDE: the sidebar is always there above it. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const pi = usePiSession(session);

  useReloadOnDeploy(pi.updated, draft);

  // Escape closes whatever is sliding over the chat; ⌘K opens the palette from anywhere.
  useShortcuts(
    () => setPaletteOpen((open) => !open),
    () => {
      if (paletteOpen || wide()) return;
      setDrawerOpen(false);
      panel.setOpen(false);
    }
  );

  const openSession = (next: string) => {
    setDrawerOpen(false);

    if (!wide()) panel.setOpen(false);
    go(next);
  };

  const startChat = () => {
    setCreating(true);
    pi.newChat()
      .then(openSession)
      .catch(() => undefined)
      .finally(() => setCreating(false));
  };

  const open = openChat(session, pi.chats, pi.tasks);
  const connected = pi.status === "open";
  const status = { label: statusLabel(pi.status), connected };
  const cantSee = whyCantSee(draft.images, pi.settings, open.talksToMain);
  const sendable = canSend(connected, draft.reading, cantSee);
  const mainModel = mainModelName(pi.settings);
  const working = workingCount(pi.tasks);
  const variantId = speakerBlob(open.subagent, theme);

  /** While a run is going, Enter steers it; otherwise it starts one. */
  const submit = () => {
    const input = sendable ? draft.take() : null;

    if (input !== null) pi.submit(input, pi.running ? "steer" : "followUp");
  };

  return (
    <FilesContext.Provider value={pi.files}>
      <LightboxProvider>
        <div className="shell" data-panel={panel.open} data-panel-closing={panel.closing} data-drawer={drawerOpen}>
          <div className="sidebar-slot">
            <Sidebar
              chats={pi.chats}
              session={session}
              main={MAIN_SESSION}
              now={now}
              onOpen={openSession}
              onNew={startChat}
              onSearch={() => setPaletteOpen(true)}
              creating={creating}
            />
          </div>
          {drawerOpen ? <div className="scrim" aria-hidden onClick={() => setDrawerOpen(false)} /> : null}

          <section className="stage" aria-label="Chat">
            <Topbar
              talksToMain={open.talksToMain}
              drawerOpen={drawerOpen}
              onDrawer={() => setDrawerOpen(true)}
              onBack={() => openSession(MAIN_SESSION)}
              whoRef={panel.whoRef}
              speaker={open.speaker}
              variantId={variantId}
              running={pi.running}
              status={status}
              sub={whoSub(open.where, working, mainModel)}
              panelOpen={panel.open}
              panelShown={panel.shown}
              onToggle={panel.toggle}
              updated={pi.updated}
            />

            <div className="chat chat-surface">
              <ChatThread
                view={pi}
                welcome={
                  <Welcome
                    kind={open.kind}
                    speaker={open.speaker}
                    variantId={variantId}
                    running={pi.running}
                    connected={connected}
                    onPick={draft.setPrompt}
                  />
                }
              />
              <ComposerDock
                view={pi}
                draft={draft}
                cantSee={cantSee}
                connected={connected}
                talksToMain={open.talksToMain}
                name={NAME}
                onSubmit={submit}
                onStop={pi.abort}
              />
            </div>
          </section>

          <PanelSlot panel={panel}>
            <Panel
              name={NAME}
              variantId={KY_BLOB[theme]}
              active={pi.running || working > 0}
              status={status}
              model={mainModel}
              tasks={pi.tasks}
              machines={pi.machines}
              running={pi.tools.map((tool) => tool.name)}
              catalog={pi.catalog}
              session={session}
              now={now}
              settings={pi.settings}
              theme={theme}
              onTheme={setTheme}
              onSetModel={pi.setModel}
              onOpen={openSession}
              onStop={pi.stopTask}
              onStopAll={pi.stopAll}
              onClose={() => panel.setOpen(false)}
              tab={panel.tab}
              onTab={panel.setTab}
            />
          </PanelSlot>
          {paletteOpen ? (
            <CommandPalette
              onClose={() => setPaletteOpen(false)}
              commands={paletteCommands({
                session,
                main: open.main,
                chats: pi.chats,
                tasks: pi.tasks,
                now,
                theme,
                working,
                openSession,
                startChat,
                openPanel: panel.openTab,
                setTheme,
                stopAll: pi.stopAll
              })}
            />
          ) : null}
        </div>
      </LightboxProvider>
    </FilesContext.Provider>
  );
}

const root = document.getElementById("root");

if (!root) throw new Error("Missing #root element");

createRoot(root).render(<App />);
