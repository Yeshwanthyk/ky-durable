import { useEffect, useState, useSyncExternalStore } from "react";
import type { BlobVariantId } from "./blob-catalog";
import { BotAvatar } from "./BotAvatar";
import { KY_AVATAR } from "../avatars/contract";
import { Icon, type IconName } from "../chat-kit/Icon";
import { type ChatKind, NAME } from "./open-chat";

/** What is set up, which decides the first-run cards and the pills. */
export type SetUp = {
  /** The server has said what is set up; until then no first-run cards show. */
  readonly known: boolean;
  /** The main chat's provider while it is the only one, like "Workers AI"; null once there is another. */
  readonly onlyProvider: string | null;
  readonly machines: boolean;
  readonly claude: boolean;
  readonly chatgpt: boolean;
  readonly executor: boolean;
  /** SOUL.md has been written past its template. */
  readonly soul: boolean;
};

/** Where a first-run card goes: a Settings section, or the SOUL interview in this chat. */
export type FirstRunTarget = "settings-providers" | "settings-subscriptions" | "settings-machines" | "settings-executor" | "soul";

type Suggestion = { icon: IconName; label: string; value: string; shown: (setUp: SetUp) => boolean };

const SUGGESTIONS: readonly Suggestion[] = [
  {
    icon: "plug",
    label: "What's connected",
    value: "What apps do I have connected in Executor, and what can you do with them?",
    shown: (setUp) => setUp.executor
  },
  {
    icon: "search",
    label: "Research in the background",
    value:
      "Start a subagent to research the best way to back up an iPhone to a NAS, and tell me when it is done.",
    shown: () => true
  },
  {
    icon: "monitor",
    label: "Use my computer",
    value:
      "On my machine, open https://news.ycombinator.com in a browser and tell me the top 3 stories.",
    shown: (setUp) => setUp.machines
  },
  {
    icon: "terminal",
    label: "Code on my machine",
    value: "On my machine, start a coding agent in my most recent project and tell me what changed there this week.",
    shown: (setUp) => setUp.machines && (setUp.claude || setUp.chatgpt)
  }
];

/** The first interview message: ky asks, then writes SOUL.md with soul_edit. */
export const SOUL_INTERVIEW =
  "Interview me so you know who I am. Ask three or four short questions, one at a time: what I do, what I care about, " +
  "how I like answers, and anything you should never do. Then write SOUL.md with soul_edit and show me what changed.";

type Card = {
  target: FirstRunTarget;
  icon: IconName;
  label: string;
  sub: string;
  /** The sub line once done: what is set up, not an invitation to do it again. */
  doneSub: string;
  done: (setUp: SetUp) => boolean;
};

const CARDS: readonly Card[] = [
  {
    target: "soul",
    icon: "fingerprint",
    label: `Tell ${NAME} who you are`,
    sub: "A short interview that writes SOUL.md",
    doneSub: "SOUL.md is written",
    done: (setUp) => setUp.soul
  },
  {
    target: "settings-providers",
    icon: "plus",
    label: "Add a key",
    sub: "OpenCode Go, OpenRouter and more",
    doneSub: "A key is added",
    done: (setUp) => setUp.onlyProvider === null
  },
  {
    target: "settings-subscriptions",
    icon: "cloud",
    label: "Connect ChatGPT for machines",
    sub: "Codex runs with it on your machines",
    doneSub: "ChatGPT is connected",
    done: (setUp) => setUp.chatgpt
  },
  {
    target: "settings-subscriptions",
    icon: "terminal",
    label: "Add Claude for machines",
    sub: "Claude Code runs with it on your machines",
    doneSub: "Claude is connected",
    done: (setUp) => setUp.claude
  },
  {
    target: "settings-machines",
    icon: "monitor",
    label: "Add a machine",
    sub: "Run tasks on your own computer",
    doneSub: "A machine is added",
    done: (setUp) => setUp.machines
  },
  {
    target: "settings-executor",
    icon: "plug",
    label: "Connect Executor",
    sub: "Your apps' tools, like email and calendar",
    doneSub: "Executor is connected",
    done: (setUp) => setUp.executor
  }
];

/** Whether the chat shows first-run cards: the main chat, once the server has said what is set up, until each is done. */
function firstRun(kind: ChatKind, setUp: SetUp): boolean {
  return kind === "main" && setUp.known && CARDS.some((card) => !card.done(setUp));
}

const COPY: Record<ChatKind, { title: string; text: string }> = {
  main: {
    title: "What should we get done?",
    text: "Small things happen here. Bigger ones go to subagents and your machines, and show up in Activity."
  },
  side: {
    title: "A side chat",
    text: "For a tangent. It shares memory with the main chat, so nothing you settle here is lost."
  },
  subagent: {
    title: "Nothing here yet",
    text: "This subagent's conversation shows up here as it works."
  }
};

