import { memo } from "react";
import type { BriefCardLine, BriefView } from "../protocol";
import { Icon } from "./Icon";
import { useNow } from "./use-now";

/** What the card's taps do: the server records each as the line's outcome. */
type BriefActions = {
  readonly onAct: (key: string) => void;
  readonly onPin: (key: string) => void;
  readonly onDismiss: (key: string) => void;
  readonly onDismissAll: () => void;
};

type Props = {
  readonly brief: BriefView | null;
  readonly actions: BriefActions;
  /** Put an ask in the composer, ready to send. */
  readonly onPick: (prompt: string) => void;
};

/** One line: its text, the chip that puts its ask in the composer, and pin and dismiss. */
function BriefLine({ line, actions, onPick }: { readonly line: BriefCardLine } & Omit<Props, "brief">) {
  const pick = () => {
    if (line.chip === null) return;
    onPick(line.chip);
    actions.onAct(line.key);
  };

  return (
    <li className="brief-line" data-pinned={line.pinned}>
      <div className="brief-body">
        <p className="brief-text">{line.text}</p>
        {line.chip === null ? null : (
          <button type="button" className="pressable brief-chip" title="Put this in the composer" onClick={pick}>
            {line.chip}
          </button>
        )}
      </div>
      {line.pinned ? (
        <span className="brief-pinned" title="Pinned for today">
          <Icon name="pin" size={13} />
        </span>
      ) : (
        <button type="button" className="icon-button pressable brief-action" aria-label={`Pin: ${line.text}`} title="Pin for today" onClick={() => actions.onPin(line.key)}>
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
 * Today's brief, above the chat: the few lines ky had ready when the user first came back today. Not a chat
 * message, so it starts no run; a chip only fills the composer. It goes at the user's midnight, when every line
 * is handled, or when the user dismisses it.
 */
export const BriefCard = memo(function BriefCard({ brief, actions, onPick }: Props) {
  const now = useNow();

  if (brief === null || brief.lines.length === 0 || now >= brief.expires_at) return null;

  return (
    <section className="brief" aria-label="Today's brief">
      <header className="brief-head">
        <p className="brief-title">Today</p>
        <button type="button" className="pressable brief-close" title="Dismiss the brief" onClick={actions.onDismissAll}>
          Dismiss all
        </button>
      </header>
      <ul className="brief-lines">
        {brief.lines.map((line) => (
          <BriefLine key={line.key} line={line} actions={actions} onPick={onPick} />
        ))}
      </ul>
    </section>
  );
});
