import type { ImageContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import type { Purpose, SettingsView } from "../settings";

export type MediaKind = "audio" | "video";

export type MediaClip = {
  readonly kind: MediaKind;
  readonly file: string;
  readonly type: string;
  readonly name: string;
  readonly seconds: number | null;
  readonly peaks: string | null;
  readonly transcript: string;
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

export const soundTypeOf: ReadonlyMap<string, string> = new Map([
  ["video/mp4", "audio/mp4"],
  ["video/webm", "audio/webm"]
]);

export const baseType = (type: string) => type.replace(/;.*$/s, "").trim().toLowerCase();

export const mediaKind = (type: string): MediaKind | null => {
  const base = baseType(type);

  return AUDIO_TYPES.has(base) ? "audio" : VIDEO_TYPES.has(base) ? "video" : null;
};

export const MAX_MEDIA_BYTES = 95 * 1024 * 1024;

export const MAX_CLIPS = 4;

export const FRAMES_PER_VIDEO = 3;

export const MAX_FRAME_CHARS = 300_000;

export const PEAK_BARS = 40;

const FILE = /^[0-9a-f]{32}$/;

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const unescape = (text: string) =>
  text.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

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

export const framesOf = (clips: readonly MediaClip[]) => clips.reduce((total, clip) => total + clip.frames, 0);

export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function spokenText(text: string): string {
  const { clips, text: rest } = readMedia(text);

  if (clips.length === 0) return text;
  const said = clips.map((clip) => clip.transcript || (clip.kind === "audio" ? "Voice note" : clip.name));

  return [...said, rest].filter((each) => each !== "").join(" ");
}

export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export const MAX_IMAGES = 4;

export const MAX_IMAGE_CHARS = 1_400_000;

export const MAX_IMAGE_SIDE = 1568;

export function imagesOf(input: UserInput): ImageContent[] {
  return Array.isArray(input) ? input.filter((part) => part.type === "image") : [];
}

export function checkInput(input: UserInput): string | null {
  if (!Array.isArray(input)) return Schema.is(Schema.String)(input) ? null : "Send text, or text and images.";
  const images = imagesOf(input);

  if (input.length === 0 || input.length - images.length > 1) return "Send one text part at most, and something.";
  const { clips } = readMedia(input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
  const frames = framesOf(clips);

  if (clips.length > MAX_CLIPS) return `Attach at most ${MAX_CLIPS} clips.`;

  if (frames > images.length || frames > MAX_CLIPS * FRAMES_PER_VIDEO) return "A video's frames don't match its tag.";

  if (images.length - frames > MAX_IMAGES) return `Attach at most ${MAX_IMAGES} images.`;

  for (const image of images) {
    if (!IMAGE_TYPES.has(image.mimeType)) return `Images must be JPEG, PNG, WebP or GIF, not ${image.mimeType}.`;

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return "An image is not valid base64.";
  }

  const chars = (some: readonly ImageContent[]) => some.reduce((total, image) => total + image.data.length, 0);

  if (chars(images.slice(0, images.length - frames)) > MAX_IMAGE_CHARS) {
    return "These images are too large together. Attach fewer.";
  }

  if (chars(images.slice(images.length - frames)) > MAX_FRAME_CHARS) return "These videos' frames are too large together.";

  return null;
}

export function imageSupport(settings: SettingsView, purpose: Purpose): string | null {
  const find = (choice: SettingsView["purposes"][Purpose]) => {
    if (!choice) return undefined;
    const provider = settings.providers.find((each) => each.id === choice.provider);

    return provider ? { provider, model: provider.models.find((each) => each.modelId === choice.modelId) } : undefined;
  };

  let found = find(settings.purposes[purpose]);

  if (found && !found.provider.connected && purpose !== "fallback") found = find(settings.purposes.fallback);

  if (!found?.model || found.model.images) return null;

  return `${found.model.name} can't read images. Pick a model that can in Models, or send text only.`;
}
