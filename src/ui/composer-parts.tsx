import type { ComposerVoice } from "../chat-kit/Composer";
import { Icon } from "../chat-kit/Icon";
import { BotAvatar } from "./BotAvatar";
import { clock, mediaKind } from "../files/media";
import type { PendingClip } from "./pick-media";
import { imageSrc, type PendingImage } from "./pick-images";
import type { Recorder } from "./use-recorder";
import { NAME } from "./open-chat";

/** ky's side of the composer: what waits to be sent, the recording in the text's place, and who a mention is. */

/** What the composer takes: images, and the audio and video ky can play. */
export const attachable = (file: File) => file.type.startsWith("image/") || mediaKind(file.type) !== null;

/** A specialist in the @ menu: its avatar, still. */
export const mentionAvatar = (id: string) => <BotAvatar name={`@${id}`} identity={id} owner={id} still size={24} />;

/** The microphone as the composer draws it: the recorder's strip in the text's place while it records. */
export function composerVoice(recorder: Recorder, actions: { onRecord: () => void; onDone: (send: boolean) => void; onCancel: () => void }): ComposerVoice {
  return {
    recording: recorder.state === "idle" ? null : <RecordingStrip recorder={recorder} onCancel={actions.onCancel} />,
    ready: recorder.state === "recording",
    onRecord: actions.onRecord,
    onDone: actions.onDone
  };
}

/** What waits to go with the message, for the composer: none while nothing does. */
export function attachmentsOf(draft: { images: readonly PendingImage[]; clips: readonly PendingClip[]; removeImage: (id: string) => void; removeClip: (id: string) => void }) {
  if (draft.images.length === 0 && draft.clips.length === 0) return null;

  return <ComposerAttachments images={draft.images} clips={draft.clips} onRemoveImage={draft.removeImage} onRemoveClip={draft.removeClip} />;
}

/** The images and clips waiting to go with the message. */
function ComposerAttachments({
  images,
  clips,
  onRemoveImage,
  onRemoveClip
}: {
  images: readonly PendingImage[];
  clips: readonly PendingClip[];
  onRemoveImage: (id: string) => void;
  onRemoveClip: (id: string) => void;
}) {
  return (
    <>
      {images.length > 0 ? (
        <ul className="composer-images" aria-label="Images to send">
          {images.map((image) => (
            <li key={image.id}>
              <img src={imageSrc(image)} alt={image.name} />
              <button type="button" className="composer-image-remove" aria-label={`Remove ${image.name}`} onClick={() => onRemoveImage(image.id)}>
                <Icon name="x" size={10} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {clips.length > 0 ? (
        <ul className="composer-clips" aria-label="Clips to send">
          {clips.map((clip) => (
            <ClipChip key={clip.id} clip={clip} onRemove={() => onRemoveClip(clip.id)} />
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** A clip waiting to be sent: what it is, how long, and while it uploads, how far along; offline, that it goes up later. */
function ClipChip({ clip, onRemove }: { clip: PendingClip; onRemove: () => void }) {
  const waiting = clip.waiting === true;
  const uploading = clip.file === null && !waiting;

  return (
    <li className="composer-clip" data-kind={clip.kind} data-uploading={uploading || undefined} title={waiting ? `Offline · uploads when ${NAME} reconnects` : undefined}>
      <ClipPreview clip={clip} />
      <ClipLabel clip={clip} waiting={waiting} />
      {uploading ? <span className="composer-clip-progress" style={{ width: `${clip.progress * 100}%` }} role="progressbar" aria-label={`Uploading ${clip.name}`} aria-valuenow={Math.round(clip.progress * 100)} /> : null}
      <button type="button" className="composer-image-remove" aria-label={`Remove ${clip.name}`} onClick={onRemove}>
        <Icon name="x" size={10} />
      </button>
    </li>
  );
}

/** A video's first frame, or a voice note's sound as bars. */
function ClipPreview({ clip }: { clip: PendingClip }) {
  if (clip.kind === "video") return <video src={clip.preview} muted playsInline preload="metadata" aria-hidden />;

  return (
    <span className="composer-clip-wave" aria-hidden>
      {Array.from({ length: 20 }, (_, index) => (clip.peaks ?? "").charAt(index * 2) || "3").map((digit, index) => (
        <span key={index} style={{ height: `${Math.max(14, (Number(digit) + 1) * 10)}%` }} />
      ))}
    </span>
  );
}

/** A video reads as its length; a voice note as its name, then its length or that it uploads on reconnect. */
function ClipLabel({ clip, waiting }: { clip: PendingClip; waiting: boolean }) {
  const length = clip.seconds === null ? null : clock(clip.seconds);

  if (clip.kind !== "audio") {
    return (
      <span className="composer-clip-label">
        <span>{length ?? "Video"}</span>
      </span>
    );
  }

  return (
    <span className="composer-clip-label">
      <span>{clip.name}</span>
      {waiting ? <span className="quiet">Uploads on reconnect</span> : length === null ? null : <span className="quiet">{length}</span>}
    </span>
  );
}

/** While a voice note records: throw it away, how long it has gone, its sound as it comes, and the words heard. */
function RecordingStrip({ recorder, onCancel }: { recorder: Exclude<Recorder, { state: "idle" }>; onCancel: () => void }) {
  const live = recorder.state === "recording" ? recorder : null;

  return (
    <div className="recording-strip" role="status" aria-label={live ? `Recording, ${clock(live.seconds)}` : "Starting the microphone"}>
      <button type="button" className="composer-icon pressable" aria-label="Discard voice note" onClick={onCancel}>
        <Icon name="x" size={15} />
      </button>
      <span className="recording-dot" aria-hidden />
      <span className="recording-time">{clock(live === null ? 0 : live.seconds)}</span>
      <RecordingWave levels={live?.levels ?? []} />
      {/* Right to left, so the newest words stay in view; the words inside keep their own direction. */}
      <span className="recording-heard">
        <bdi>{live === null ? "Starting…" : live.heard || "Listening…"}</bdi>
      </span>
    </div>
  );
}

/** The microphone's sound as it comes, newest at the right. */
function RecordingWave({ levels }: { levels: readonly number[] }) {
  return (
    <span className="recording-wave" aria-hidden>
      {Array.from({ length: 28 }, (_, index) => (
        <span key={index} style={{ height: `${Math.max(10, (levels[index - (28 - levels.length)] ?? 0) * 100)}%` }} />
      ))}
    </span>
  );
}
