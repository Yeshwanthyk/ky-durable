import type { ChatRow, TaskRow } from "../protocol";
import type { Command } from "./CommandPalette";
import type { PanelTab, Theme } from "./Panel";
import { MAIN_SESSION } from "./open-chat";
import { ago } from "./time";

/** What the palette offers, and what its commands do. */
export type CommandSources = {
  readonly session: string;
  readonly main: boolean;
  readonly chats: readonly ChatRow[];
  readonly tasks: readonly TaskRow[];
  readonly now: number;
  readonly theme: Theme;
  /** Tasks working right now. */
  readonly working: number;
  readonly openSession: (session: string) => void;
  readonly startChat: () => void;
  readonly openPanel: (tab: PanelTab) => void;
  readonly setTheme: (theme: Theme) => void;
  readonly stopAll: () => void;
};

function chatCommands(sources: CommandSources): Command[] {
  const { session, main, chats, now, openSession, startChat } = sources;

  return [
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
    }))
  ];
}

function themeCommand(theme: Theme, setTheme: (theme: Theme) => void): Command {
  const dark = theme === "dark";

  return {
    id: "theme",
    group: "ky",
    label: dark ? "Light appearance" : "Dark appearance",
    icon: dark ? "sun" : "moon",
    keywords: "theme mode toggle",
    run: () => setTheme(dark ? "light" : "dark")
  };
}

function stopAllCommands(working: number, stopAll: () => void): Command[] {
  if (working === 0) return [];

  return [
    {
      id: "stop-all",
      group: "ky",
      label: `Stop ${working} working`,
      icon: "stop",
      keywords: "cancel tasks",
      run: stopAll
    }
  ];
}

function kyCommands(sources: CommandSources): Command[] {
  const { openPanel, theme, setTheme, working, stopAll } = sources;

  return [
    {
      id: "activity",
      group: "ky",
      label: "Activity",
      icon: "list",
      keywords: "tasks tools subagents feed",
      run: () => openPanel("activity")
    },
    {
      id: "skills",
      group: "ky",
      label: "Skills",
      icon: "list",
      keywords: "procedures how-to library",
      run: () => openPanel("skills")
    },
    {
      id: "soul",
      group: "ky",
      label: "Soul",
      icon: "fingerprint",
      keywords: "persona voice personality soul.md",
      run: () => openPanel("soul")
    },
    {
      id: "settings",
      group: "ky",
      label: "Settings",
      icon: "settings",
      keywords: "models providers preferences",
      run: () => openPanel("settings")
    },
    themeCommand(theme, setTheme),
    ...stopAllCommands(working, stopAll)
  ];
}

function subagentCommands(tasks: readonly TaskRow[], openSession: (session: string) => void): Command[] {
  return tasks
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
    }));
}

// ⌘K's list: the chats, then ky's own panels and switches, then the subagents.
export function paletteCommands(sources: CommandSources): Command[] {
  return [...chatCommands(sources), ...kyCommands(sources), ...subagentCommands(sources.tasks, sources.openSession)];
}
