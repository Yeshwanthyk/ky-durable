import { memo, useEffect, useRef } from "react";
import type { BriefCardLine, BriefView } from "../protocol";
import { Icon } from "./Icon";
import { useNow } from "./use-now";

/** What the card's taps do: the server records each as the line's outcome. */
type BriefActions = {
  /** The card was on the user's screen with these lines. */
  readonly onSeen: (keys: readonly string[]) => void;
  readonly onPin: (key: string) => void;
  readonly onDismiss: (key: string) => void;
  /** Dismiss all: these lines, the unpinned ones the card shows. */
  readonly onClear: (keys: readonly string[]) => void;
};

type Props = {
  readonly brief: BriefView | null;
  readonly actions: BriefActions;
  /** Why the last tap did not take, if it did not. */
  readonly problem: string | null;
  /** Put a line's ask in the composer, ready to send; sending it is what counts as acting on the line. */
  readonly onPick: (prompt: string, key: string) => void;
};

/** One line: its text and where it came from, the chip that puts its ask in the composer, and pin and dismiss. */
function BriefLine({ line, actions, onPick }: { readonly line: BriefCardLine } & Pick<Props, "actions" | "onPick">) {
  const { chip } = line;

  return (
    <li className="brief-line" data-pinned={line.pinned}>
      <div className="brief-body">
        <p className="brief-text">{line.text}</p>
        <p className="brief-source">from: {line.source}</p>
        {chip === null ? null : (
          <button type="button" className="pressable brief-chip" title={chip} onClick={() => onPick(chip, line.key)}>
            {chip}
          </button>
        )}
      </div>
      {line.pinned ? (
        <span className="brief-pinned" role="img" aria-label={`Pinned: ${line.text}`} title="Pinned: the reminder is kept">
          <Icon name="pin" size={13} />
        </span>
      ) : (
        <button type="button" className="icon-button pressable brief-action" aria-label={`Pin: ${line.text}`} title="Pin — keeps the reminder" onClick={() => actions.onPin(line.key)}>
          <Icon name="pin" size={14} />
        </button>
      )}
      <button type="button" className="icon-button pressable brief-action" aria-label={`Dismiss: ${line.text}`} title="Dismiss" onClick={() => actions.onDismiss(line.key)}>
        <Icon name="x" size={14} />
      </button>
    </li>
  );
}

/**
 * Report the lines the card shows as seen, once each, when the page is on screen: at once if it is visible,
 * else the next time it becomes so. A tab opened in the background has shown nothing yet.
 */
function useSeen(lines: readonly BriefCardLine[], onSeen: (keys: readonly string[]) => void) {
  const reported = useRef(new Set<string>());
  const keys = lines.map((line) => line.key).join(" ");

  useEffect(() => {
    const fresh = keys.split(" ").filter((key) => key !== "" && !reported.current.has(key));

    if (fresh.length === 0) return undefined;

    const report = () => {
      if (document.visibilityState !== "visible") return false;

      for (const key of fresh) reported.current.add(key);
      onSeen(fresh);

      return true;
    };

    if (report()) return undefined;

    const onVisible = () => {
      if (report()) document.removeEventListener("visibilitychange", onVisible);
    };

    document.addEventListener("visibilitychange", onVisible);

    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [keys, onSeen]);
}

const NO_LINES: readonly BriefCardLine[] = [];

/** The card's head: its title, and Dismiss all for the unpinned lines, when there are any. */
function BriefHead({ unpinned, onClear }: { readonly unpinned: readonly string[]; readonly onClear: (keys: readonly string[]) => void }) {
  return (
    <header className="brief-head">
      <p className="brief-title">Today</p>
      {unpinned.length === 0 ? null : (
        <button type="button" className="pressable brief-close" title="Dismiss every line but the pinned ones" onClick={() => onClear(unpinned)}>
          Dismiss all
        </button>
      )}
    </header>
  );
}

/** Why the last tap did not take, under the lines. */
function BriefProblem({ problem }: { readonly problem: string | null }) {
  return problem === null ? null : (
    <p className="brief-problem" role="alert">
      {problem}
    </p>
  );
}

/**
 * Today's brief, above the chat: the few lines ky had ready for the user's day, each saying where it came from.
 * Not a chat message, so it starts no run; a chip only fills the composer. It comes back on each visit until
 * every line is handled, and goes at the user's midnight.
 */
export const BriefCard = memo(function BriefCard({ brief, actions, problem, onPick }: Props) {
  const now = useNow();
  const live = brief !== null && now < brief.expires_at ? brief.lines : NO_LINES;

  useSeen(live, actions.onSeen);

  if (live.length === 0) return null;

  return (
    <section className="brief" aria-label="Today's brief">
      <BriefHead unpinned={live.filter((line) => !line.pinned).map((line) => line.key)} onClear={actions.onClear} />
      <ul className="brief-lines">
        {live.map((line) => (
          <BriefLine key={line.key} line={line} actions={actions} onPick={onPick} />
        ))}
      </ul>
      <BriefProblem problem={problem} />
    </section>
  );
});
