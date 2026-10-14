import type { Outgoing } from "../outbox";
import type { PiSessionView } from "../view";
import { Composer, type Mentionable } from "./Composer";
import { NAME } from "./open-chat";
import { QueueTray } from "./QueueTray";
import type { Draft } from "./use-draft";
import { useKeyboardInset } from "./use-keyboard-inset";

/** The run's state under the thread: retrying. What is queued behind it shows in the queue. */
function RunNote({ retry }: Pick<PiSessionView, "retry">) {
  return retry ? <div className="composer-note">Retrying: {retry.error}</div> : null;
}

function ErrorNote({ error }: { error: string | null }) {
  return error ? (
    <div className="composer-note" data-tone="error" role="alert">
      {error}
    </div>
  ) : null;
}

function placeholder(running: boolean, talksToMain: boolean, group: boolean) {
  if (running) return "Steer the running turn";

  if (group) return "Message the group, or @ a specialist";

  return talksToMain ? `Message ${NAME}` : "Message this subagent directly";
}

// The composer and the notes above it. While a run is going, sending steers it.
export function ComposerDock({
  session,
  queue,
  draft,
  cantSee,
  connected,
  talksToMain,
  mentions = [],
  group = false,
  onSubmit,
  onStop,
  onEdit,
  onDelete,
}: {
  session: Pick<PiSessionView, "retry" | "queued" | "error" | "running">;
  /** This page's messages waiting behind the run. */
  queue: readonly Outgoing[];
  draft: Draft;
  /** Why the attached images can't go to this session's model, if they can't. */
  cantSee: string | null;
  connected: boolean;
  talksToMain: boolean;
  /** The specialists typing @ offers. */
  mentions?: readonly Mentionable[];
  /** Specialists are members of this chat. */
  group?: boolean;
  onSubmit: () => void;
  onStop: () => void;
  onEdit: (item: Outgoing) => Promise<void>;
  onDelete: (item: Outgoing) => Promise<void>;
}) {
  const dock = useKeyboardInset<HTMLDivElement>();

  return (
    <div ref={dock} className="composer-wrap">
      <QueueTray
        items={queue}
        more={Math.max(0, session.queued - queue.filter((item) => item.submission !== null).length)}
        connected={connected}
        onEdit={onEdit}
        onDelete={onDelete}
      />
      <RunNote retry={session.retry} />
      <ErrorNote error={session.error} />
      <ErrorNote error={cantSee ?? draft.imageError} />
      <Composer
        value={draft.prompt}
        onChange={draft.setPrompt}
        onSubmit={onSubmit}
        onStop={onStop}
        working={session.running}
        disabled={!connected}
        busy={draft.reading > 0 || cantSee !== null}
        images={draft.images}
        onAddImages={draft.addImages}
        onRemoveImage={draft.removeImage}
        label="Message"
        mentions={mentions}
        placeholder={placeholder(session.running, talksToMain, group)}
      />
    </div>
  );
}
