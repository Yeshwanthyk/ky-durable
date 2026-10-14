import { useState } from "react";
import { type Outgoing, outgoingImages, outgoingText } from "../outbox";
import { Icon } from "./Icon";

/** What a row says: the words, and how many images ride along. */
function summary(item: Outgoing): string {
  const text = outgoingText(item.input).trim();
  const images = outgoingImages(item.input);
  const pictures = images === 0 ? "" : images === 1 ? "1 image" : `${images} images`;

  return [text, pictures].filter(Boolean).join(" · ");
}

/**
 * Messages sent while ky works, waiting to go in at its next step. Each can be
 * taken back to edit in the composer, or deleted. One pi places first goes in
 * anyway, and leaves the queue as it shows in the thread.
 */
export function QueueTray({
  items,
  more,
  connected,
  onEdit,
  onDelete,
}: {
  items: readonly Outgoing[];
  /** Queued from elsewhere, like another device, so this page has no words for them. */
  more: number;
  connected: boolean;
  onEdit: (item: Outgoing) => Promise<void>;
  onDelete: (item: Outgoing) => Promise<void>;
}) {
  const [taking, setTaking] = useState<ReadonlySet<string>>(new Set());

  if (items.length === 0 && more === 0) return null;

  const take = (item: Outgoing, action: (item: Outgoing) => Promise<void>) => {
    setTaking((current) => new Set(current).add(item.operationId));
    void action(item).finally(() =>
      setTaking((current) => {
        const next = new Set(current);
        next.delete(item.operationId);

        return next;
      })
    );
  };

  return (
    <section className="queue" aria-label="Queued messages">
      <p className="queue-head">Queued · goes in at ky's next step</p>
      <ul className="queue-list">
        {items.map((item) => {
          const text = summary(item);
          const busy = taking.has(item.operationId) || !connected || item.submission === null;

          return (
            <li key={item.operationId} className="queue-item" data-taking={taking.has(item.operationId)}>
              <Icon name="clock" size={13} className="queue-glyph" />
              <span className="queue-text">{text}</span>
              <button
                type="button"
                className="icon-button pressable queue-action"
                aria-label={`Edit queued message: ${text}`}
                title="Edit"
                disabled={busy}
                onClick={() => take(item, onEdit)}
              >
                <Icon name="pencil" size={14} />
              </button>
              <button
                type="button"
                className="icon-button pressable queue-action"
                aria-label={`Delete queued message: ${text}`}
                title="Delete"
                disabled={busy}
                onClick={() => take(item, onDelete)}
              >
                <Icon name="x" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 ? <p className="queue-more">{more === 1 ? "1 more" : `${more} more`} queued from elsewhere</p> : null}
    </section>
  );
}
