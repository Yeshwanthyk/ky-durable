import type { UserInput } from "@earendil-works/pi-durable";
import { useEffect, useState } from "react";
import { imagesOf, MAX_IMAGES } from "../images";
import { outgoingText } from "../outbox";
import { prepareImage, type PendingImage } from "./pick-images";

export type Draft = {
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;
  readonly images: readonly PendingImage[];
  /** Images still being read and shrunk. */
  readonly reading: number;
  readonly imageError: string | null;
  readonly addImages: (files: File[]) => void;
  readonly removeImage: (id: string) => void;
  /** Empties the composer and hands back what it held, or null if it held nothing. */
  readonly take: () => UserInput | null;
  /** Puts a message taken back from the queue into the composer, ahead of anything typed since. */
  readonly restore: (input: UserInput) => void;
  /** Puts a suggested ask in the composer: alone when it is empty, else ahead of what is there. `key` names where it came from. */
  readonly pick: (text: string, key?: string) => void;
  /** The keys of the asks picked into this draft since it was last sent or emptied (a brief line's, say). */
  readonly picked: readonly string[];
};

/** Plain text, or the images followed by the text. */
function input(text: string, images: readonly PendingImage[]): UserInput {
  if (images.length === 0) return text;

  return [
    ...images.map(({ type, data, mimeType }) => ({ type, data, mimeType })),
    ...(text ? [{ type: "text" as const, text }] : [])
  ];
}

// What the composer holds before it is sent: the text and the images attached to it.
export function useDraft(): Draft {
  const [prompt, setText] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [images, setImages] = useState<readonly PendingImage[]>([]);
  const [reading, setReading] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);

  const addImages = (files: File[]) => {
    const room = MAX_IMAGES - images.length - reading;

    setImageError(files.length > room ? `Attach at most ${MAX_IMAGES} images.` : null);

    for (const file of files.slice(0, Math.max(0, room))) {
      setReading((count) => count + 1);
      prepareImage(file)
        .then((image) => setImages((current) => [...current, image]))
        // prepareImage rejects only with Errors.
        .catch((error: Error) => setImageError(error.message))
        .finally(() => setReading((count) => count - 1));
    }
  };

  // Emptying the composer lets go of what was picked into it.
  const setPrompt = (next: string) => {
    setText(next);

    if (next.trim() === "") setPicked([]);
  };

  const ahead = (text: string) => setText((current) => (current.trim() ? `${text}\n\n${current}` : text));

  const pick = (text: string, key?: string) => {
    ahead(text);

    if (key !== undefined) setPicked((current) => (current.includes(key) ? current : [...current, key]));
  };

  const removeImage = (id: string) => {
    setImages((current) => current.filter((image) => image.id !== id));
    setImageError(null);
  };

  const take = () => {
    const text = prompt.trim();

    if (!text && images.length === 0) return null;
    setText("");
    setPicked([]);
    setImages([]);
    setImageError(null);

    return input(text, images);
  };

  const restore = (back: UserInput) => {
    const text = outgoingText(back);
    const returned = imagesOf(back).map((image, index) => ({ ...image, id: crypto.randomUUID(), name: `Image ${index + 1}` }));
    ahead(text);
    setImages((current) => [...returned, ...current].slice(0, MAX_IMAGES));
  };

  return { prompt, setPrompt, images, reading, imageError, addImages, removeImage, take, restore, pick, picked };
}

// A new deploy is live: reload, unless that would throw away a draft.
export function useReloadOnDeploy(updated: boolean, draft: Draft) {
  const { prompt, images } = draft;

  useEffect(() => {
    if (updated && prompt.trim() === "" && images.length === 0) location.reload();
  }, [updated, prompt, images]);
}
