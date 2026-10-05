import type { PiSessionView } from "../view";
import { Composer } from "./Composer";
import type { Draft } from "./use-draft";

/** The run's state under the thread: retrying, or how much is queued behind it. */
function RunNote({ retry, queued }: Pick<PiSessionView, "retry" | "queued">) {
  if (retry) return <div className="composer-note">Retrying: {retry.error}</div>;

  return queued > 0 ? <div className="composer-note">{queued} queued behind this run</div> : null;
}

function ErrorNote({ error }: { error: string | null }) {
  return error ? (
    <div className="composer-note" data-tone="error" role="alert">
      {error}
    </div>
  ) : null;
}

function placeholder(running: boolean, talksToMain: boolean, name: string) {
  if (running) return "Steer the running turn";

  return talksToMain ? `Message ${name}` : "Message this subagent directly";
}

// The composer and the notes above it. While a run is going, sending steers it.
export function ComposerDock({
  view,
  draft,
  cantSee,
  connected,
  talksToMain,
  name,
  onSubmit,
  onStop,
}: {
  view: Pick<PiSessionView, "retry" | "queued" | "error" | "running">;
  draft: Draft;
  /** Why the attached images can't go to this session's model, if they can't. */
  cantSee: string | null;
  connected: boolean;
  talksToMain: boolean;
  name: string;
  onSubmit: () => void;
  onStop: () => void;
}) {
  return (
    <div className="composer-wrap">
      <RunNote retry={view.retry} queued={view.queued} />
      <ErrorNote error={view.error} />
      <ErrorNote error={cantSee ?? draft.imageError} />
      <Composer
        value={draft.prompt}
        onChange={draft.setPrompt}
        onSubmit={onSubmit}
        onStop={onStop}
        working={view.running}
        disabled={!connected}
        busy={draft.reading > 0 || cantSee !== null}
        images={draft.images}
        onAddImages={draft.addImages}
        onRemoveImage={draft.removeImage}
        label="Message"
        placeholder={placeholder(view.running, talksToMain, name)}
      />
    </div>
  );
}
