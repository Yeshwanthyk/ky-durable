import type { BlobVariantId } from "./blob-catalog";
import { BotAvatar } from "./BotAvatar";
import { Icon, type IconName } from "./Icon";
import type { ChatKind } from "./open-chat";

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

function Suggestions({ disabled, onPick }: { disabled: boolean; onPick: (value: string) => void }) {
  return (
    <div className="suggestions">
      {SUGGESTIONS.map((suggestion) => (
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
      ))}
    </div>
  );
}

// An empty chat: who is here, what this chat is for, and, where ky answers, things to try.
export function Welcome({
  kind,
  speaker,
  variantId,
  running,
  connected,
  onPick,
}: {
  kind: ChatKind;
  speaker: string;
  variantId: BlobVariantId | undefined;
  running: boolean;
  connected: boolean;
  onPick: (value: string) => void;
}) {
  return (
    <div className="welcome">
      <BotAvatar name={speaker} variantId={variantId} active={running} size={88} />
      <h1 className="welcome-title">{COPY[kind].title}</h1>
      <p className="welcome-text">{COPY[kind].text}</p>
      {kind === "subagent" ? null : <Suggestions disabled={!connected} onPick={onPick} />}
    </div>
  );
}