/**
 * A chat this device never showed, opened with no network: it may well have messages, which only the
 * server has, so it doesn't say what an empty chat says.
 */
const OFFLINE_COPY = {
  title: "Offline",
  text: `This chat's messages show when ${NAME} is back online. What you send now goes then.`
};

const welcomeCopy = (kind: ChatKind, first: boolean, provider: string | null) =>
  first && provider !== null ? FIRST_COPY(provider) : COPY[kind];

/** What the welcome says, and whether it shows the first-run cards: neither an empty chat's words nor the cards offline. */
function useWelcome(kind: ChatKind, setUp: SetUp, connected: boolean) {
  const offline = useOffline() && !connected;
  const first = firstRun(kind, setUp) && !offline;

  return { first, copy: offline ? OFFLINE_COPY : welcomeCopy(kind, first, setUp.onlyProvider) };
}

const subscribeOnline = (changed: () => void) => {
  window.addEventListener("online", changed);
  window.addEventListener("offline", changed);

  return () => {
    window.removeEventListener("online", changed);
    window.removeEventListener("offline", changed);
  };
};

/** Whether the browser says there is no network. Not the socket: that is also closed while it first connects. */
const useOffline = () => useSyncExternalStore(subscribeOnline, () => !navigator.onLine);

const FIRST_COPY = (provider: string) => ({
  title: `You're on ${provider}.`,
  text: `${NAME} works now. Each step below adds more: your own keys, your subscriptions for machines, a machine, your apps.`
});

function Suggestions({ setUp, disabled, onPick }: { setUp: SetUp; disabled: boolean; onPick: (value: string) => void }) {
  return (
    <div className="suggestions">
      {SUGGESTIONS.flatMap((suggestion) =>
        suggestion.shown(setUp)
          ? [
              <button
                key={suggestion.label}
                type="button"
                className="pill pressable"
                disabled={disabled}
                onClick={() => onPick(suggestion.value)}
              >
                <Icon name={suggestion.icon} size={14} />
                {suggestion.label}
              </button>
            ]
          : []
      )}
    </div>
  );
}

// The main chat before ky is set up: each step opens its Settings flow, or starts the SOUL interview.
// What is left to do comes first; what is done settles below it, quiet but still a way back in.
function FirstRun({ setUp, disabled, onGo }: { setUp: SetUp; disabled: boolean; onGo: (target: FirstRunTarget) => void }) {
  const cards = CARDS.map((card) => ({ card, done: card.done(setUp) }));
  const ordered = [...cards.filter((each) => !each.done), ...cards.filter((each) => each.done)];

  return (
    <ul className="card first-run" aria-label={`Set up ${NAME}`}>
      {ordered.map(({ card, done }) => (
        <li key={card.label}>
          <button
            type="button"
            className="row pressable"
            data-done={done}
            disabled={card.target === "soul" && disabled}
            onClick={() => onGo(card.target)}
          >
            <span className="row-tile">
              <Icon name={done ? "checkCircle" : card.icon} size={15} />
            </span>
            <span className="row-text">
              <span className="row-label">{card.label}</span>
              <span className="row-sub">{done ? card.doneSub : card.sub}</span>
            </span>
            {done ? null : <Icon name="chevronRight" size={14} className="row-chevron" />}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Whether the welcome has had its entrance this page load; later empty chats appear without it. */
let entered = false;

// The entrance plays once, and only counts once it has had time to finish, so a welcome that
// flashes while a chat's history loads doesn't use it up.
function useEntrance(): boolean {
  const [enter] = useState(() => !entered);

  useEffect(() => {
    if (!enter) return;

    const timer = setTimeout(() => {
      entered = true;
    }, 600);

    return () => clearTimeout(timer);
  }, [enter]);

  return enter;
}

// An empty chat: who is here, what this chat is for, and, where ky answers, things to try.
export function Welcome({
  kind,
  speaker,
  variantId,
  running,
  connected,
  setUp,
  onPick,
  onGo,
}: {
  kind: ChatKind;
  speaker: string;
  variantId: BlobVariantId | undefined;
  running: boolean;
  connected: boolean;
  setUp: SetUp;
  onPick: (value: string) => void;
  onGo: (target: FirstRunTarget) => void;
}) {
  const { first, copy } = useWelcome(kind, setUp, connected);
  const enter = useEntrance();

  return (
    <div className="welcome" data-enter={enter}>
      <div className="welcome-avatar">
        <BotAvatar name={speaker} variantId={variantId} owner={variantId && KY_AVATAR} active={running} size={88} />
      </div>
      <h1 className="welcome-title">{copy.title}</h1>
      <p className="welcome-text">{copy.text}</p>
      {first ? <FirstRun setUp={setUp} disabled={!connected} onGo={onGo} /> : null}
      {kind === "subagent" ? null : <Suggestions setUp={setUp} disabled={!connected} onPick={onPick} />}
    </div>
  );
}
