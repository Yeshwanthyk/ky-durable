import { useEffect, useState } from "react";
import { clock, framesOf, readMedia } from "../files/media";
import { type Outgoing, outgoingImages, outgoingText } from "../outbox";
import { Icon } from "./Icon";

/** What a row says: the words, each clip, and how many images ride along; a video's frames aren't the user's images. */
function summary(item: Outgoing): string {
  const { clips, text } = readMedia(outgoingText(item.input).trim());
  const images = outgoingImages(item.input) - framesOf(clips);
  const pictures = images <= 0 ? "" : images === 1 ? "1 image" : `${images} images`;
  const named = clips.map((clip) => (clip.seconds === null ? clip.name : `${clip.name} ${clock(clip.seconds)}`));

  return [text, ...named, pictures].filter(Boolean).join(" · ");
}

/**
 * Says when the queue goes in, and while ky runs offers to steer: stop the tool calls ky waits on,
 * so the whole queue goes in now rather than after them. Asked once per queue; it clears when what
 * is queued changes, as it does once the queue goes in.
 */
function QueueHead({ queued, connected, running, onSteer }: { queued: number; connected: boolean; running: boolean; onSteer: () => void }) {
  const [steering, setSteering] = useState(false);

  useEffect(() => setSteering(false), [queued]);

  const steer = () => {
    setSteering(true);
    onSteer();
  };

  return (
    <div className="queue-head">
      <p className="queue-note">{steering ? "Steering · stopping ky's current step" : "Queued · goes in at ky's next step"}</p>
      {running ? (
        <button
          type="button"
          className="pressable queue-steer"
          title="Stop what ky is running now, so the queue goes in at once"
          disabled={steering || !connected}
          onClick={steer}
        >
          <Icon name="steer" size={13} />
          Steer now
        </button>
      ) : null}
    </div>
  );
}

/** One queued message, to take back and edit, or delete. Both wait while it is being taken, or until pi has it. */
function QueueRow({ item, connected, onEdit, onDelete }: { item: Outgoing; connected: boolean } & QueueActions) {
  const text = summary(item);
  const taking = item.back === "taking";
  const busy = taking || !connected || item.submission === null;

  return (
    <li className="queue-item" data-taking={taking}>
      <Icon name="clock" size={13} className="queue-glyph" />
      <span className="queue-text">{text}</span>
      <button
        type="button"
        className="icon-button pressable queue-action"
        aria-label={`Edit queued message: ${text}`}
        title="Edit"
        disabled={busy}
        onClick={() => void onEdit(item)}
      >
        <Icon name="pencil" size={14} />
      </button>
      <button
        type="button"
        className="icon-button pressable queue-action"
        aria-label={`Delete queued message: ${text}`}
        title="Delete"
        disabled={busy}
        onClick={() => void onDelete(item)}
      >
        <Icon name="x" size={14} />
      </button>
    </li>
  );
}

type QueueActions = {
  onEdit: (item: Outgoing) => Promise<void>;
  onDelete: (item: Outgoing) => Promise<void>;
};

/**
 * Messages sent while ky works, waiting to go in at its next step. Each can be
 * taken back to edit in the composer, or deleted. One pi places first goes in
 * anyway, and leaves the queue as it shows in the thread.
 */
export function QueueTray({
  items,
  more,
  connected,
  running,
  onSteer,
  onEdit,
  onDelete,
}: {
  items: readonly Outgoing[];
  /** Queued from elsewhere, like another device, so this page has no words for them. */
  more: number;
  connected: boolean;
  running: boolean;
  onSteer: () => void;
} & QueueActions) {
  if (items.length === 0 && more === 0) return null;

  return (
    <section className="queue" aria-label="Queued messages">
      <QueueHead queued={items.length + more} connected={connected} running={running} onSteer={onSteer} />
      <ul className="queue-list">
        {items.map((item) => (
          <QueueRow key={item.operationId} item={item} connected={connected} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </ul>
      {more > 0 ? <p className="queue-more">{more === 1 ? "1 more" : `${more} more`} queued from elsewhere</p> : null}
    </section>
  );
}
