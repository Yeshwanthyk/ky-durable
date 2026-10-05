import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { imageSupport, MAX_IMAGES } from "./images";
import { currentActivity } from "./ui/activity";
import { FilesContext } from "./ui/Attachments";
import type { BlobVariantId } from "./ui/blob-catalog";
import { BotAvatar } from "./ui/BotAvatar";
import { Composer } from "./ui/Composer";
import { Icon, type IconName } from "./ui/Icon";
import { LightboxProvider } from "./ui/Lightbox";
import { CommandPalette } from "./ui/CommandPalette";
import { Panel, type PanelTab, type Theme } from "./ui/Panel";
import { prepareImage, type PendingImage } from "./ui/pick-images";
import { Sidebar } from "./ui/Sidebar";
import { ago } from "./ui/time";
import { Thread } from "./ui/Thread";
import { useFitWidth, WhoSub } from "./ui/WhoSub";
import { buildTurns } from "./ui/turns";
import { usePiSession } from "./use-pi-session";
import "./styles.css";
import "./ui/scotty.css";
import "./ui/shell.css";

/** The main chat's session. Side chats and subagents have their own. */
const MAIN_SESSION = "1";

const NAME = "ky";

/** ky's own blob, ink on light and cream on dark; subagents get one from their name. */
const KY_BLOB: Record<Theme, BlobVariantId> = { light: "squircle-encre", dark: "squircle-creme" };

const SUGGESTIONS: ReadonlyArray<{ icon: IconName; label: string; value: string }> = [
  {
    icon: "plug",
    label: "What's connected",
    value: "What apps do I have connected in Executor, and what can you do with them?"
  },
  {
    icon: "search",
    label: "Research in the background",
    value:
      "Start a subagent to research the best way to back up an iPhone to a NAS, and tell me when it is done."
  },
  {
    icon: "monitor",
    label: "Use my Mac",
    value:
      "On my machine, open https://news.ycombinator.com in a browser and tell me the top 3 stories."
  }
];

function sessionFromUrl(): string {
  const session = new URLSearchParams(location.search).get("session");

  return session && /^[\w-]{1,64}$/.test(session) ? session : MAIN_SESSION;
}

/** The sidebar and panel sit beside the chat from this width; below it they slide over it. */
const WIDE = "(min-width: 1024px)";

const wide = () => window.matchMedia(WIDE).matches;

function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("theme") === "dark" ? "dark" : "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", theme);
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  return [theme, setTheme];
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);

    return () => clearInterval(timer);
  }, []);

  return now;
}

