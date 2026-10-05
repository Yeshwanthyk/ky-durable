import type { UserInput } from "@earendil-works/pi-durable";
import { useEffect, useState } from "react";
import { MAX_IMAGES } from "../images";
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
  const [prompt, setPrompt] = useState("");
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

  const removeImage = (id: string) => {
    setImages((current) => current.filter((image) => image.id !== id));
    setImageError(null);
  };

  const take = () => {
    const text = prompt.trim();

    if (!text && images.length === 0) return null;
    setPrompt("");
    setImages([]);
    setImageError(null);

    return input(text, images);
  };

  return { prompt, setPrompt, images, reading, imageError, addImages, removeImage, take };
}

// A new deploy is live: reload, unless that would throw away a draft.
export function useReloadOnDeploy(updated: boolean, draft: Draft) {
  const { prompt, images } = draft;

  useEffect(() => {
    if (updated && prompt.trim() === "" && images.length === 0) location.reload();
  }, [updated, prompt, images]);
}
