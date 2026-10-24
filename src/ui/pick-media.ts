import type { ImageContent } from "@earendil-works/pi-ai";
import { FRAMES_PER_VIDEO, MAX_CLIPS, MAX_FRAME_CHARS, MAX_MEDIA_BYTES, type MediaClip, type MediaKind, baseType, mediaKind, soundTypeOf } from "../media";
import Type from "typebox";
import { parseOr } from "../core/decode";
import { peaksFrom } from "./Media";
import { base64 } from "./pick-images";
import type { Recording } from "./use-recorder";

/**
 * A clip in the composer, from the time it is attached until it is sent: read on the device (its length,
 * a voice note's waveform, a video's frames), then uploaded, so the message only names it.
 */
export type PendingClip = {
  readonly id: string;
  readonly kind: MediaKind;
  readonly name: string;
  readonly type: string;
  readonly seconds: number | null;
  readonly peaks: string | null;
  readonly transcript: string;
  /** A video's frames, small JPEGs, for a model that reads images. */
  readonly frames: readonly ImageContent[];
  /** Plays the clip in the composer before it is sent: the local bytes, or once sent, its file. */
  readonly preview: string;
  /** The uploaded file's id; null while it uploads. */
  readonly file: string | null;
  /** How much has gone up, 0–1. */
  readonly progress: number;
};

/** Longest side of a video frame: the model gets the gist, and a message's frames fit MAX_FRAME_CHARS. */
const FRAME_SIDE = 512;

/** Base64 characters each frame may take. */
const FRAME_CHARS = Math.floor(MAX_FRAME_CHARS / (MAX_CLIPS * FRAMES_PER_VIDEO));

/** The clip's tag fields, once it has gone up. */
export const clipOf = (pending: PendingClip, withFrames: boolean): MediaClip | null =>
  pending.file === null
    ? null
    : {
        kind: pending.kind,
        file: pending.file,
        type: pending.type,
        name: pending.name,
        seconds: pending.seconds,
        peaks: pending.peaks,
        transcript: pending.transcript,
        frames: withFrames ? pending.frames.length : 0
      };

const loaded = <Element extends HTMLMediaElement>(element: Element, src: string) =>
  new Promise<Element>((resolve, reject) => {
    element.preload = "metadata";
    element.muted = true;
    element.onloadeddata = () => resolve(element);
    element.onerror = () => reject(new Error("This browser can't play that clip."));
    element.src = src;
  });

const seeked = (video: HTMLVideoElement, time: number) =>
  new Promise<void>((resolve) => {
    video.onseeked = () => resolve();
    video.currentTime = time;
  });

async function frame(video: HTMLVideoElement): Promise<ImageContent | null> {
  const scale = Math.min(1, FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);

  for (const quality of [0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    const data = blob ? await base64(blob) : "";

    if (data && data.length <= FRAME_CHARS) return { type: "image", mimeType: "image/jpeg", data };
  }

  return null;
}

/**
 * A video's length and FRAMES_PER_VIDEO frames across it; none when the browser can't decode it. `picture`
 * is false when it decodes and has none, as a sound saved as .mp4 or .webm.
 */
async function readVideo(src: string): Promise<{ seconds: number | null; frames: ImageContent[]; picture: boolean }> {
  try {
    const video = await loaded(document.createElement("video"), src);
    video.playsInline = true;
    const length = Number.isFinite(video.duration) ? video.duration : 0;
    const frames: ImageContent[] = [];

    for (let index = 0; index < FRAMES_PER_VIDEO && video.videoWidth > 0; index++) {
      if (length > 0) await seeked(video, (length * (index + 0.5)) / FRAMES_PER_VIDEO);
      const grabbed = await frame(video);

      if (grabbed) frames.push(grabbed);

      if (length === 0) break;
    }

    return { seconds: length > 0 ? Math.round(length) : null, frames, picture: video.videoWidth > 0 };
  } catch {
    return { seconds: null, frames: [], picture: true };
  }
}

/** A sound file's length and waveform, decoded on the device; nulls when it can't be. */
async function readAudio(file: Blob): Promise<{ seconds: number | null; peaks: string | null }> {
  const context = new AudioContext();

  try {
    const audio = await context.decodeAudioData(await file.arrayBuffer());

    return { seconds: Math.round(audio.duration), peaks: peaksFrom(audio.getChannelData(0)) };
  } catch {
    return { seconds: null, peaks: null };
  } finally {
    void context.close();
  }
}

/** A picked, pasted or dropped audio or video file, read and ready to upload. */
export async function prepareClip(file: File): Promise<PendingClip> {
  const type = baseType(file.type);
  const kind = mediaKind(type);

  if (kind === null) throw new Error(`${file.name || "That file"} isn't a clip ky takes: send audio or video.`);

  if (file.size > MAX_MEDIA_BYTES) throw new Error(`${file.name || "That clip"} is over ${MAX_MEDIA_BYTES / 1024 / 1024} MB.`);
  const preview = URL.createObjectURL(file);
  const video = kind === "video" ? await readVideo(preview) : undefined;
  const sound = video?.picture === false ? soundTypeOf.get(type) : undefined;

  if (video && !sound) {
    return { id: crypto.randomUUID(), kind, name: file.name || "Video", type, transcript: "", preview, file: null, progress: 0, peaks: null, seconds: video.seconds, frames: video.frames };
  }

  // A sound, or a video that holds only sound: it goes as a voice note, with its waveform.
  return { id: crypto.randomUUID(), kind: "audio", name: file.name || "Audio", type: sound ?? type, transcript: "", preview, file: null, progress: 0, frames: [], ...(await readAudio(file)) };
}

/** A note just recorded, ready to upload. */
export function recordedClip(recording: Recording): PendingClip {
  return {
    id: crypto.randomUUID(),
    kind: "audio",
    name: "Voice note",
    type: baseType(recording.type),
    seconds: recording.seconds,
    peaks: recording.peaks,
    transcript: recording.transcript,
    frames: [],
    preview: URL.createObjectURL(recording.blob),
    file: null,
    progress: 0
  };
}

/** What PUT /api/media answers with. */
const Uploaded = Type.Object({ id: Type.String({ pattern: "^[0-9a-f]{32}$" }) });

/** PUT /api/media, reporting how much has gone up; resolves with the file's id. */
export function uploadClip(body: Blob, type: string, onProgress: (done: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", "/api/media");
    request.setRequestHeader("Content-Type", type);
    request.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
    request.onerror = () => reject(new Error("The clip didn't upload: check the connection and attach it again."));

    request.onload = () => {
      const uploaded = request.status === 200 ? parseOr(Uploaded, request.responseText, null) : null;

      if (uploaded) resolve(uploaded.id);
      else reject(new Error(request.responseText.trim() || `The clip didn't upload (${request.status}).`));
    };

    request.send(body);
  });
}
