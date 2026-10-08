import type { ImageContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import type { Purpose, SettingsView } from "./settings";

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

/**
 * Why this input's shape is refused, or null when it is fine. Whether the
 * purpose's model reads images is Models.imageSupport's answer (models.ts).
 */
export function checkInput(input: UserInput): string | null {
  if (!Array.isArray(input)) return null;
  const images = imagesOf(input);

  if (input.length === 0 || input.length - images.length > 1) return "Send one text part at most, and something.";

  if (images.length > MAX_IMAGES) return `Attach at most ${MAX_IMAGES} images.`;

  for (const image of images) {
    if (!IMAGE_TYPES.has(image.mimeType)) return `Images must be JPEG, PNG, WebP or GIF, not ${image.mimeType}.`;

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return "An image is not valid base64.";
  }

  if (images.reduce((total, image) => total + image.data.length, 0) > MAX_IMAGE_CHARS) {
    return "These images are too large together. Attach fewer.";
  }

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
    const provider = settings.providers.find((each) => each.id === choice.provider);

    return provider ? { provider, model: provider.models.find((each) => each.modelId === choice.modelId) } : undefined;
  };

  let found = find(settings.purposes[purpose]);

  if (found && !found.provider.connected && purpose !== "fallback") found = find(settings.purposes.fallback);

  if (!found?.model || found.model.images) return null;

  return `${found.model.name} can't read images. Pick a model that can in Models, or send text only.`;
}
