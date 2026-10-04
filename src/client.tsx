import {
  Badge,
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
import { Attachments, FilesContext } from "./ui/Attachments";
import { Composer } from "./ui/Composer";
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
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

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
        className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-kumo-elevated ${
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
          className="absolute top-2 right-2 rounded-md p-1 text-kumo-subtle hover:bg-kumo-line hover:text-kumo-danger"
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
  "w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-xs text-kumo-default";

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
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      {SLOT_LABELS.map(({ slot, label, hint }) => {
        const current = settings.slots[slot];
        const model = settings.providers
          .find((provider) => provider.id === current.provider)
          ?.models.find((each) => each.modelId === current.modelId);

        return (
          <div key={slot} className="space-y-1.5">
            <div>
              <p className="text-xs font-semibold">{label}</p>
              <p className="text-[11px] text-kumo-subtle">{hint}</p>
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
            <li key={provider.id} className="flex items-center gap-1.5 text-xs">
              <span
                className={`size-2 shrink-0 rounded-full ${
                  provider.connected ? "bg-kumo-success" : "bg-kumo-line"
                }`}
              />
              <span className="font-medium">{provider.name}</span>
              <span className="text-kumo-subtle">
                {provider.connected
                  ? `· ${provider.models.length} models`
                  : `· needs ${provider.needs ?? "a key"}`}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-kumo-subtle">Prices are dollars per million input/output tokens.</p>
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
      <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
        <div className="flex gap-1">
          <Button
            variant={tab === "tasks" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTab("tasks")}
          >
            Tasks
          </Button>
          <Button
            variant={tab === "tools" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTab("tools")}
          >
            Tools
          </Button>
          <Button
            variant={tab === "settings" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTab("settings")}
          >
            Models
          </Button>
        </div>
        <Button
          variant="ghost"
          shape="square"
          aria-label="Close panel"
          onClick={onClose}
          icon={<XIcon size={16} />}
        />
      </div>
      {tab === "tasks" ? (
        <>
          {live > 0 ? (
            <div className="flex shrink-0 items-center justify-between border-b border-kumo-line px-4 py-2 text-xs text-kumo-subtle">
              <span>{live} running</span>
              <Button variant="ghost" size="sm" onClick={onStopAll}>
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
          <div className="shrink-0 border-t border-kumo-line px-4 py-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Machines
            </p>
            {machines.length === 0 ? (
              <p className="text-xs text-kumo-subtle">
                None yet. Run <code>runner/ky-runner.ts</code> on a computer.
              </p>
            ) : (
              <ul className="space-y-1">
                {machines.map((machine) => (
                  <li key={machine.name} className="flex items-center gap-1.5 text-xs">
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
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
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
    if (updated && prompt.trim() === "") location.reload();
  }, [updated, prompt]);

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

    if (!text || !connected) return;
    setPrompt("");
    submitPrompt(text, whenBusy);
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

  const subagent = main
    ? undefined
    : tasks.find((task) => task.kind === "cloud" && task.session === session);

  const working = tasks.filter((task) => task.status === "working").length;

  const empty = messages.length === 0 && !live && !running;

  return (
    <FilesContext.Provider value={files}>
      <div
        className={`grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default ${
          panelOpen
            ? "lg:grid-cols-[minmax(520px,1fr)_minmax(300px,26vw)]"
            : "grid-cols-1"
        }`}
      >
        <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
          <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
            <div className="mx-auto flex h-[68px] max-w-3xl items-center justify-between gap-3 px-5">
              <div className="flex min-w-0 items-center gap-3">
                {main ? (
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-kumo-brand text-white">
                    <BrainIcon size={20} weight="bold" />
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    shape="square"
                    aria-label="Back to the main agent"
                    onClick={() => openSession(MAIN_SESSION)}
                    icon={<ArrowLeftIcon size={18} />}
                  />
                )}
                <div className="min-w-0">
                  <h1 className="truncate text-base font-semibold">
                    {main ? "ky" : (subagent?.worker ?? "Subagent")}
                  </h1>
                  <p className="truncate text-xs text-kumo-subtle">
                    {main ? "Main agent" : (subagent?.title ?? `Session ${session}`)}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {updated ? (
                  <Button variant="secondary" size="sm" onClick={() => location.reload()}>
                    Update ready · Reload
                  </Button>
                ) : null}
                <Badge variant={connected ? "success" : "secondary"}>
                  {connected
                    ? "Live"
                    : status === "connecting"
                      ? "Connecting"
                      : "Reconnecting"}
                </Badge>
                <Button
                  variant="ghost"
                  shape="square"
                  aria-label="Tasks"
                  aria-expanded={panelOpen}
                  onClick={() => setPanelOpen((open) => !open)}
                  icon={
                    <span className="relative">
                      <ListChecksIcon size={16} />
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
                  <div className="py-10 sm:py-16">
                    <Empty
                      icon={<BrainIcon size={32} />}
                      title={main ? "What should we get done?" : "Nothing here yet"}
                      description={
                        main
                          ? "Small things happen here. Bigger ones go to subagents and your machines, and show up under Tasks."
                          : "This subagent's conversation shows up here as it works."
                      }
                    />
                    <div className={`mt-6 flex-wrap justify-center gap-2 ${main ? "flex" : "hidden"}`}>
                      {SUGGESTIONS.map((suggestion) => (
                        <Button
                          key={suggestion.label}
                          variant="secondary"
                          size="sm"
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
              <Composer
                value={prompt}
                onChange={setPrompt}
                onSubmit={() => submit(running ? "steer" : "followUp")}
                onStop={abort}
                working={running}
                disabled={!connected}
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
    </FilesContext.Provider>
  );
}

const root = document.getElementById("root");

if (!root) throw new Error("Missing #root element");

createRoot(root).render(<App />);
