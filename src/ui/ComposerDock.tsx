import type { Outgoing } from "../outbox";
import type { PiSessionView } from "../view";
import { useEffect, useState } from "react";
import { Composer, type Mentionable, type Voice } from "./Composer";
import { NAME } from "./open-chat";
import { QueueTray } from "./QueueTray";
import type { Draft } from "./use-draft";
import { useKeyboardInset } from "./use-keyboard-inset";
import { useRecorder } from "./use-recorder";

/** The microphone, recording into the draft. Send while recording sends the note once it has gone up. */
function useVoice(draft: Draft, onSubmit: () => void): Voice {
  const { recorder, start, stop, cancel } = useRecorder({ onError: draft.setError });
  const [sendWhenReady, setSendWhenReady] = useState(false);
  // A clip waiting offline goes up with the message, so it doesn't hold the send.
  const ready = draft.reading === 0 && draft.clips.every((clip) => clip.file !== null || clip.waiting === true);

  useEffect(() => {
    if (!sendWhenReady || !ready) return;
    setSendWhenReady(false);
    onSubmit();
  }, [sendWhenReady, ready, onSubmit]);

  return {
    recorder,
    onRecord: () => {
      draft.setError(null);
      void start();
    },
    onDone: (send) => {
      void stop().then((recording) => {
        if (recording === null) return;
        draft.addRecording(recording);

        if (send) setSendWhenReady(true);
      });
    },
    onCancel: cancel
  };
}

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

function placeholder(running: boolean, connected: boolean, talksToMain: boolean, group: boolean) {
  if (!connected) return "Offline · sends on reconnect";

  if (running) return "Steer the running turn";

  if (group) return "Message the group, or @ a specialist";

  return talksToMain ? `Message ${NAME}` : "Message this subagent directly";
}

// The composer and the notes above it. While a run is going, sending steers it.
export function ComposerDock({
  session,
  queue,
  waiting = [],
  changes = 0,
  draft,
  cantSee,
  connected,
  talksToMain,
  mentions = [],
  group = false,
  history,
  onSubmit,
  onStop,
  onSteer,
  onEdit,
  onDelete,
}: {
  session: Pick<PiSessionView, "retry" | "queued" | "error" | "running">;
  /** This page's messages waiting behind the run. */
  queue: readonly Outgoing[];
  /** Messages written offline, waiting for the connection. */
  waiting?: readonly Outgoing[];
  /** Changes made offline, waiting for the connection. */
  changes?: number;
  draft: Draft;
  /** Why the attached images can't go to this session's model, if they can't. */
  cantSee: string | null;
  connected: boolean;
  talksToMain: boolean;
  /** The specialists typing @ offers. */
  mentions?: readonly Mentionable[];
  /** Specialists are members of this chat. */
  group?: boolean;
  /** What the user sent in this chat, oldest first, for ↑ to bring back. */
  history?: readonly string[];
  onSubmit: () => void;
  onStop: () => void;
  /** Stop the step ky is on, so the queue goes in now. */
  onSteer: () => void;
  onEdit: (item: Outgoing) => Promise<void>;
  onDelete: (item: Outgoing) => Promise<void>;
}) {
  const dock = useKeyboardInset<HTMLDivElement>();
  const voice = useVoice(draft, onSubmit);

  return (
    <div ref={dock} className="composer-wrap">
      <QueueTray
        items={queue}
        waiting={waiting}
        changes={changes}
        more={Math.max(0, session.queued - queue.filter((item) => item.submission !== null).length)}
        connected={connected}
        running={session.running}
        onSteer={onSteer}
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
        // Offline the composer still takes a message: it waits in the thread and goes when the socket opens.
        // Stop can't wait like that, so it isn't offered.
        onStop={connected ? onStop : undefined}
        working={session.running}
        busy={draft.reading > 0 || cantSee !== null}
        images={draft.images}
        clips={draft.clips}
        onAddFiles={draft.addFiles}
        onRemoveImage={draft.removeImage}
        onRemoveClip={draft.removeClip}
        voice={voice}
        label="Message"
        mentions={mentions}
        history={history}
        placeholder={placeholder(session.running, connected, talksToMain, group)}
      />
    </div>
  );
}
