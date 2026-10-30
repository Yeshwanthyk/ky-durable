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
          title={connected ? "Stop what ky is running now, so the queue goes in at once" : "Offline · steer once ky reconnects"}
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

/**
 * One queued message, to take back and edit, or delete. Both wait while it is being taken, or until pi has it.
 * One written offline (`waiting`) ky never had, so the page takes it back itself, connected or not.
 */
function QueueRow({ item, connected, waiting = false, onEdit, onDelete }: { item: Outgoing; connected: boolean; waiting?: boolean } & QueueActions) {
  const text = summary(item);
  const taking = item.back === "taking";
  const busy = taking || (!waiting && (!connected || item.submission === null));
  const kind = waiting ? "waiting" : "queued";

  return (
    <li className="queue-item" data-taking={taking}>
      <Icon name={waiting ? "cloud" : "clock"} size={13} className="queue-glyph" />
      <span className="queue-text">{text}</span>
      <button
        type="button"
        className="icon-button pressable queue-action"
        aria-label={`Edit ${kind} message: ${text}`}
        title="Edit"
        disabled={busy}
        onClick={() => void onEdit(item)}
      >
        <Icon name="pencil" size={14} />
      </button>
      <button
        type="button"
        className="icon-button pressable queue-action"
        aria-label={`Delete ${kind} message: ${text}`}
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

const changesText = (changes: number) => (changes === 1 ? "1 change" : `${changes} changes`);

/** What was written offline: each message, to edit or delete before it goes, and how many other changes wait. */
function WaitingGroup({ items, changes, onEdit, onDelete }: { items: readonly Outgoing[]; changes: number } & QueueActions) {
  return (
    <>
      <div className="queue-head">
        <p className="queue-note">{items.length > 0 ? `Waiting for connection · ${items.length}` : "Waiting for connection"}</p>
      </div>
      {items.length > 0 ? (
        <ul className="queue-list" aria-label="Waiting to send">
          {items.map((item) => (
            <QueueRow key={item.operationId} item={item} connected={false} waiting onEdit={onEdit} onDelete={onDelete} />
          ))}
        </ul>
      ) : null}
      {changes > 0 ? (
        <p className="queue-more">
          {changesText(changes)} {items.length > 0 ? (changes === 1 ? "waits too" : "wait too") : changes === 1 ? "waits" : "wait"}
        </p>
      ) : null}
    </>
  );
}

/**
 * Messages sent while ky works, waiting to go in at its next step. Each can be
 * taken back to edit in the composer, or deleted. One pi places first goes in
 * anyway, and leaves the queue as it shows in the thread. Above them, what was
 * written offline waits for the connection, and goes once ky is back.
 */
export function QueueTray({
  items,
  waiting = [],
  changes = 0,
  more,
  connected,
  running,
  onSteer,
  onEdit,
  onDelete,
}: {
  items: readonly Outgoing[];
  /** Written offline, never sent: waiting for the connection. */
  waiting?: readonly Outgoing[];
  /** Other changes made offline, waiting for the connection. */
  changes?: number;
  /** Queued from elsewhere, like another device, so this page has no words for them. */
  more: number;
  connected: boolean;
  running: boolean;
  onSteer: () => void;
} & QueueActions) {
  const queued = items.length > 0 || more > 0;
  const offline = waiting.length > 0 || changes > 0;

  if (!queued && !offline) return null;

  return (
    <section className="queue" aria-label={queued ? "Queued messages" : "Waiting messages"}>
      {offline ? <WaitingGroup items={waiting} changes={changes} onEdit={onEdit} onDelete={onDelete} /> : null}
      {queued ? (
        <>
          <QueueHead queued={items.length + more} connected={connected} running={running} onSteer={onSteer} />
          <ul className="queue-list">
            {items.map((item) => (
              <QueueRow key={item.operationId} item={item} connected={connected} onEdit={onEdit} onDelete={onDelete} />
            ))}
          </ul>
          {more > 0 ? <p className="queue-more">{more === 1 ? "1 more" : `${more} more`} queued from elsewhere</p> : null}
        </>
      ) : null}
    </section>
  );
}
