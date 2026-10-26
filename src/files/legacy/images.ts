import type { ImageContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import Type from "typebox";
import { Value } from "typebox/value";
import { FRAMES_PER_VIDEO, framesOf, MAX_CLIPS, MAX_FRAME_CHARS, readMedia } from "./media";
import type { Purpose, SettingsView } from "../../settings";

/**
 * Images the user attaches travel inline, as pi-ai image parts in the user
 * message, and are stored with it. pi keeps a message in one SQLite row,
 * and a row holds at most 2 MB, so the browser shrinks each image and the
 * server refuses input over these limits.
 */

export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export const MAX_IMAGES = 4;

/** Base64 characters of all images in one message. */
export const MAX_IMAGE_CHARS = 1_400_000;

/** Longest side the browser scales an image down to; Claude scales anything longer down to this anyway. */
export const MAX_IMAGE_SIDE = 1568;

export function imagesOf(input: UserInput): ImageContent[] {
  return Array.isArray(input) ? input.filter((part) => part.type === "image") : [];
}

/** Plain text: a user message with no images. */
const TEXT = Type.String();

/**
 * Why this input's shape is refused, or null when it is fine. Whether the
 * purpose's model reads images is Models.imageSupport's answer (models.ts).
 */
export function checkInput(input: UserInput): string | null {
  // Plain text is fine; anything else that isn't parts got past the socket's schema, and is refused all the same.
  if (!Array.isArray(input)) return Value.Check(TEXT, input) ? null : "Send text, or text and images.";
  const images = imagesOf(input);

  if (input.length === 0 || input.length - images.length > 1) return "Send one text part at most, and something.";
  // A video's frames come after the user's own images (src/media.ts); the tags in the text count them.
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

/**
 * The browser's early warning, from the settings it was sent: why the
 * purpose's model cannot read images, or null when it can. A purpose whose
 * provider is offline runs on the fallback, so that model is checked, as
 * Models.imageSupport does on the server, which has the final say. A model
 * missing from the catalog is let through.
 */
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