function App() {
  const [session, setSession] = useState(sessionFromUrl);
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<readonly PendingImage[]>([]);
  /** Images still being read and shrunk. */
  const [reading, setReading] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
  const now = useNow();

  const [panelOpen, setPanelOpenState] = useState(wide);
  /** Kept on screen while it pours back into the agent pill. */
  const [panelClosing, setPanelClosing] = useState(false);
  /** Only a click plays the genie; the panel that is open on load just sits there. */
  const [genie, setGenie] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("activity");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const whoRef = useRef<HTMLButtonElement>(null);
  const whoInnerRef = useRef<HTMLSpanElement>(null);
  useFitWidth(whoRef, whoInnerRef);
  const panelRef = useRef<HTMLDivElement>(null);

  const setPanelOpen = (next: boolean | ((open: boolean) => boolean)) => {
    const open = typeof next === "function" ? next(panelOpen && !panelClosing) : next;

    if (open === (panelOpen && !panelClosing)) return;
    setGenie(true);

    if (open) {
      setPanelClosing(false);
      setPanelOpenState(true);
    } else if (panelOpen) setPanelClosing(true);
  };
  // animationend normally ends the genie, but a tab that is not painting never runs it, so
  // settle it anyway a little after it should have finished. A click mid-way restarts the wait.
  useEffect(() => {
    if (!genie) return;
    const timer = setTimeout(() => {
      if (panelClosing) {
        setPanelClosing(false);
        setPanelOpenState(false);
      }
      setGenie(false);
    }, 600);

    return () => clearTimeout(timer);
  }, [genie, panelClosing]);
  /** Only below WIDE: the sidebar is always there above it. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const endRef = useRef<HTMLDivElement>(null);

  const {
    status,
    messages,
    live,
    running,
    tools: runningTools,
    catalog,
    tasks,
    machines,
    chats,
    queued,
    retry,
    error,
    submit: submitPrompt,
    abort,
    stopTask,
    stopAll,
    files,
    settings,
    setModel,
    newChat,
    updated
  } = usePiSession(session);

  // A new deploy is live: reload, unless that would throw away a draft.
  useEffect(() => {
    if (updated && prompt.trim() === "" && images.length === 0) location.reload();
  }, [updated, prompt, images]);

  const turns = useMemo(
    () => buildTurns(messages, live, running, runningTools),
    [messages, live, running, runningTools]
  );

  const activity = useMemo(
    () => currentActivity({ running, live, tools: runningTools, messages, retrying: retry !== null }),
    [running, live, runningTools, messages, retry]
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, running]);

  // Escape closes whatever is sliding over the chat; ⌘K opens the palette from anywhere.
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      setPaletteOpen((open) => !open);
    } else if (event.key === "Escape" && !paletteOpen && !wide()) {
      setDrawerOpen(false);
      setPanelOpen(false);
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keys.current(event);
    addEventListener("keydown", onKey);

    return () => removeEventListener("keydown", onKey);
  }, []);

  // The genie pours out of the agent pill: aim the panel's narrow end at it.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const who = whoRef.current;
    if (!panelOpen || !genie || panel === null || who === null) return;
    const from = who.getBoundingClientRect();
    const to = panel.getBoundingClientRect();
    panel.style.setProperty("--genie-x", `${from.left + from.width / 2 - (to.left + to.width / 2)}px`);
    panel.style.setProperty("--genie-y", `${from.top + from.height / 2 - to.top}px`);
  }, [panelOpen, panelClosing, genie]);

  const connected = status === "open";

  /** While a run is going, Enter queues a follow-up and Steer joins the run. */
  const submit = (whenBusy: "followUp" | "steer" = "followUp") => {
    const text = prompt.trim();

    if ((!text && images.length === 0) || !connected || reading > 0 || cantSee) return;
    setPrompt("");
    setImages([]);
    setImageError(null);
    submitPrompt(
      images.length === 0
        ? text
        : [
            ...images.map(({ type, data, mimeType }) => ({ type, data, mimeType })),
            ...(text ? [{ type: "text" as const, text }] : [])
          ],
      whenBusy
    );
  };

  const addImages = (files: File[]) => {
    const room = MAX_IMAGES - images.length - reading;

    setImageError(files.length > room ? `Attach at most ${MAX_IMAGES} images.` : null);

    for (const file of files.slice(0, Math.max(0, room))) {
      setReading((count) => count + 1);
      prepareImage(file)
        .then((image) => setImages((current) => [...current, image]))
        // prepareImage rejects only with Errors.
        .catch((error: Error) => setImageError(error.message))
        .finally(() => setReading((count) => count - 1));
    }
  };

  useEffect(() => {
    const onPop = () => setSession(sessionFromUrl());
    addEventListener("popstate", onPop);

    return () => removeEventListener("popstate", onPop);
  }, []);

  const openPanel = (tab: PanelTab) => {
    setPanelTab(tab);
    setPanelOpen(true);
  };

  const openSession = (next: string) => {
    setDrawerOpen(false);

    if (!wide()) setPanelOpen(false);

    if (next === session) return;
    history.pushState(null, "", next === MAIN_SESSION ? "/" : `/?session=${next}`);
    setSession(next);
  };

  const startChat = () => {
    setCreating(true);
    newChat()
      .then(openSession)
      .catch(() => undefined)
      .finally(() => setCreating(false));
  };

  const main = session === MAIN_SESSION;
  const chat = chats.find((each) => each.session === session);
  /** Side chats talk to the main agent too, with its model and memory. */
  const talksToMain = main || chat !== undefined;

  /** Why the attached images can't go to this session's model, if they can't. */
  const cantSee =
    images.length > 0 && settings ? imageSupport(settings, talksToMain ? "main" : "subagents") : null;

  const subagent = talksToMain
    ? undefined
    : tasks.find((task) => task.kind === "cloud" && task.session === session);

  const mainSlot = settings?.slots.main;

  const mainModel = mainSlot
    ? (settings?.providers
        .find((provider) => provider.id === mainSlot.provider)
        ?.models.find((each) => each.modelId === mainSlot.modelId)?.name ?? mainSlot.modelId)
    : "Main agent";

  const statusLabel = connected ? "Connected" : status === "connecting" ? "Connecting" : "Reconnecting";

  const working = tasks.filter((task) => task.status === "working").length;

  const empty = messages.length === 0 && !live && !running;

  /** Who is talking in the open chat: ky, or the subagent's own blob. */
  const speaker = subagent?.worker ?? (talksToMain ? NAME : "Subagent");
  const where = main ? null : chat ? chat.title || "New side chat" : (subagent?.title ?? `Session ${session}`);

  return (
    <FilesContext.Provider value={files}>
      <LightboxProvider>
        <div
          className="shell"
          data-panel={panelOpen}
          data-panel-closing={panelClosing}
          data-drawer={drawerOpen}
        >
          <div className="sidebar-slot">
            <Sidebar
              chats={chats}
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
            <header className="topbar">
              <div className="topbar-side">
                {talksToMain ? (
                  <button
                    type="button"
                    className="icon-button pressable drawer-toggle"
                    aria-label="Chats"
                    aria-expanded={drawerOpen}
                    onClick={() => setDrawerOpen(true)}
                  >
                    <Icon name="menu" size={18} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="icon-button pressable"
                    aria-label="Back to the main chat"
                    onClick={() => openSession(MAIN_SESSION)}
                  >
                    <Icon name="arrowLeft" size={18} />
                  </button>
                )}
              </div>
              <button
                type="button"
                ref={whoRef}
                className="who pressable"
                data-busy={activity !== null}
                aria-expanded={panelOpen && !panelClosing}
                aria-label={`${speaker}: ${statusLabel}. ${panelOpen ? "Hide" : "Show"} activity`}
                onClick={() => setPanelOpen((open) => !open)}
              >
                <span className="who-inner" ref={whoInnerRef}>
                  <BotAvatar name={speaker} variantId={subagent ? undefined : KY_BLOB[theme]} active={running} size={28} />
                  <span className="who-text">
                    <span className="who-name">
                      {speaker}
                      <span className="status-dot" data-connected={connected} />
                    </span>
                    <WhoSub activity={activity} idle={where ?? (working > 0 ? `${working} working` : mainModel)} />
                  </span>
                </span>
              </button>
              <div className="topbar-side end">
                {updated ? (
                  <button type="button" className="pill pressable" onClick={() => location.reload()}>
                    Reload
                  </button>
                ) : null}
              </div>
            </header>

            <div className="chat chat-surface">
              <main className="thread" data-scroll>
                <div className="thread-inner">
                  {empty ? (
                    <div className="welcome">
                      <BotAvatar name={speaker} variantId={subagent ? undefined : KY_BLOB[theme]} active={running} size={88} />
                      <h1 className="welcome-title">
                        {main
                          ? "What should we get done?"
                          : chat
                            ? "A side chat"
                            : "Nothing here yet"}
                      </h1>
                      <p className="welcome-text">
                        {main
                          ? "Small things happen here. Bigger ones go to subagents and your machines, and show up in Activity."
                          : chat
                            ? "For a tangent. It shares memory with the main chat, so nothing you settle here is lost."
                            : "This subagent's conversation shows up here as it works."}
                      </p>
                      {talksToMain ? (
                        <div className="suggestions">
                          {SUGGESTIONS.map((suggestion) => (
                            <button
                              key={suggestion.label}
                              type="button"
                              className="pill pressable"
                              disabled={!connected}
                              onClick={() => setPrompt(suggestion.value)}
                            >
                              <Icon name={suggestion.icon} size={14} />
                              {suggestion.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <Thread turns={turns} mode={running ? "live" : "dormant"} />
                  )}
                  <div ref={endRef} />
                </div>
              </main>

              <div className="composer-wrap">
                {retry ? (
                  <div className="composer-note">Retrying: {retry.error}</div>
                ) : queued > 0 ? (
                  <div className="composer-note">{queued} queued behind this run</div>
                ) : null}
                {error ? (
                  <div className="composer-note" data-tone="error" role="alert">
                    {error}
                  </div>
                ) : null}
                {cantSee ?? imageError ? (
                  <div className="composer-note" data-tone="error" role="alert">
                    {cantSee ?? imageError}
                  </div>
                ) : null}
                <Composer
                  value={prompt}
                  onChange={setPrompt}
                  onSubmit={() => submit(running ? "steer" : "followUp")}
                  onStop={abort}
                  working={running}
                  disabled={!connected}
                  busy={reading > 0 || cantSee !== null}
                  images={images}
                  onAddImages={addImages}
                  onRemoveImage={(id) => {
                    setImages((current) => current.filter((image) => image.id !== id));
                    setImageError(null);
                  }}
                  label="Message"
                  placeholder={
                    running
                      ? "Steer the running turn"
                      : talksToMain
                        ? `Message ${NAME}`
                        : "Message this subagent directly"
                  }
                />
              </div>
            </div>
          </section>

          {panelOpen ? (
            <div
              ref={panelRef}
              className="panel-slot"
              data-genie={genie ? (panelClosing ? "out" : "in") : undefined}
              onAnimationEnd={(event) => {
                if (event.target !== event.currentTarget) return;
                if (panelClosing) {
                  setPanelClosing(false);
                  setPanelOpenState(false);
                }
                setGenie(false);
              }}
            >
              <Panel
                name={NAME}
                variantId={KY_BLOB[theme]}
                active={running || working > 0}
                status={{ label: statusLabel, connected }}
                model={mainModel}
                tasks={tasks}
                machines={machines}
                running={runningTools.map((tool) => tool.name)}
                catalog={catalog}
                session={session}
                now={now}
                settings={settings}
                theme={theme}
                onTheme={setTheme}
                onSetModel={setModel}
                onOpen={openSession}
                onStop={stopTask}
                onStopAll={stopAll}
                onClose={() => setPanelOpen(false)}
                tab={panelTab}
                onTab={setPanelTab}
              />
            </div>
          ) : null}
          {paletteOpen ? (
            <CommandPalette
              onClose={() => setPaletteOpen(false)}
              commands={[
                {
                  id: "new",
                  group: "Chats",
                  label: "New side chat",
                  icon: "plus",
                  keywords: "create start",
                  run: startChat
                },
                {
                  id: "main",
                  group: "Chats",
                  label: "Main chat",
                  icon: "chat",
                  hint: main ? "Open" : undefined,
                  run: () => openSession(MAIN_SESSION)
                },
                ...chats.map((each) => ({
                  id: `chat-${each.session}`,
                  group: "Chats",
                  label: each.title || "New chat",
                  icon: "chat" as const,
                  hint: each.session === session ? "Open" : ago(each.updated_at, now),
                  keywords: "side",
                  run: () => openSession(each.session)
                })),
                {
                  id: "activity",
                  group: "ky",
                  label: "Activity",
                  icon: "list",
                  keywords: "tasks tools subagents feed",
                  run: () => openPanel("activity")
                },
                {
                  id: "settings",
                  group: "ky",
                  label: "Settings",
                  icon: "settings",
                  keywords: "models providers preferences",
                  run: () => openPanel("settings")
                },
                {
                  id: "theme",
                  group: "ky",
                  label: theme === "dark" ? "Light appearance" : "Dark appearance",
                  icon: theme === "dark" ? "sun" : "moon",
                  keywords: "theme mode toggle",
                  run: () => setTheme(theme === "dark" ? "light" : "dark")
                },
                ...(working > 0
                  ? [
                      {
                        id: "stop-all",
                        group: "ky",
                        label: `Stop ${working} working`,
                        icon: "stop" as const,
                        keywords: "cancel tasks",
                        run: stopAll
                      }
                    ]
                  : []),
                ...tasks
                  .filter((task) => task.kind === "cloud" && task.session !== null)
                  .slice(0, 20)
                  .map((task) => ({
                    id: `task-${task.id}`,
                    group: "Subagents",
                    label: task.title,
                    icon: "nodes" as const,
                    hint: task.worker,
                    keywords: `${task.worker} ${task.status}`,
                    run: () => openSession(task.session!)
                  }))
              ]}
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
