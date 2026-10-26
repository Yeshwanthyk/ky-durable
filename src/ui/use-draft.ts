import type { ImageContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import { useEffect, useRef, useState } from "react";
import { framesOf, imagesOf, MAX_CLIPS, MAX_IMAGES, mediaKind, mediaTag, readMedia } from "../files/media";
import { outgoingText } from "../outbox";
import { clipOf, type PendingClip, prepareClip, recordedClip, uploadClip } from "./pick-media";
import { prepareImage, type PendingImage } from "./pick-images";
import type { Recording } from "./use-recorder";

export type Draft = {
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;
  readonly images: readonly PendingImage[];
  /** Voice notes and videos to send, each uploading until it has a file. */
  readonly clips: readonly PendingClip[];
  /** Images and clips still being read, shrunk or uploaded. */
  readonly reading: number;
  readonly imageError: string | null;
  /** Images, audio and video, each read as its kind. */
  readonly addFiles: (files: File[]) => void;
  readonly addRecording: (recording: Recording) => void;
  readonly removeImage: (id: string) => void;
  readonly removeClip: (id: string) => void;
  readonly setError: (message: string | null) => void;
  /** Empties the composer and hands back what it held, or null if it held nothing. Frames go only to a model that reads images. */
  readonly take: (seesImages: boolean) => UserInput | null;
  /** Puts a message taken back from the queue into the composer, ahead of anything typed since. */
  readonly restore: (input: UserInput) => void;
  /** Puts a suggested ask in the composer: alone when it is empty, else ahead of what is there. */
  readonly pick: (text: string) => void;
};

/** The words, then a tag per clip (after the words, so a leading @specialist still leads); images first, then video frames. */
function input(text: string, images: readonly PendingImage[], clips: readonly PendingClip[], seesImages: boolean): UserInput {
  const tags = clips.flatMap((pending) => {
    const clip = clipOf(pending, seesImages);

    return clip ? [mediaTag(clip)] : [];
  });

  const words = [text, ...tags].filter((each) => each !== "").join("\n\n");
  const frames = seesImages ? clips.flatMap((clip) => clip.frames) : [];

  if (images.length === 0 && frames.length === 0) return words;

  return [
    ...images.map(({ type, data, mimeType }) => ({ type, data, mimeType })),
    ...frames.map(({ type, data, mimeType }) => ({ type, data, mimeType })),
    ...(words ? [{ type: "text" as const, text: words }] : [])
  ];
}

// What the composer holds before it is sent: the text, the images and the clips attached to it.
export function useDraft(): Draft {
  const [prompt, setText] = useState("");
  const [images, setImages] = useState<readonly PendingImage[]>([]);
  const [clips, setClips] = useState<readonly PendingClip[]>([]);
  const [reading, setReading] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  // Local previews, let go when their clip leaves the composer.
  const previews = useRef(new Set<string>());

  const forget = (clip: PendingClip) => {
    if (previews.current.delete(clip.preview)) URL.revokeObjectURL(clip.preview);
  };

  useEffect(() => () => previews.current.forEach((preview) => URL.revokeObjectURL(preview)), []);

  const update = (id: string, change: Partial<PendingClip>) => setClips((current) => current.map((clip) => (clip.id === id ? { ...clip, ...change } : clip)));

  /** Read on the device, then upload; a clip that fails leaves the composer, saying why. */
  const addClip = (read: Promise<{ clip: PendingClip; body: Blob }>) => {
    setReading((count) => count + 1);
    read
      .then(async ({ clip, body }) => {
        previews.current.add(clip.preview);
        setClips((current) => [...current, clip]);

        try {
          const file = await uploadClip(body, clip.type, (progress) => update(clip.id, { progress }));
          update(clip.id, { file, progress: 1 });
        } catch (error) {
          setClips((current) => current.filter((each) => each.id !== clip.id));
          forget(clip);
          throw error;
        }
      })
      // The readers and the upload reject only with Errors.
      .catch((error: Error) => setImageError(error.message))
      .finally(() => setReading((count) => count - 1));
  };

  const addFiles = (files: File[]) => {
    const pictures = files.filter((file) => file.type.startsWith("image/"));
    const sounds = files.filter((file) => mediaKind(file.type) !== null);
    const room = MAX_IMAGES - images.length;
    const clipRoom = MAX_CLIPS - clips.length;

    setImageError(
      pictures.length > room ? `Attach at most ${MAX_IMAGES} images.` : sounds.length > clipRoom ? `Attach at most ${MAX_CLIPS} clips.` : files.length > pictures.length + sounds.length ? "Attach images, audio or video." : null
    );

    for (const file of pictures.slice(0, Math.max(0, room))) {
      setReading((count) => count + 1);
      prepareImage(file)
        .then((image) => setImages((current) => [...current, image]))
        // prepareImage rejects only with Errors.
        .catch((error: Error) => setImageError(error.message))
        .finally(() => setReading((count) => count - 1));
    }

    for (const file of sounds.slice(0, Math.max(0, clipRoom))) addClip(prepareClip(file).then((clip) => ({ clip, body: file })));
  };

  const addRecording = (recording: Recording) => {
    if (clips.length >= MAX_CLIPS) {
      setImageError(`Attach at most ${MAX_CLIPS} clips.`);

      return;
    }

    addClip(Promise.resolve({ clip: recordedClip(recording), body: recording.blob }));
  };

  const ahead = (text: string) => setText((current) => (current.trim() ? `${text}\n\n${current}` : text));

  const removeImage = (id: string) => {
    setImages((current) => current.filter((image) => image.id !== id));
    setImageError(null);
  };

  const removeClip = (id: string) => {
    const gone = clips.find((clip) => clip.id === id);

    if (gone) forget(gone);
    setClips((current) => current.filter((clip) => clip.id !== id));
    setImageError(null);
  };

  const take = (seesImages: boolean) => {
    const text = prompt.trim();

    if (!text && images.length === 0 && clips.length === 0) return null;
    setText("");
    setImages([]);
    setClips([]);
    setImageError(null);

    // The thread plays a sent clip from its file; the local copy can go.
    for (const clip of clips) forget(clip);

    return input(text, images, clips, seesImages);
  };

  const restore = (back: UserInput) => {
    const { clips: named, text } = readMedia(outgoingText(back));
    const all = imagesOf(back);
    const frames: ImageContent[] = all.slice(all.length - framesOf(named));
    let next = 0;

    const returned = all.slice(0, all.length - frames.length).map((image, index) => ({ ...image, id: crypto.randomUUID(), name: `Image ${index + 1}` }));

    // A clip taken back went up already: it keeps its file and its frames.
    const clipsBack = named.map((clip): PendingClip => {
      const own = frames.slice(next, next + clip.frames);
      next += clip.frames;

      return { ...clip, id: crypto.randomUUID(), frames: own, preview: `/files/${clip.file}`, file: clip.file, progress: 1 };
    });

    ahead(text);
    setImages((current) => [...returned, ...current].slice(0, MAX_IMAGES));
    setClips((current) => [...clipsBack, ...current].slice(0, MAX_CLIPS));
  };

  return {
    prompt,
    setPrompt: setText,
    images,
    clips,
    reading,
    imageError,
    addFiles,
    addRecording,
    removeImage,
    removeClip,
    setError: setImageError,
    take,
    restore,
    pick: ahead
  };
}

// A new deploy is live: reload, unless that would throw away a draft.
export function useReloadOnDeploy(updated: boolean, draft: Draft) {
  const { prompt, images, clips } = draft;

  useEffect(() => {
    if (updated && prompt.trim() === "" && images.length === 0 && clips.length === 0) location.reload();
  }, [updated, prompt, images, clips]);
}
