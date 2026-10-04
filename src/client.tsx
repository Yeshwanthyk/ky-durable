import {
  Button,
  Empty,
  Surface
} from "@cloudflare/kumo";
import {
  ArrowLeftIcon,
  BrainIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CloudIcon,
  DesktopIcon,
  GearIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PlugsConnectedIcon,
  StopCircleIcon,
  SunIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  MachineInfo,
  SettingsView,
  Slot,
  SlotSetting,
  TaskRow,
  ToolInfo
} from "./protocol";
import { imageSupport, MAX_IMAGES } from "./images";
import { Attachments, FilesContext } from "./ui/Attachments";
import { Composer } from "./ui/Composer";
import { LightboxProvider } from "./ui/Lightbox";
import { prepareImage, type PendingImage } from "./ui/pick-images";
import { Thread } from "./ui/Thread";
import { buildTurns } from "./ui/turns";
import { usePiSession } from "./use-pi-session";
import "./styles.css";
import "./ui/scotty.css";

/** The main agent's session; subagents have their own. */
const MAIN_SESSION = "1";

const SUGGESTIONS = [
  {
    icon: <PlugsConnectedIcon size={15} />,
    label: "What's connected",
    value: "What apps do I have connected in Executor, and what can you do with them?"
  },
  {
    icon: <MagnifyingGlassIcon size={15} />,
    label: "Research in the background",
    value:
      "Start a subagent to research the best way to back up an iPhone to a NAS, and tell me when it is done."
  },
  {
    icon: <DesktopIcon size={15} />,
    label: "Use my Mac",
    value:
      "On my machine, open https://news.ycombinator.com in a browser and tell me the top 3 stories."
  }
] satisfies Array<{ icon: ReactNode; label: string; value: string }>;

function sessionFromUrl(): string {
  const session = new URLSearchParams(location.search).get("session");

  return session && /^\d+$/.test(session) ? session : MAIN_SESSION;
}

function ago(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));

  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);

  if (hours < 24) return `${hours}h`;

  return `${Math.round(hours / 24)}d`;
}

function StatusIcon({ status }: { status: TaskRow["status"] }) {
  switch (status) {
    case "queued":
      return <CircleDashedIcon size={16} className="text-kumo-inactive" />;
    case "working":
      return <GearIcon size={16} className="animate-spin text-kumo-accent" />;
    case "done":
      return <CheckCircleIcon size={16} weight="fill" className="text-kumo-success" />;
    case "failed":
      return <XCircleIcon size={16} weight="fill" className="text-kumo-danger" />;
    case "stopped":
      return <StopCircleIcon size={16} className="text-kumo-inactive" />;
  }
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      className={ICON_BUTTON}
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={18} /> : <SunIcon size={18} />}
    />
  );
}

/** Icon buttons get a 44px tap target on touch screens and stay compact on desktop. */
const ICON_BUTTON = "size-11 sm:size-9";

const isLive = (task: TaskRow) => task.status === "queued" || task.status === "working";

