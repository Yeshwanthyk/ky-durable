/**
 * Audio and video in a chat. pi keeps a message in one SQLite row of at most 2 MB, and pi-ai's
 * user message holds only text and images, so a clip never travels inline: the page uploads it
 * to R2 first (PUT /api/media, src/files.ts) and the message carries a <ky-media> tag naming it.
 * The model reads the tag: what the clip is, how long, and for a voice note what was said, which
 * the device transcribed as it recorded. The page reads the same tag back and shows a player in
 * its place. A video's frames, which the browser grabs, ride as image parts after the user's own
 * images, so a model that reads images sees what the video shows; the tag counts them.
 *
 * Only typebox-free string work, so the page and the Worker both load it.
 */

export type MediaKind = "audio" | "video";

export type MediaClip = {
  readonly kind: MediaKind;
  /** The R2 file: /files/<id> serves it. */
  readonly file: string;
  readonly type: string;
  readonly name: string;
  /** Whole seconds, when the page could tell. */
  readonly seconds: number | null;
  /** A voice note's loudness over its length, one digit 0–9 per bar, for its waveform. */
  readonly peaks: string | null;
  /** What was said, as the device heard it; empty when nothing was. */
  readonly transcript: string;
  /** How many image parts are this video's frames. */
  readonly frames: number;
};

const AUDIO_TYPES: ReadonlySet<string> = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/x-m4a",
  "audio/flac"
]);

const VIDEO_TYPES: ReadonlySet<string> = new Set(["video/mp4", "video/webm", "video/quicktime"]);

/** The audio type a video type's file takes when it holds no picture, as a sound saved as .mp4 or .webm does. */
export const soundTypeOf: ReadonlyMap<string, string> = new Map([
  ["video/mp4", "audio/mp4"],
  ["video/webm", "audio/webm"]
]);

/** A clip's type without its parameters: MediaRecorder says "audio/webm;codecs=opus". */
export const baseType = (type: string) => type.replace(/;.*$/s, "").trim().toLowerCase();

export const mediaKind = (type: string): MediaKind | null => {
  const base = baseType(type);

  return AUDIO_TYPES.has(base) ? "audio" : VIDEO_TYPES.has(base) ? "video" : null;
};

/** One request's body: under the Workers limit of 100 MB, with room for the headers. */
export const MAX_MEDIA_BYTES = 95 * 1024 * 1024;

/** Clips in one message. */
export const MAX_CLIPS = 4;

/** Frames grabbed from each video. */
export const FRAMES_PER_VIDEO = 3;

/** Base64 characters of all of a message's video frames, beside MAX_IMAGE_CHARS for the user's images. */
export const MAX_FRAME_CHARS = 300_000;

/** Bars in a voice note's waveform. */
export const PEAK_BARS = 40;

const FILE = /^[0-9a-f]{32}$/;

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const unescape = (text: string) =>
  text.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

/** The tag a message carries for a clip; the model reads it, so a voice note with no words says so. */
export function mediaTag(clip: MediaClip): string {
  const attributes = [
    `kind="${clip.kind}"`,
    `file="${clip.file}"`,
    `type="${escape(clip.type)}"`,
    `name="${escape(clip.name)}"`,
    clip.seconds === null ? null : `seconds="${clip.seconds}"`,
    clip.peaks === null ? null : `peaks="${clip.peaks}"`,
    clip.frames > 0 ? `frames="${clip.frames}"` : null
  ].filter((each) => each !== null);

  const body =
    clip.transcript !== ""
      ? escape(clip.transcript)
      : clip.kind === "audio"
        ? "(no transcript: the device heard no words)"
        : clip.frames > 0
          ? "(no transcript; its frames follow as images)"
          : "(no transcript)";

  return `<ky-media ${attributes.join(" ")}>${body}</ky-media>`;
}

const TAG = /<ky-media((?:\s+[a-z]+="[^"]*")*)\s*>([\s\S]*?)<\/ky-media>\n?/g;

const ATTRIBUTE = /([a-z]+)="([^"]*)"/g;

/** The clips a message's text names, and the text without their tags; a tag that doesn't read stays as text. */
export function readMedia(text: string) {
  const clips: MediaClip[] = [];

  const rest = text.replace(TAG, (whole: string, attributes: string, body: string) => {
    const read = new Map([...attributes.matchAll(ATTRIBUTE)].map(([, key = "", value = ""]) => [key, unescape(value)]));
    const kind = read.get("kind");
    const file = read.get("file") ?? "";
    const type = read.get("type") ?? "";
    const seconds = Number(read.get("seconds"));
    const peaks = read.get("peaks") ?? "";
    const frames = Number(read.get("frames") ?? 0);

    if ((kind !== "audio" && kind !== "video") || !FILE.test(file) || mediaKind(type) !== kind) return whole;
    const said = unescape(body);

    clips.push({
      kind,
      file,
      type,
      name: read.get("name") ?? (kind === "audio" ? "Voice note" : "Video"),
      seconds: read.has("seconds") && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null,
      peaks: /^[0-9]{1,200}$/.test(peaks) ? peaks : null,
      transcript: said.startsWith("(no transcript") ? "" : said,
      frames: Number.isInteger(frames) && frames >= 0 && frames <= FRAMES_PER_VIDEO ? frames : 0
    });

    return "";
  });

  return { clips, text: clips.length === 0 ? text : rest.trim() };
}

/** All a message's video frames: they come last among its images. */
export const framesOf = (clips: readonly MediaClip[]) => clips.reduce((total, clip) => total + clip.frames, 0);

/** m:ss */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A message's text for a title or a preview: each clip as what was said in it, or what it is. */
export function spokenText(text: string): string {
  const { clips, text: rest } = readMedia(text);

  if (clips.length === 0) return text;
  const said = clips.map((clip) => clip.transcript || (clip.kind === "audio" ? "Voice note" : clip.name));

  return [...said, rest].filter((each) => each !== "").join(" ");
}
