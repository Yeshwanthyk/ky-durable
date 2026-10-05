import { useContext, useState } from "react";
import type { MachineInfo, SettingsView, Slot, SlotSetting, TaskRow, ToolInfo } from "../protocol";
import { Attachments, FilesContext, isMedia } from "./Attachments";
import { Changes } from "./Changes";
import type { BlobVariantId } from "./blob-catalog";
import { BotAvatar } from "./BotAvatar";
import { Icon, Spinner, type IconName } from "./Icon";
import { ago, clock, day } from "./time";

export type Theme = "light" | "dark";

const isLive = (task: TaskRow) => task.status === "queued" || task.status === "working";

const statusIcon: Record<TaskRow["status"], IconName> = {
  queued: "circle",
  working: "circle",
  done: "checkCircle",
  failed: "alert",
  stopped: "stop",
};

export type PanelTab = "activity" | "settings";

// Who ky is and how it is doing, then everything it is doing and has done, then its settings.
export function Panel({
  name,
  variantId,
  active,
  status,
  model,
  tasks,
  machines,
  running,
  catalog,
  session,
  now,
  settings,
  theme,
  onTheme,
  onSetModel,
  onOpen,
  onStop,
  onStopAll,
  onClose,
  tab,
  onTab,
}: {
  name: string;
  variantId: BlobVariantId;
  active: boolean;
  status: { label: string; connected: boolean };
  model: string;
  tasks: readonly TaskRow[];
  machines: readonly MachineInfo[];
  /** Tools running in the open chat right now. */
  running: readonly string[];
  catalog: readonly ToolInfo[];
  session: string;
  now: number;
  settings: SettingsView | null;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onSetModel: (slot: Slot, setting: SlotSetting) => void;
  onOpen: (session: string) => void;
  onStop: (task: string) => void;
  onStopAll: () => void;
  onClose: () => void;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
}) {
  return (
    <aside className="panel" aria-label="Activity and settings">
      <button type="button" className="icon-button pressable panel-close" aria-label="Close panel" onClick={onClose}>
        <Icon name="x" size={16} />
      </button>
      <header className="profile">
        <BotAvatar name={name} variantId={variantId} active={active} size={72} />
        <h2 className="profile-name">{name}</h2>
        <p className="profile-status" role="status">
          <span className="status-dot" data-connected={status.connected} />
          {status.label}
          <span className="quiet"> · {model}</span>
        </p>
      </header>
      <div className="segmented" role="tablist">
        {(
          [
            ["activity", "Activity"],
            ["settings", "Settings"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className="pressable"
            onClick={() => onTab(id)}
          >
            {id === "settings" ? <Icon name="gear" size={14} className="gear" /> : null}
            {label}
          </button>
        ))}
      </div>
      {tab === "activity" ? (
        <Activity
          tasks={tasks}
          machines={machines}
          running={running}
          session={session}
          now={now}
          onOpen={onOpen}
          onStop={onStop}
          onStopAll={onStopAll}
        />
      ) : (
        <Settings settings={settings} catalog={catalog} theme={theme} onTheme={onTheme} onSet={onSetModel} />
      )}
    </aside>
  );
}

function Activity({
  tasks,
  machines,
  running,
  session,
  now,
  onOpen,
  onStop,
  onStopAll,
}: {
  tasks: readonly TaskRow[];
  machines: readonly MachineInfo[];
  running: readonly string[];
  session: string;
  now: number;
  onOpen: (session: string) => void;
  onStop: (task: string) => void;
  onStopAll: () => void;
}) {
  const live = tasks.filter(isLive);
  const groups = new Map<string, TaskRow[]>();

  for (const task of tasks) {
    if (isLive(task)) continue;
    const label = day(task.updated_at, now);
    groups.set(label, [...(groups.get(label) ?? []), task]);
  }

  return (
    <div className="panel-body" data-scroll>
      {live.length > 0 || running.length > 0 ? (
        <section className="feed-group">
          <h3 className="feed-head">
            Now
            {live.length > 1 ? (
              <button type="button" className="feed-action pressable" onClick={onStopAll}>
                Stop all
              </button>
            ) : null}
          </h3>
          <ul className="feed">
            {running.map((tool, index) => (
              <li key={`${tool}-${index}`} className="feed-item">
                <span className="feed-tile" data-tone="working">
                  <Spinner size={14} />
                </span>
                <span className="feed-text">
                  <span className="feed-title">Using {tool}</span>
                  <span className="feed-meta">This chat</span>
                </span>
              </li>
            ))}
            {live.map((task) => (
              <TaskItem key={task.id} task={task} session={session} onOpen={onOpen} onStop={onStop} />
            ))}
          </ul>
        </section>
      ) : null}
      {[...groups].map(([label, rows]) => (
        <section key={label} className="feed-group">
          <h3 className="feed-head">{label}</h3>
          <ul className="feed">
            {rows.map((task) => (
              <TaskItem key={task.id} task={task} session={session} onOpen={onOpen} onStop={onStop} />
            ))}
          </ul>
        </section>
      ))}
      {tasks.length === 0 && running.length === 0 ? (
        <p className="panel-empty">Work ky hands to subagents and your machines shows up here.</p>
      ) : null}
      <section className="feed-group machines">
        <h3 className="feed-head">Machines</h3>
        {machines.length === 0 ? (
          <p className="panel-note">
            None yet. Run <code>runner/ky-runner.ts</code> on a computer.
          </p>
        ) : (
          <ul className="machine-list">
            {machines.map((machine) => (
              <li key={machine.name}>
                <span className="status-dot" data-connected={machine.online} />
                <span className="machine-name">{machine.name}</span>
                <span className="quiet">
                  {machine.online
                    ? machine.active > 0
                      ? `${machine.active} ${machine.active === 1 ? "task" : "tasks"}`
                      : "idle"
                    : `offline, seen ${ago(machine.seenAt, now)}${ago(machine.seenAt, now) === "now" ? "" : " ago"}`}
                  {!machine.online && machine.active > 0 ? ` · ${machine.active} waiting` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TaskItem({
  task,
  session,
  onOpen,
  onStop,
}: {
  task: TaskRow;
  session: string;
  onOpen: (session: string) => void;
  onStop: (task: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const opens = task.kind === "cloud" && task.session !== null;
  const shared = useContext(FilesContext).some((file) => file.task === task.id && isMedia(file));
  const live = isLive(task);

  return (
    <li className="feed-item" data-status={task.status} aria-current={opens && task.session === session ? "page" : undefined}>
      <button
        type="button"
        className="feed-button"
        aria-expanded={opens ? undefined : open}
        onClick={() => (opens ? onOpen(task.session!) : setOpen((value) => !value))}
      >
        <span className="feed-tile" data-tone={task.status}>
          {task.status === "working" ? <Spinner size={16} /> : <Icon name={statusIcon[task.status]} size={18} />}
        </span>
        <span className="feed-text">
          <span className="feed-title">{task.title}</span>
          {task.summary ? (
            <span className="feed-summary" data-open={open}>
              {task.summary}
            </span>
          ) : null}
          <span className="feed-meta">
            {task.kind === "cloud" ? (
              <BotAvatar name={task.worker} still size={14} />
            ) : (
              <Icon name="monitor" size={12} />
            )}
            <span>{task.worker}</span>
            {live ? null : <span className="tabular">· {clock(task.updated_at)}</span>}
          </span>
        </span>
      </button>
      {shared ? (
        <div className="feed-files">
          <Attachments task={task.id} compact />
        </div>
      ) : null}
      {task.kind === "machine" ? (
        <div className="feed-changes">
          <Changes task={task.id} />
        </div>
      ) : null}
      {live ? (
        <button
          type="button"
          className="icon-button pressable feed-stop"
          aria-label={`Stop ${task.title}`}
          title={task.status === "queued" ? "Cancel" : "Stop"}
          onClick={() => onStop(task.id)}
        >
          <Icon name="stop" size={10} />
        </button>
      ) : null}
    </li>
  );
}

const SLOTS: ReadonlyArray<{ slot: Slot; label: string; hint: string }> = [
  { slot: "main", label: "Main agent", hint: "Talks to you, in every chat" },
  { slot: "subagents", label: "Subagents", hint: "Research and parallel work" },
  { slot: "fallback", label: "Fallback", hint: "When the Mac is away" },
  { slot: "titles", label: "Titles", hint: "Names chats and tasks. Small and quick is best" },
];

const LEVELS: Partial<Record<SlotSetting["thinkingLevel"], string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const SLOT_ICONS: Record<Slot, IconName> = { main: "chat", subagents: "nodes", fallback: "cloud", titles: "pencil" };

// A role's row shows what it runs; open, it lists the models to pick from and how hard to think.
function ModelRow({
  slot,
  label,
  hint,
  settings,
  open,
  onToggle,
  onSet,
}: {
  slot: Slot;
  label: string;
  hint: string;
  settings: SettingsView;
  open: boolean;
  onToggle: () => void;
  onSet: (slot: Slot, setting: SlotSetting) => void;
}) {
  const current = settings.slots[slot];
  const connected = settings.providers.filter((provider) => provider.connected);

  const model = settings.providers
    .find((provider) => provider.id === current.provider)
    ?.models.find((each) => each.modelId === current.modelId);

  const level = model && model.levels.length > 1 ? (LEVELS[current.thinkingLevel] ?? current.thinkingLevel) : null;

  return (
    <li className="model-row" data-open={open}>
      <button type="button" className="row disclosure" aria-expanded={open} onClick={onToggle}>
        <span className="row-tile">
          <Icon name={SLOT_ICONS[slot]} size={15} />
        </span>
        <span className="row-text">
          <span className="row-label">{label}</span>
          <span className="row-sub row-current">
            {model?.name ?? current.modelId}
            {level ? ` · ${level}` : null}
          </span>
        </span>
        <Icon name="chevronRight" size={14} className="row-chevron chevron" />
      </button>
      <div className="expand" inert={!open}>
        <div className="expand-inner">
          <p className="choices-note">{hint}</p>
          <ul className="choices" role="radiogroup" aria-label={`${label} model`}>
            {connected.flatMap((provider) =>
              provider.models.map((each) => {
                const chosen = provider.id === current.provider && each.modelId === current.modelId;

                return (
                  <li key={`${provider.id}/${each.modelId}`}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={chosen}
                      className="choice"
                      onClick={() =>
                        onSet(slot, {
                          provider: provider.id,
                          modelId: each.modelId,
                          thinkingLevel: each.levels.includes(current.thinkingLevel)
                            ? current.thinkingLevel
                            : (each.levels[0] ?? current.thinkingLevel),
                        })
                      }
                    >
                      <span className="choice-text">
                        <span>{each.name}</span>
                        <span className="row-sub">
                          {provider.name}
                          {each.cost ? ` · $${each.cost.input} / $${each.cost.output} per M` : ""}
                        </span>
                      </span>
                      <Icon name="check" size={14} className="choice-check" />
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {model && model.levels.length > 1 ? (
            <div className="thinking">
              <span className="row-sub">Thinking</span>
              <div className="segmented small" role="radiogroup" aria-label={`${label} thinking`}>
                {model.levels.map((each) => (
                  <button
                    key={each}
                    type="button"
                    role="radio"
                    aria-checked={current.thinkingLevel === each}
                    className="pressable"
                    onClick={() => onSet(slot, { ...current, thinkingLevel: each })}
                  >
                    {LEVELS[each] ?? each}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Settings({
  settings,
  catalog,
  theme,
  onTheme,
  onSet,
}: {
  settings: SettingsView | null;
  catalog: readonly ToolInfo[];
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onSet: (slot: Slot, setting: SlotSetting) => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [openSlot, setOpenSlot] = useState<Slot | null>(null);

  return (
    <div className="panel-body settings" data-scroll>
      <section className="group">
        <h3 className="group-label">Appearance</h3>
        <div className="card">
          <div className="row">
            <span className="row-tile">
              <Icon name={theme === "dark" ? "moon" : "sun"} size={15} />
            </span>
            <span className="row-label">Theme</span>
            <div className="segmented small" role="radiogroup" aria-label="Theme">
              {(["light", "dark"] as const).map((each) => (
                <button
                  key={each}
                  type="button"
                  role="radio"
                  aria-checked={theme === each}
                  className="pressable"
                  onClick={() => onTheme(each)}
                >
                  {each === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section className="group">
        <h3 className="group-label">Models</h3>
        {settings === null ? (
          <p className="panel-note">Loading models…</p>
        ) : (
          <ul className="card">
            {SLOTS.map(({ slot, label, hint }) => (
              <ModelRow
                key={slot}
                slot={slot}
                label={label}
                hint={hint}
                settings={settings}
                open={openSlot === slot}
                onToggle={() => setOpenSlot((value) => (value === slot ? null : slot))}
                onSet={onSet}
              />
            ))}
          </ul>
        )}
      </section>
      {settings ? (
        <section className="group">
          <h3 className="group-label">Providers</h3>
          <ul className="card">
            {settings.providers.map((provider) => (
              <li key={provider.id} className="row">
                <span className="row-tile">
                  <Icon name="plug" size={15} />
                </span>
                <span className="row-text">
                  <span className="row-label">{provider.name}</span>
                  {provider.connected ? null : <span className="row-sub">Needs {provider.needs ?? "a key"}</span>}
                </span>
                <span className="row-value tabular">
                  {provider.connected
                    ? `${provider.models.length} ${provider.models.length === 1 ? "model" : "models"}`
                    : "Off"}
                </span>
                <span className="status-dot" data-connected={provider.connected} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="group">
        <h3 className="group-label">Tools</h3>
        <div className="card">
          <button
            type="button"
            className="row disclosure"
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen((value) => !value)}
          >
            <span className="row-tile">
              <Icon name="terminal" size={15} />
            </span>
            <span className="row-label">What ky can use</span>
            <span className="row-value tabular">{catalog.length}</span>
            <Icon name="chevronRight" size={14} className="row-chevron chevron" />
          </button>
          {toolsOpen ? (
            <ul className="tool-list">
              {catalog.map((tool) => (
                <li key={tool.name}>
                  <code>{tool.name}</code>
                  <p>{tool.description}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    </div>
  );
}