function TaskItem({
  task,
  now,
  selected,
  onOpen,
  onStop
}: {
  task: TaskRow;
  now: number;
  selected: boolean;
  onOpen: (session: string) => void;
  onStop: (task: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const opensSession = task.kind === "cloud" && task.session !== null;
  const shared = useContext(FilesContext).some((file) => file.task === task.id);

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => (opensSession ? onOpen(task.session!) : setOpen((value) => !value))}
        className={`flex min-h-11 w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-kumo-elevated ${
          selected ? "bg-kumo-elevated" : ""
        }`}
      >
        <span className="mt-0.5 shrink-0">
          <StatusIcon status={task.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</span>
            <span
              className={`shrink-0 text-xs text-kumo-inactive ${isLive(task) ? "invisible" : ""}`}
            >
              {ago(task.updated_at, now)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-kumo-subtle">
            {task.kind === "cloud" ? <CloudIcon size={12} /> : <DesktopIcon size={12} />}
            <span className="shrink-0">{task.worker}</span>
            {task.summary ? (
              <span className={`min-w-0 ${open ? "whitespace-pre-wrap" : "truncate"}`}>
                · {task.summary}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {shared ? (
        <div className="pr-3 pb-2 pl-10">
          <Attachments task={task.id} compact />
        </div>
      ) : null}
      {isLive(task) ? (
        <button
          type="button"
          aria-label={`Stop ${task.title}`}
          title={task.status === "queued" ? "Cancel" : "Stop"}
          onClick={() => onStop(task.id)}
          className="absolute top-1 right-1 grid size-9 place-items-center rounded-md text-kumo-subtle hover:bg-kumo-line hover:text-kumo-danger"
        >
          <StopCircleIcon size={16} />
        </button>
      ) : null}
    </li>
  );
}

const SLOT_LABELS: ReadonlyArray<{ slot: Slot; label: string; hint: string }> = [
  { slot: "main", label: "Main agent", hint: "Talks to you and decides." },
  { slot: "subagents", label: "Subagents", hint: "Research and parallel work." },
  { slot: "fallback", label: "When the Mac is away", hint: "Answers for Claude while VibeProxy is unreachable." }
];

const SELECT =
  "h-11 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-base text-kumo-default sm:h-8 sm:rounded-md sm:px-2 sm:text-xs";

function price(cost: { input: number; output: number } | undefined): string {
  return cost ? ` · $${cost.input}/$${cost.output}` : "";
}

function SettingsTab({
  settings,
  onSet
}: {
  settings: SettingsView | null;
  onSet: (slot: Slot, setting: SlotSetting) => void;
}) {
  if (!settings) {
    return <p className="px-3 py-6 text-center text-sm text-kumo-subtle">Loading…</p>;
  }

  const connected = settings.providers.filter((provider) => provider.connected);

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:space-y-4">
      {SLOT_LABELS.map(({ slot, label, hint }) => {
        const current = settings.slots[slot];
        const model = settings.providers
          .find((provider) => provider.id === current.provider)
          ?.models.find((each) => each.modelId === current.modelId);

        return (
          <div key={slot} className="space-y-1.5">
            <div>
              <p className="text-sm font-semibold sm:text-xs">{label}</p>
              <p className="text-xs text-kumo-subtle sm:text-[11px]">{hint}</p>
            </div>
            <select
              aria-label={`${label} model`}
              className={SELECT}
              value={`${current.provider}/${current.modelId}`}
              onChange={(event) => {
                const value = event.target.value;
                const cut = value.indexOf("/");
                onSet(slot, {
                  provider: value.slice(0, cut),
                  modelId: value.slice(cut + 1),
                  thinkingLevel: current.thinkingLevel
                });
              }}
            >
              {connected.map((provider) => (
                <optgroup key={provider.id} label={provider.name}>
                  {provider.models.map((each) => (
                    <option key={each.modelId} value={`${provider.id}/${each.modelId}`}>
                      {each.name}
                      {price(each.cost)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {model && model.levels.length > 1 ? (
              <select
                aria-label={`${label} thinking`}
                className={SELECT}
                value={current.thinkingLevel}
                onChange={(event) =>
                  onSet(slot, {
                    ...current,
                    thinkingLevel: event.target.value as SlotSetting["thinkingLevel"]
                  })
                }
              >
                {model.levels.map((level) => (
                  <option key={level} value={level}>
                    Thinking: {level}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        );
      })}
      <div className="border-t border-kumo-line pt-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
          Providers
        </p>
        <ul className="space-y-1">
          {settings.providers.map((provider) => (
            <li key={provider.id} className="flex items-center gap-2 text-sm sm:gap-1.5 sm:text-xs">
              <span
                className={`size-2 shrink-0 self-center rounded-full ${
                  provider.connected ? "bg-kumo-success" : "bg-kumo-line"
                }`}
              />
              <span className="min-w-0">
                <span className="font-medium">{provider.name}</span>{" "}
                <span className="text-kumo-subtle">
                  {provider.connected
                    ? `· ${provider.models.length} models`
                    : `· needs ${provider.needs ?? "a key"}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-kumo-subtle sm:text-[11px]">Prices are dollars per million input/output tokens.</p>
      </div>
    </div>
  );
}

function Panel({
  tasks,
  machines,
  tools,
  activeTools,
  session,
  onOpen,
  onStop,
  onStopAll,
  settings,
  onSetModel,
  onClose
}: {
  tasks: readonly TaskRow[];
  machines: readonly MachineInfo[];
  tools: readonly ToolInfo[];
  activeTools: readonly string[];
  session: string;
  onOpen: (session: string) => void;
  onStop: (task: string) => void;
  onStopAll: () => void;
  settings: SettingsView | null;
  onSetModel: (slot: Slot, setting: SlotSetting) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"tasks" | "tools" | "settings">("tasks");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);

    return () => clearInterval(timer);
  }, []);
  const live = tasks.filter(isLive).length;

  return (
    <aside
      className="fixed inset-0 z-10 flex min-h-0 flex-col bg-kumo-base lg:static lg:border-l lg:border-kumo-line"
      aria-label="Tasks"
    >
      <div className="flex h-[52px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line pr-1 pl-3 pt-[env(safe-area-inset-top)] box-content sm:h-14 sm:pr-2 sm:pl-4">
        <div className="flex rounded-lg bg-kumo-elevated p-0.5 ring ring-kumo-line" role="tablist">
          {(
            [
              ["tasks", "Tasks"],
              ["tools", "Tools"],
              ["settings", "Models"]
            ] as const
          ).map(([id, name]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`h-9 rounded-md px-3.5 text-sm font-medium transition-colors sm:h-7 sm:px-3 sm:text-xs ${
                tab === id
                  ? "bg-kumo-base text-kumo-default shadow-sm ring ring-kumo-line"
                  : "text-kumo-subtle hover:text-kumo-default"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          shape="square"
          aria-label="Close panel"
          className={ICON_BUTTON}
          onClick={onClose}
          icon={<XIcon size={18} />}
        />
      </div>
      {tab === "tasks" ? (
        <>
          {live > 0 ? (
            <div className="flex shrink-0 items-center justify-between border-b border-kumo-line px-4 py-2 text-xs text-kumo-subtle">
              <span>{live} running</span>
              <Button variant="ghost" size="sm" className="h-9 sm:h-6.5" onClick={onStopAll}>
                Stop all
              </Button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {tasks.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-kumo-subtle">
                Work the agent hands to subagents and machines shows up here.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {tasks.map((task) => (
                  <TaskItem
                    key={task.id}
                    task={task}
                    now={now}
                    selected={task.session === session && task.kind === "cloud"}
                    onOpen={onOpen}
                    onStop={onStop}
                  />
                ))}
              </ul>
            )}
          </div>
          <div className="shrink-0 border-t border-kumo-line px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Machines
            </p>
            {machines.length === 0 ? (
              <p className="text-sm text-kumo-subtle sm:text-xs">
                None yet. Run <code>runner/ky-runner.ts</code> on a computer.
              </p>
            ) : (
              <ul className="space-y-1">
                {machines.map((machine) => (
                  <li key={machine.name} className="flex items-center gap-1.5 text-sm sm:text-xs">
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        machine.online ? "bg-kumo-success" : "bg-kumo-line"
                      }`}
                    />
                    <span className="font-medium">{machine.name}</span>
                    <span className="text-kumo-subtle">
                      {machine.online
                        ? machine.active > 0
                          ? `· ${machine.active} ${machine.active === 1 ? "task" : "tasks"}`
                          : "· idle"
                        : `· offline, seen ${ago(machine.seenAt, now)}${ago(machine.seenAt, now) === "now" ? "" : " ago"}`}
                      {!machine.online && machine.active > 0 ? ` · ${machine.active} waiting` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : tab === "settings" ? (
        <SettingsTab settings={settings} onSet={onSetModel} />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          {tools.map((tool) => (
            <Surface key={tool.name} className="rounded-lg p-3 ring ring-kumo-line">
              <div className="flex items-center gap-2">
                {activeTools.includes(tool.name) ? (
                  <GearIcon size={14} className="animate-spin text-kumo-accent" />
                ) : (
                  <WrenchIcon size={14} className="text-kumo-inactive" />
                )}
                <code className="text-xs font-semibold">{tool.name}</code>
              </div>
              <p className="mt-1 text-xs text-kumo-subtle">{tool.description}</p>
            </Surface>
          ))}
        </div>
      )}
    </aside>
  );
}

function App() {
  const [session, setSession] = useState(sessionFromUrl);
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<readonly PendingImage[]>([]);
  /** Images still being read and shrunk. */
  const [reading, setReading] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(
    () => window.matchMedia("(min-width: 1024px)").matches
  );

  const endRef = useRef<HTMLDivElement>(null);

  const {
    status,
    messages,
    live,
    running,
    tools: running_,
    catalog,
    tasks,
    machines,
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
    updated
  } = usePiSession(session);

  // A new deploy is live: reload, unless that would throw away a draft.
  useEffect(() => {
    if (updated && prompt.trim() === "" && images.length === 0) location.reload();
  }, [updated, prompt, images]);

  const runningTools = running_.map((tool) => tool.name);

  const turns = useMemo(
    () => buildTurns(messages, live, running, running_),
    [messages, live, running, running_]
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, running]);

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

  const openSession = (next: string) => {
    if (next === session) return;
    history.pushState(null, "", next === MAIN_SESSION ? "/" : `/?session=${next}`);
    setSession(next);

    if (!window.matchMedia("(min-width: 1024px)").matches) setPanelOpen(false);
  };

  const main = session === MAIN_SESSION;

  /** Why the attached images can't go to this session's model, if they can't. */
  const cantSee =
    images.length > 0 && settings ? imageSupport(settings, main ? "main" : "subagents") : null;

  const subagent = main
    ? undefined
    : tasks.find((task) => task.kind === "cloud" && task.session === session);

  const mainSlot = settings?.slots.main;

  const mainModel = mainSlot
    ? (settings?.providers
        .find((provider) => provider.id === mainSlot.provider)
        ?.models.find((each) => each.modelId === mainSlot.modelId)?.name ?? mainSlot.modelId)
    : "Main agent";

  const statusLabel = connected
    ? "Live"
    : status === "connecting"
      ? "Connecting"
      : "Reconnecting";

  const working = tasks.filter((task) => task.status === "working").length;

  const empty = messages.length === 0 && !live && !running;

  return (
    <FilesContext.Provider value={files}>
      <LightboxProvider>
      <div
        className={`grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default ${
          panelOpen
            ? "lg:grid-cols-[minmax(520px,1fr)_minmax(300px,26vw)]"
            : "grid-cols-1"
        }`}
      >
        <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
          <header className="app-header shrink-0 pt-[env(safe-area-inset-top)]">
            <div className="mx-auto flex h-[52px] max-w-3xl items-center justify-between gap-2 pr-1 pl-4 sm:h-14 sm:gap-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                {main ? null : (
                  <Button
                    variant="ghost"
                    shape="square"
                    aria-label="Back to the main agent"
                    className={ICON_BUTTON}
                    onClick={() => openSession(MAIN_SESSION)}
                    icon={<ArrowLeftIcon size={18} />}
                  />
                )}
                <h1 className="app-title max-w-[40vw] shrink-0 truncate sm:max-w-none">
                  {main ? "ky" : (subagent?.worker ?? "Subagent")}
                </h1>
                <p className="app-chip min-w-0" role="status" aria-label={statusLabel} title={statusLabel}>
                  <span className="app-dot" data-connected={connected} />
                  <span className="truncate">{main ? mainModel : (subagent?.title ?? `Session ${session}`)}</span>
                </p>
              </div>
              <div className="flex shrink-0 items-center">
                {updated ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mr-1"
                    onClick={() => location.reload()}
                  >
                    <span className="sm:hidden">Reload</span>
                    <span className="hidden sm:inline">Update ready · Reload</span>
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  shape="square"
                  aria-label="Tasks"
                  aria-expanded={panelOpen}
                  className={ICON_BUTTON}
                  onClick={() => setPanelOpen((open) => !open)}
                  icon={
                    <span className="relative">
                      <ListChecksIcon size={18} />
                      {working > 0 ? (
                        <span className="absolute -top-1.5 -right-2 rounded-full bg-kumo-brand px-1 text-[9px] leading-[14px] text-white">
                          {working}
                        </span>
                      ) : null}
                    </span>
                  }
                />
                <ModeToggle />
              </div>
            </div>
          </header>
  
          <div className="chat chat-surface min-h-0 flex-1">
            <main className="thread" data-scroll>
              <div className="thread-inner">
                {empty ? (
                  <div className="py-2 sm:py-16">
                    <Empty
                      className="px-6 py-8 sm:px-10 sm:py-16"
                      icon={<BrainIcon size={32} />}
                      title={main ? "What should we get done?" : "Nothing here yet"}
                      description={
                        main
                          ? "Small things happen here. Bigger ones go to subagents and your machines, and show up under Tasks."
                          : "This subagent's conversation shows up here as it works."
                      }
                    />
                    <div
                      className={`mt-4 flex-col gap-2 sm:mt-6 sm:flex-row sm:flex-wrap sm:justify-center ${main ? "flex" : "hidden"}`}
                    >
                      {SUGGESTIONS.map((suggestion) => (
                        <Button
                          key={suggestion.label}
                          variant="secondary"
                          size="sm"
                          className="h-11 w-full justify-start px-3.5! text-sm sm:h-7 sm:w-max sm:px-2.5! sm:text-xs"
                          icon={suggestion.icon}
                          disabled={!connected}
                          onClick={() => setPrompt(suggestion.value)}
                        >
                          {suggestion.label}
                        </Button>
                      ))}
                    </div>
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
                    : main
                      ? "Message ky"
                      : "Message this subagent directly"
                }
              />
            </div>
          </div>
        </section>
  
        {panelOpen ? (
          <Panel
            tasks={tasks}
            machines={machines}
            tools={catalog}
            activeTools={runningTools}
            session={session}
            onOpen={openSession}
            onStop={stopTask}
            onStopAll={stopAll}
            settings={settings}
            onSetModel={setModel}
            onClose={() => setPanelOpen(false)}
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
